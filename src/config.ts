/**
 * Configuration for the retry-limit extension.
 *
 * Sources are layered, later wins:
 *   defaults -> ~/.pi/agent/retry-limit.json -> <cwd>/.pi/retry-limit.json -> PI_RETRY_LIMIT_* env
 *
 * Every duration accepts either a number of milliseconds or a duration string
 * ("90s", "15m", "2h"), so a hand-edited config file stays readable.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseDuration } from "./duration.ts";

export interface RetryLimitConfig {
	/** Master switch. */
	enabled: boolean;
	/** Consecutive resume attempts before giving up. 0 means keep going. */
	maxAttempts: number;
	/** Never sleep less than this, even if the provider says the window is open. */
	minWaitMs: number;
	/** Cap on a single wait. 0 means no cap; a longer window is slept through whole. */
	maxWaitMs: number;
	/** Slack added to a parsed reset instant to absorb clock skew. */
	paddingMs: number;
	/** Wait used when neither headers nor error text reveal a reset time. */
	fallbackWaitMs: number;
	/** Growth factor applied to the blind wait on each consecutive failure. */
	fallbackFactor: number;
	/** Ceiling for the escalating blind wait. */
	fallbackMaxWaitMs: number;
	/** Also wait out exhausted credit/billing quota. Off: those need human action. */
	retryOnQuotaExhausted: boolean;
	/** Drop failed assistant turns from the LLM context before resuming. */
	pruneErrorMessages: boolean;
	/** Wrap `globalThis.fetch` to recover rate-limit headers pi's hook cannot see. */
	observeResponses: boolean;
	/** Show the resume message in the transcript instead of hiding it. */
	showResumeMessage: boolean;
	/** Emit `ctx.ui.notify` calls when a wait starts, is cancelled, or resumes. */
	notify: boolean;
	/** The message injected to restart the interrupted work. */
	resumePrompt: string;
}

export const DEFAULT_CONFIG: RetryLimitConfig = {
	enabled: true,
	maxAttempts: 0,
	minWaitMs: 5_000,
	maxWaitMs: 0,
	paddingMs: 2_000,
	fallbackWaitMs: 60_000,
	fallbackFactor: 1.5,
	fallbackMaxWaitMs: 15 * 60_000,
	retryOnQuotaExhausted: false,
	pruneErrorMessages: true,
	observeResponses: true,
	showResumeMessage: true,
	notify: true,
	resumePrompt:
		"The previous request failed because the model provider's rate limit was exceeded. " +
		"The limit window has now reset. Continue the interrupted work from exactly where it stopped — " +
		"do not restart from the beginning, do not re-summarise what you already did, and do not ask the user to repeat their request.",
};

const CONFIG_FILENAME = "retry-limit.json";

/** Keys accepted in a config file, mapped to how their raw value is read. */
const FIELD_READERS: { [K in keyof RetryLimitConfig]: (raw: unknown) => RetryLimitConfig[K] | undefined } = {
	enabled: readBoolean,
	maxAttempts: readNumber,
	minWaitMs: readDuration,
	maxWaitMs: readDuration,
	paddingMs: readDuration,
	fallbackWaitMs: readDuration,
	fallbackFactor: readNumber,
	fallbackMaxWaitMs: readDuration,
	retryOnQuotaExhausted: readBoolean,
	pruneErrorMessages: readBoolean,
	observeResponses: readBoolean,
	showResumeMessage: readBoolean,
	notify: readBoolean,
	resumePrompt: readString,
};

/** Config-file keys may also be written without the `Ms` suffix. */
const FIELD_ALIASES: Record<string, keyof RetryLimitConfig> = {
	minWait: "minWaitMs",
	maxWait: "maxWaitMs",
	padding: "paddingMs",
	fallbackWait: "fallbackWaitMs",
	fallbackMaxWait: "fallbackMaxWaitMs",
};

const ENV_KEYS: Record<string, keyof RetryLimitConfig> = {
	PI_RETRY_LIMIT_ENABLED: "enabled",
	PI_RETRY_LIMIT_MAX_ATTEMPTS: "maxAttempts",
	PI_RETRY_LIMIT_MIN_WAIT: "minWaitMs",
	PI_RETRY_LIMIT_MAX_WAIT: "maxWaitMs",
	PI_RETRY_LIMIT_PADDING: "paddingMs",
	PI_RETRY_LIMIT_FALLBACK_WAIT: "fallbackWaitMs",
	PI_RETRY_LIMIT_FALLBACK_FACTOR: "fallbackFactor",
	PI_RETRY_LIMIT_FALLBACK_MAX_WAIT: "fallbackMaxWaitMs",
	PI_RETRY_LIMIT_QUOTA: "retryOnQuotaExhausted",
	PI_RETRY_LIMIT_PRUNE_ERRORS: "pruneErrorMessages",
	PI_RETRY_LIMIT_OBSERVE_RESPONSES: "observeResponses",
	PI_RETRY_LIMIT_SHOW_RESUME: "showResumeMessage",
	PI_RETRY_LIMIT_NOTIFY: "notify",
	PI_RETRY_LIMIT_PROMPT: "resumePrompt",
};

export interface LoadedConfig {
	config: RetryLimitConfig;
	/** Paths that contributed, and any problems worth telling the user about. */
	sources: string[];
	warnings: string[];
}

/** Resolve the effective configuration for a session. */
export function loadConfig(cwd: string, env: NodeJS.ProcessEnv = process.env): LoadedConfig {
	const config: RetryLimitConfig = { ...DEFAULT_CONFIG };
	const sources: string[] = [];
	const warnings: string[] = [];

	const files = [join(homedir(), ".pi", "agent", CONFIG_FILENAME), join(cwd, ".pi", CONFIG_FILENAME)];
	for (const file of files) {
		const raw = readJsonFile(file, warnings);
		if (!raw) continue;
		applyRecord(config, raw, `file ${file}`, warnings);
		sources.push(file);
	}

	const fromEnv: Record<string, unknown> = {};
	for (const [envKey, field] of Object.entries(ENV_KEYS)) {
		const value = env[envKey];
		if (value !== undefined) fromEnv[field] = value;
	}
	if (Object.keys(fromEnv).length > 0) {
		applyRecord(config, fromEnv, "environment", warnings);
		sources.push("environment");
	}

	return { config, sources, warnings };
}

/** Apply a partial config on top of `config`, reporting anything unusable. */
export function applyRecord(
	config: RetryLimitConfig,
	raw: Record<string, unknown>,
	origin: string,
	warnings: string[],
): void {
	for (const [key, value] of Object.entries(raw)) {
		const field = (FIELD_ALIASES[key] ?? key) as keyof RetryLimitConfig;
		const reader = FIELD_READERS[field] as ((raw: unknown) => unknown) | undefined;
		if (!reader) {
			warnings.push(`${origin}: unknown option "${key}"`);
			continue;
		}
		const parsed = reader(value);
		if (parsed === undefined) {
			warnings.push(`${origin}: could not read "${key}" from ${JSON.stringify(value)}`);
			continue;
		}
		Object.assign(config, { [field]: parsed });
	}
}

function readJsonFile(path: string, warnings: string[]): Record<string, unknown> | undefined {
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch {
		return undefined; // Absent config files are the normal case.
	}
	try {
		const parsed: unknown = JSON.parse(text);
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
		warnings.push(`file ${path}: expected a JSON object`);
	} catch (error) {
		warnings.push(`file ${path}: ${error instanceof Error ? error.message : String(error)}`);
	}
	return undefined;
}

function readBoolean(raw: unknown): boolean | undefined {
	if (typeof raw === "boolean") return raw;
	if (typeof raw === "string") {
		const value = raw.trim().toLowerCase();
		if (["1", "true", "yes", "on"].includes(value)) return true;
		if (["0", "false", "no", "off"].includes(value)) return false;
	}
	return undefined;
}

function readNumber(raw: unknown): number | undefined {
	if (typeof raw === "number") return Number.isFinite(raw) ? raw : undefined;
	if (typeof raw === "string") {
		const value = Number.parseFloat(raw.trim());
		return Number.isFinite(value) ? value : undefined;
	}
	return undefined;
}

function readDuration(raw: unknown): number | undefined {
	if (typeof raw === "number") return Number.isFinite(raw) && raw >= 0 ? raw : undefined;
	if (typeof raw === "string") {
		// Bare numbers in config mean milliseconds, matching the `*Ms` field names.
		const parsed = parseDuration(raw, 1);
		return parsed !== undefined && parsed >= 0 ? parsed : undefined;
	}
	return undefined;
}

function readString(raw: unknown): string | undefined {
	return typeof raw === "string" ? raw : undefined;
}
