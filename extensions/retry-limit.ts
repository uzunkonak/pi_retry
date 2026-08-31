/**
 * Retry Limit
 *
 * Waits out provider rate limits instead of failing the run, then resumes the
 * interrupted work once the limit window reopens.
 *
 * Pi already retries transient errors, but that budget is small and bounded
 * (`retry.maxRetries`, 2s/4s/8s backoff), and a provider that asks for a delay
 * longer than `retry.provider.maxRetryDelayMs` fails immediately. This extension
 * picks up where that leaves off: when a run finally settles on a rate-limit
 * error, it works out when the window reopens — from response headers first,
 * then from the provider's error text — sleeps with a live countdown, and
 * restarts the agent.
 *
 * Commands: /retry-limit [status | cancel | now | on | off]
 * Flag:     --no-retry-limit
 * Config:   ~/.pi/agent/retry-limit.json, .pi/retry-limit.json, PI_RETRY_LIMIT_*
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type RetryLimitConfig, applyRecord, loadConfig } from "../src/config.ts";
import { type LimitKind, type ProviderResponse, classifyLimitError, resolveResetHint } from "../src/detect.ts";
import { formatClock, formatDuration, parseDuration } from "../src/duration.ts";
import { type WaitPlan, planWait } from "../src/plan.ts";
import { type ObserverCleanup, observeLimitResponses } from "../src/response-observer.ts";

/** Identifier used for the injected resume message and session entries. */
const CUSTOM_TYPE = "retry-limit";
const STATUS_KEY = "retry-limit";
const WIDGET_KEY = "retry-limit";

/** How long to give a resumed run to actually start before declaring it stuck. */
const RESUME_START_TIMEOUT_MS = 10_000;

interface PendingFailure {
	kind: LimitKind;
	matched: string;
	errorMessage: string;
}

interface ActiveWait {
	plan: WaitPlan;
	/** Ends the sleep early. `resume` keeps the retry, `abandon` drops it. */
	finish: (outcome: "resume" | "abandon") => void;
}

export default function (pi: ExtensionAPI) {
	let config: RetryLimitConfig = loadConfig(process.cwd()).config;
	let warnings: string[] = [];

	/** Last provider response, mined for reset headers when a run fails. */
	let lastResponse: ProviderResponse | undefined;
	/** The limit error the current run ended on, if any. */
	let pendingFailure: PendingFailure | undefined;
	/** Consecutive resume attempts since the last successful run. */
	let attempt = 0;

	/** Set while this extension is driving a wait/resume cycle. */
	let driving = false;
	/** Resolver for the `agent_settled` of a run we started ourselves. */
	let runWaiter: (() => void) | undefined;
	/** True once the resumed run has actually begun streaming. */
	let runStarted = false;
	/** True while a resumed run is in flight, gating context pruning. */
	let resuming = false;
	let activeWait: ActiveWait | undefined;
	let stopObserving: ObserverCleanup | undefined;

	pi.registerFlag("no-retry-limit", {
		description: "Disable automatic waiting for rate-limit windows to reset",
		type: "boolean",
		default: false,
	});

	// ---------------------------------------------------------------------
	// Signal collection
	// ---------------------------------------------------------------------

	pi.on("session_start", async (_event, ctx) => {
		const loaded = loadConfig(ctx.cwd);
		config = loaded.config;
		warnings = loaded.warnings;
		if (pi.getFlag("no-retry-limit") === true) config.enabled = false;

		lastResponse = undefined;
		pendingFailure = undefined;
		attempt = 0;

		syncObserver();

		if (config.notify && warnings.length > 0 && ctx.hasUI) {
			ctx.ui.notify(`retry-limit: ${warnings.join("; ")}`, "warning");
		}
	});

	// The sanctioned hook, for providers whose transport surfaces a response object
	// on failure. Most do not, which is why the fetch observer above exists too.
	pi.on("after_provider_response", (event) => {
		recordResponse({ status: event.status, headers: event.headers, at: Date.now() });
	});

	/** Keep the most recent limit-shaped response; both sources feed this slot. */
	function recordResponse(response: ProviderResponse): void {
		if (!lastResponse || response.at >= lastResponse.at) lastResponse = response;
	}

	/** Match the fetch observer to the current configuration. Safe to call repeatedly. */
	function syncObserver(): void {
		const wanted = config.enabled && config.observeResponses;
		if (wanted === (stopObserving !== undefined)) return;
		if (wanted) {
			stopObserving = observeLimitResponses(recordResponse);
		} else {
			stopObserving?.();
			stopObserving = undefined;
		}
	}

	pi.on("agent_start", () => {
		runStarted = true;
		pendingFailure = undefined;
	});

	pi.on("message_end", (event) => {
		if (event.message.role !== "assistant") return;
		const message = event.message;

		if (message.stopReason !== "error") {
			// A response got through, so any earlier failure in this run is stale.
			pendingFailure = undefined;
			return;
		}

		const errorMessage = message.errorMessage ?? "";
		const classification = classifyLimitError(errorMessage);
		pendingFailure = classification ? { ...classification, errorMessage } : undefined;
	});

	// A failed turn is left in the transcript for history, but replaying it to the
	// provider is at best noise and at worst a hard 400 (an assistant message with
	// empty content, or a tool call that never got a result). Pi drops it for its
	// own retries; do the same for ours.
	pi.on("context", (event) => {
		if (!resuming || !config.pruneErrorMessages) return;
		const messages = event.messages.filter(
			(message) => !(message.role === "assistant" && message.stopReason === "error"),
		);
		return messages.length === event.messages.length ? undefined : { messages };
	});

	// ---------------------------------------------------------------------
	// The wait/resume loop
	// ---------------------------------------------------------------------

	pi.on("agent_settled", async (_event, ctx) => {
		// A run we started has finished; hand control back to `drive()`.
		if (runWaiter) {
			const resolve = runWaiter;
			runWaiter = undefined;
			resolve();
			return;
		}
		if (!config.enabled || driving) return;

		driving = true;
		try {
			await drive(ctx);
		} finally {
			driving = false;
			clearIndicators(ctx);
		}
	});

	/**
	 * Blocking on purpose: `agent_settled` is awaited inside pi's prompt call, so
	 * holding here keeps `-p` runs and RPC callers alive for the whole wait
	 * instead of letting them exit on the rate-limit error.
	 */
	async function drive(ctx: ExtensionContext): Promise<void> {
		for (;;) {
			const failure = pendingFailure;
			if (!failure) {
				attempt = 0;
				return;
			}
			pendingFailure = undefined;

			if (failure.kind === "quota" && !config.retryOnQuotaExhausted) {
				report(
					ctx,
					`retry-limit: "${failure.matched}" looks like exhausted quota, not a resetting window — not retrying. Set retryOnQuotaExhausted to override.`,
					"warning",
				);
				attempt = 0;
				return;
			}

			if (config.maxAttempts > 0 && attempt >= config.maxAttempts) {
				report(ctx, `retry-limit: giving up after ${attempt} attempt(s).`, "error");
				attempt = 0;
				return;
			}

			attempt++;
			const now = Date.now();
			const hint = resolveResetHint(failure.errorMessage, lastResponse, now);
			const plan = planWait({ hint, now, attempt, config });

			report(
				ctx,
				`retry-limit: rate limited. Resuming in ${formatDuration(plan.waitMs)} at ${formatClock(plan.resumeAt)}${
					plan.blind ? " (no reset time from provider)" : ""
				}.`,
				"info",
			);

			const outcome = await sleepWithCountdown(ctx, plan, failure);
			if (outcome === "abandon") {
				report(ctx, "retry-limit: wait cancelled.", "info");
				attempt = 0;
				return;
			}

			clearIndicators(ctx);
			if (!(await resumeRun(ctx, plan))) {
				attempt = 0;
				return;
			}
			// If the resumed run hit the limit again, `message_end` refilled
			// pendingFailure and the next iteration waits again.
		}
	}

	/**
	 * Sleep until the window reopens, updating the footer status and an editor
	 * widget once a second. Escape cancels, as does `/retry-limit cancel`.
	 */
	function sleepWithCountdown(
		ctx: ExtensionContext,
		plan: WaitPlan,
		failure: PendingFailure,
	): Promise<"resume" | "abandon"> {
		return new Promise((resolve) => {
			let settled = false;
			let unsubscribe: (() => void) | undefined;

			const finish = (outcome: "resume" | "abandon") => {
				if (settled) return;
				settled = true;
				clearInterval(ticker);
				clearTimeout(timer);
				unsubscribe?.();
				activeWait = undefined;
				resolve(outcome);
			};

			const render = () => {
				const remaining = plan.resumeAt - Date.now();
				ctx.ui.setStatus(STATUS_KEY, `⏳ rate limit · ${formatDuration(remaining)}`);
				if (ctx.mode !== "tui") return;
				ctx.ui.setWidget(WIDGET_KEY, [
					`⏳ Rate limited (${failure.matched}) — attempt ${attempt}${
						config.maxAttempts > 0 ? `/${config.maxAttempts}` : ""
					}`,
					`   Resuming in ${formatDuration(remaining)} at ${formatClock(plan.resumeAt)} · via ${plan.source}${
						plan.capped ? " · capped by maxWaitMs" : ""
					}`,
					"   Esc or /retry-limit cancel to stop · /retry-limit now to resume immediately",
				]);
			};

			const timer = setTimeout(() => finish("resume"), Math.max(0, plan.resumeAt - Date.now()));
			const ticker = setInterval(render, 1_000);
			activeWait = { plan, finish };

			if (ctx.mode === "tui") {
				// A lone ESC; arrow keys and other escape sequences carry more bytes.
				unsubscribe = ctx.ui.onTerminalInput((data) => {
					if (data !== "\x1b") return undefined;
					finish("abandon");
					return { consume: true };
				});
			}
			render();
		});
	}

	/**
	 * Inject the resume message and wait for the run it triggers to settle.
	 * Returns false when the run could not be started at all.
	 */
	async function resumeRun(ctx: ExtensionContext, plan: WaitPlan): Promise<boolean> {
		runStarted = false;
		resuming = true;
		const settled = new Promise<void>((resolve) => {
			runWaiter = resolve;
		});

		try {
			pi.sendMessage(
				{
					customType: CUSTOM_TYPE,
					content: config.resumePrompt,
					display: config.showResumeMessage,
					details: { attempt, waitedMs: plan.waitMs, source: plan.source },
				},
				{ triggerTurn: true },
			);
		} catch (error) {
			runWaiter = undefined;
			resuming = false;
			report(ctx, `retry-limit: could not resume — ${errorText(error)}`, "error");
			return false;
		}

		try {
			const result = await Promise.race([settled.then(() => "settled" as const), watchRunStart()]);
			if (result === "not-started") {
				runWaiter = undefined;
				report(ctx, "retry-limit: resume did not start, stopping.", "error");
				return false;
			}
			return true;
		} finally {
			resuming = false;
		}
	}

	/**
	 * Resolves only if the resumed run never begins. Once streaming starts (or the
	 * run settles first) it stops watching and leaves the race to `settled`.
	 */
	function watchRunStart(): Promise<"not-started"> {
		return new Promise((resolve) => {
			const deadline = Date.now() + RESUME_START_TIMEOUT_MS;
			const poll = setInterval(() => {
				if (runStarted || runWaiter === undefined) {
					clearInterval(poll);
					return;
				}
				if (Date.now() >= deadline) {
					clearInterval(poll);
					resolve("not-started");
				}
			}, 250);
		});
	}

	// ---------------------------------------------------------------------
	// User controls
	// ---------------------------------------------------------------------

	// The user taking over supersedes a pending resume; otherwise both would run.
	pi.on("before_agent_start", () => {
		activeWait?.finish("abandon");
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		activeWait?.finish("abandon");
		stopObserving?.();
		stopObserving = undefined;
		clearIndicators(ctx);
	});

	const SUBCOMMANDS = [
		{ value: "status", label: "status", description: "Show configuration and current wait" },
		{ value: "cancel", label: "cancel", description: "Stop waiting and drop the pending retry" },
		{ value: "now", label: "now", description: "Skip the remaining wait and resume immediately" },
		{ value: "on", label: "on", description: "Enable automatic waiting for this session" },
		{ value: "off", label: "off", description: "Disable automatic waiting for this session" },
		{ value: "wait", label: "wait <duration>", description: "Override the fallback wait, e.g. wait 5m" },
	];

	pi.registerCommand(CUSTOM_TYPE, {
		description: "Inspect or control rate-limit waiting",
		getArgumentCompletions: (prefix) => {
			const items = SUBCOMMANDS.filter((item) => item.value.startsWith(prefix.trim()));
			return items.length > 0 ? items : null;
		},
		handler: async (args, ctx) => {
			const [subcommand = "status", ...rest] = args.trim().split(/\s+/).filter(Boolean);

			switch (subcommand) {
				case "cancel":
					if (!activeWait) {
						ctx.ui.notify("retry-limit: nothing to cancel.", "info");
						return;
					}
					activeWait.finish("abandon");
					return;

				case "now":
					if (!activeWait) {
						ctx.ui.notify("retry-limit: no wait in progress.", "info");
						return;
					}
					activeWait.finish("resume");
					ctx.ui.notify("retry-limit: resuming now.", "info");
					return;

				case "on":
				case "off": {
					config.enabled = subcommand === "on";
					if (!config.enabled) activeWait?.finish("abandon");
					syncObserver();
					ctx.ui.notify(`retry-limit: ${config.enabled ? "enabled" : "disabled"}.`, "info");
					return;
				}

				case "wait": {
					const parsed = parseDuration(rest.join(" "));
					if (parsed === undefined) {
						ctx.ui.notify("retry-limit: usage /retry-limit wait <duration>, e.g. 5m", "warning");
						return;
					}
					config.fallbackWaitMs = parsed;
					ctx.ui.notify(`retry-limit: fallback wait set to ${formatDuration(parsed)}.`, "info");
					return;
				}

				case "status":
					ctx.ui.notify(statusText(), "info");
					return;

				default: {
					// Anything else is treated as an inline config patch: /retry-limit maxAttempts 5
					const [key, ...value] = [subcommand, ...rest];
					const patchWarnings: string[] = [];
					applyRecord(config, { [key]: value.join(" ") }, "command", patchWarnings);
					syncObserver();
					ctx.ui.notify(
						patchWarnings.length > 0 ? `retry-limit: ${patchWarnings.join("; ")}` : statusText(),
						patchWarnings.length > 0 ? "warning" : "info",
					);
				}
			}
		},
	});

	function statusText(): string {
		const lines = [
			`retry-limit: ${config.enabled ? "on" : "off"}`,
			`attempts ${attempt}${config.maxAttempts > 0 ? `/${config.maxAttempts}` : " (unlimited)"}`,
			`fallback ${formatDuration(config.fallbackWaitMs)}`,
			`quota ${config.retryOnQuotaExhausted ? "retried" : "skipped"}`,
		];
		if (activeWait) lines.push(`waiting until ${formatClock(activeWait.plan.resumeAt)} via ${activeWait.plan.source}`);
		if (warnings.length > 0) lines.push(`warnings: ${warnings.join("; ")}`);
		return lines.join(" · ");
	}

	function report(ctx: ExtensionContext, message: string, level: "info" | "warning" | "error"): void {
		// Failures are always surfaced; `notify: false` only silences the chatter.
		if (level !== "error" && !config.notify) return;
		if (ctx.hasUI) ctx.ui.notify(message, level);
		// Print and JSON modes have no notifications, so leave a trace for scripts.
		else console.error(message);
	}

	function clearIndicators(ctx: ExtensionContext): void {
		ctx.ui.setStatus(STATUS_KEY, undefined);
		if (ctx.mode === "tui") ctx.ui.setWidget(WIDGET_KEY, undefined);
	}
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
