/**
 * How the wait is held, and what that means for the rest of pi.
 *
 * The interactive main loop is `await getUserInput()` -> `await session.prompt()`,
 * and it only accepts keyboard submissions while parked on the first half.
 * `agent_settled` is awaited inside the second half, so an extension that sleeps
 * there freezes the editor: `/retry-limit now`, `/retry-limit cancel`, and every
 * other command silently queue until the countdown ends. These tests pin the
 * behaviour that avoids that, and the blocking behaviour `-p` still needs.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import retryLimit from "../extensions/retry-limit.ts";
import { type Harness, createHarness, settle } from "./harness.ts";

/** A limit error whose reset is far enough out that a wait is observable. */
const LONG_LIMIT = "You have hit your ChatGPT usage limit (plus plan). Try again in ~30 min.";
/** A limit error short enough to actually sit through in a test. */
const SHORT_LIMIT = "Rate limit reached. Please try again in 1s.";

const QUIET = { PI_RETRY_LIMIT_NOTIFY: "false", PI_RETRY_LIMIT_MIN_WAIT: "1s" };

async function start(mode: "tui" | "print", env: Record<string, string> = {}): Promise<Harness> {
	const harness = createHarness({ mode, env: { ...QUIET, ...env } });
	retryLimit(harness.api);
	await harness.emit("session_start");
	return harness;
}

/**
 * Stand in for the run the injected resume message triggers: wait for the
 * message, then report that its run has settled, which is what releases the
 * blocking driver.
 */
async function completeResume(harness: Harness, timeoutMs = 5_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (harness.sent.length === 0) {
		if (Date.now() > deadline) throw new Error("the extension never injected a resume message");
		await settle(10);
	}
	await harness.emit("agent_settled");
}

test("in the TUI, agent_settled returns immediately so the editor stays live", async () => {
	const harness = await start("tui");
	try {
		await harness.fail(LONG_LIMIT);

		const started = Date.now();
		await harness.emit("agent_settled");
		const elapsed = Date.now() - started;

		assert.ok(elapsed < 500, `agent_settled blocked for ${elapsed}ms; the TUI would be frozen`);
		assert.equal(harness.sent.length, 0, "must not resume before the window reopens");
		assert.ok(harness.widget?.[0]?.includes("Rate limited"), "countdown widget should be showing");

		await harness.command("cancel");
	} finally {
		harness.dispose();
	}
});

test("/retry-limit now resumes during a wait instead of doing nothing", async () => {
	const harness = await start("tui");
	try {
		await harness.fail(LONG_LIMIT);
		await harness.emit("agent_settled");
		assert.equal(harness.sent.length, 0);

		await harness.command("now");
		await settle();

		assert.equal(harness.sent.length, 1, "expected the resume message to be injected");
		assert.equal(harness.sent[0].customType, "retry-limit");
		assert.equal(harness.widget, undefined, "countdown should be cleared after resuming");
	} finally {
		harness.dispose();
	}
});

test("/retry-limit cancel drops the pending retry", async () => {
	const harness = await start("tui");
	try {
		await harness.fail(LONG_LIMIT);
		await harness.emit("agent_settled");

		await harness.command("cancel");
		await settle();

		assert.equal(harness.sent.length, 0, "cancel must not resume");
		assert.equal(harness.widget, undefined);
	} finally {
		harness.dispose();
	}
});

test("inline enabled false cancels an active wait just like off", async () => {
	const harness = await start("tui");
	try {
		await harness.fail(LONG_LIMIT);
		await harness.emit("agent_settled");
		assert.ok(harness.widget);
		await harness.command("enabled false");
		await settle();
		assert.equal(harness.widget, undefined);
		await harness.command("now");
		assert.equal(harness.sent.length, 0, "a disabled countdown must not resume");
	} finally {
		harness.dispose();
	}
});

test("wait command rejects negative or partially valid durations", async () => {
	const harness = await start("tui");
	try {
		for (const duration of ["-5m", "1m garbage", `${"9".repeat(400)}s`]) {
			await harness.command(`wait ${duration}`);
			assert.match(harness.notifications.at(-1) ?? "", /usage/);
		}
		await harness.command("wait 1h30m");
		assert.match(harness.notifications.at(-1) ?? "", /fallback wait set to 1h 30m/);
	} finally {
		harness.dispose();
	}
});

test("new provider requests and agent runs discard earlier reset headers", async () => {
	const harness = await start("tui");
	try {
		for (const event of ["before_provider_request", "agent_start"]) {
			await harness.emit("after_provider_response", { status: 429, headers: { "retry-after": "600" } });
			await harness.emit(event);
			await harness.fail(LONG_LIMIT);
			await harness.emit("agent_settled");
			assert.match(harness.widget?.[1] ?? "", /via message:/, event);
			await harness.command("cancel");
			await settle();
		}
	} finally {
		harness.dispose();
	}
});

test("headers from the current request still take precedence over error prose", async () => {
	const harness = await start("tui");
	try {
		await harness.emit("before_provider_request");
		await harness.emit("after_provider_response", { status: 429, headers: { "retry-after": "600" } });
		await harness.fail(LONG_LIMIT);
		await harness.emit("agent_settled");
		assert.match(harness.widget?.[1] ?? "", /via header:retry-after/);
		await harness.command("cancel");
	} finally {
		harness.dispose();
	}
});

test("Esc cancels the wait", async () => {
	const harness = await start("tui");
	try {
		await harness.fail(LONG_LIMIT);
		await harness.emit("agent_settled");

		harness.key("\x1b");
		await settle();

		assert.equal(harness.sent.length, 0);
		assert.equal(harness.widget, undefined);
	} finally {
		harness.dispose();
	}
});

test("a second limit during the resumed run starts a fresh wait", async () => {
	const harness = await start("tui");
	try {
		await harness.fail(LONG_LIMIT);
		await harness.emit("agent_settled");
		await harness.command("now");
		await settle();
		assert.equal(harness.sent.length, 1);

		// The resumed run hits the limit again.
		await harness.fail(LONG_LIMIT);
		await harness.emit("agent_settled");

		assert.ok(harness.widget?.[0]?.includes("attempt 2"), `expected attempt 2, got ${JSON.stringify(harness.widget)}`);
		await harness.command("cancel");
	} finally {
		harness.dispose();
	}
});

test("outside the TUI the wait blocks, keeping -p runs alive", async () => {
	const harness = await start("print", { PI_RETRY_LIMIT_MIN_WAIT: "0" });
	try {
		await harness.fail(SHORT_LIMIT);

		const started = Date.now();
		const settled = harness.emit("agent_settled");
		let returned = false;
		void settled.then(() => {
			returned = true;
		});

		await settle();
		assert.equal(returned, false, "print mode must hold the prompt call open");

		await completeResume(harness);
		await settled;
		assert.ok(Date.now() - started >= 1_000, `returned after ${Date.now() - started}ms, expected a real wait`);
		assert.equal(harness.sent.length, 1);
	} finally {
		harness.dispose();
	}
});

test("waitMode blocking forces the blocking driver even in the TUI", async () => {
	const harness = await start("tui", { PI_RETRY_LIMIT_WAIT_MODE: "blocking", PI_RETRY_LIMIT_MIN_WAIT: "0" });
	try {
		await harness.fail(SHORT_LIMIT);

		const settled = harness.emit("agent_settled");
		let returned = false;
		void settled.then(() => {
			returned = true;
		});

		await settle();
		assert.equal(returned, false);

		await completeResume(harness);
		await settled;
		assert.equal(harness.sent.length, 1);
	} finally {
		harness.dispose();
	}
});

test("waitMode detached keeps -p from blocking when asked", async () => {
	const harness = await start("print", { PI_RETRY_LIMIT_WAIT_MODE: "detached" });
	try {
		await harness.fail(LONG_LIMIT);

		const started = Date.now();
		await harness.emit("agent_settled");

		assert.ok(Date.now() - started < 500, "detached mode must not block");
		await harness.command("cancel");
	} finally {
		harness.dispose();
	}
});

test("exhausted quota is reported, not waited out", async () => {
	const harness = await start("tui", { PI_RETRY_LIMIT_NOTIFY: "true" });
	try {
		await harness.fail("Your credit balance is too low to access the API");
		await harness.emit("agent_settled");
		await settle();

		assert.equal(harness.sent.length, 0);
		assert.ok(
			harness.notifications.some((message) => message.includes("exhausted quota")),
			`expected a quota warning, got ${JSON.stringify(harness.notifications)}`,
		);
	} finally {
		harness.dispose();
	}
});

test("a turn that succeeds clears an earlier failure in the same run", async () => {
	const harness = await start("tui");
	try {
		await harness.fail(LONG_LIMIT);
		await harness.emit("message_end", { message: { role: "assistant", stopReason: "stop" } });
		await harness.emit("agent_settled");
		await settle();

		assert.equal(harness.sent.length, 0, "a successful turn must not trigger a retry");
		assert.equal(harness.widget, undefined);
	} finally {
		harness.dispose();
	}
});

test("a user prompt during the wait supersedes the pending resume", async () => {
	const harness = await start("tui");
	try {
		await harness.fail(LONG_LIMIT);
		await harness.emit("agent_settled");
		assert.ok(harness.widget, "expected a wait in progress");

		await harness.emit("before_agent_start");
		await settle();

		assert.equal(harness.sent.length, 0, "the user taking over must not race with a resume");
		assert.equal(harness.widget, undefined);
	} finally {
		harness.dispose();
	}
});
