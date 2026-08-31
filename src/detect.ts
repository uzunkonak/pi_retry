/**
 * Classification of provider failures and extraction of the moment the limit
 * window reopens.
 *
 * Two independent signals are used, in this order of trust:
 *   1. Response headers captured by the `after_provider_response` hook. Providers
 *      that send `retry-after` or a `*-ratelimit-*-reset` header tell us exactly
 *      when to come back.
 *   2. The provider's error text, which frequently carries the same information
 *      in prose ("try again in 4m12s", "your limit will reset at 3:00 PM").
 *
 * Neither is guaranteed, so callers fall back to a blind polling interval.
 */

import { parseDuration } from "./duration.ts";

/**
 * `rate-limit` is a throttle or usage window that reopens on its own.
 * `quota` is exhausted credit/billing, which usually needs human action.
 */
export type LimitKind = "rate-limit" | "quota";

export interface LimitClassification {
	kind: LimitKind;
	/** The substring that triggered the match, for status text and logs. */
	matched: string;
}

export interface ResetHint {
	/** Epoch milliseconds at which the request may be retried. */
	at: number;
	/** Where the hint came from, e.g. `header:retry-after`. */
	source: string;
}

export interface ProviderResponse {
	status: number;
	headers: Record<string, string>;
	/** Epoch milliseconds the response was observed. */
	at: number;
}

/**
 * Hard exhaustion. Checked first: these strings often co-occur with the word
 * "limit", and waiting for a monthly credit reset is rarely what a user wants
 * by default.
 */
const QUOTA_PATTERN =
	/insufficient_quota|quota exceeded|exceeded your quota|out of (?:budget|credit)|available balance|credit balance|billing|payment required|GoUsageLimitError|FreeUsageLimitError|monthly usage limit/i;

/** Throttles and rolling usage windows that reopen without intervention. */
const RATE_LIMIT_PATTERN =
	/rate.?limit|ratelimit|too many requests|\b429\b|resource.?exhausted|usage limit|limit reached|limit exceeded|limit will reset|weekly limit|daily limit|hourly limit|premium request|throttl|server requested \d+(?:\.\d+)?s retry delay|retry.?after|slow down/i;

/**
 * Decide whether a failed assistant message is a limit we can wait out.
 * Returns undefined for unrelated errors (network drops, 500s, bad requests).
 */
export function classifyLimitError(errorMessage: string | undefined): LimitClassification | undefined {
	if (!errorMessage) return undefined;

	const quota = QUOTA_PATTERN.exec(errorMessage);
	if (quota) return { kind: "quota", matched: quota[0] };

	const rateLimit = RATE_LIMIT_PATTERN.exec(errorMessage);
	if (rateLimit) return { kind: "rate-limit", matched: rateLimit[0] };

	return undefined;
}

/** HTTP statuses that make a captured response worth mining for reset headers. */
export function isLimitStatus(status: number): boolean {
	return status === 429 || status === 402 || status === 403 || status === 529;
}

/** Headers that state a delay rather than an instant. */
const DELAY_HEADERS: { name: string; unitMs: number }[] = [
	{ name: "retry-after-ms", unitMs: 1 },
	{ name: "retry-after", unitMs: 1_000 },
	{ name: "x-ratelimit-reset-after", unitMs: 1_000 },
	{ name: "x-should-retry-after", unitMs: 1_000 },
];

/**
 * Headers that state when the window reopens. Values are wildly inconsistent
 * across providers (epoch seconds, epoch millis, RFC 3339, Go durations), so
 * `parseInstant` sniffs the shape instead of trusting a per-provider schema.
 */
const RESET_HEADERS = [
	"anthropic-ratelimit-unified-reset",
	"anthropic-ratelimit-unified-5h-reset",
	"anthropic-ratelimit-unified-7d-reset",
	"anthropic-ratelimit-requests-reset",
	"anthropic-ratelimit-tokens-reset",
	"anthropic-ratelimit-input-tokens-reset",
	"anthropic-ratelimit-output-tokens-reset",
	"x-ratelimit-reset",
	"x-ratelimit-reset-requests",
	"x-ratelimit-reset-tokens",
	"x-rate-limit-reset",
	"ratelimit-reset",
];

/** Reject instants that are absurdly far out; they are almost always misparses. */
const MAX_HORIZON_MS = 30 * 86_400_000;

/**
 * Pull a reset instant out of response headers.
 *
 * An explicit `retry-after` wins because it is the provider's own instruction.
 * Otherwise the *earliest* future reset is used: several windows may be reported
 * at once and we cannot tell which one was hit, so retrying early and waiting
 * again beats sleeping through a seven-day header for a one-minute throttle.
 */
export function resetFromHeaders(headers: Record<string, string>, now: number): ResetHint | undefined {
	const lookup = normalizeHeaders(headers);

	for (const { name, unitMs } of DELAY_HEADERS) {
		const raw = lookup.get(name);
		if (raw === undefined) continue;
		const at = parseInstant(raw, now, unitMs);
		if (at !== undefined && at <= now + MAX_HORIZON_MS) return { at, source: `header:${name}` };
	}

	let best: ResetHint | undefined;
	for (const name of RESET_HEADERS) {
		const raw = lookup.get(name);
		if (raw === undefined) continue;
		const at = parseInstant(raw, now, 1_000);
		if (at === undefined || at <= now || at > now + MAX_HORIZON_MS) continue;
		if (!best || at < best.at) best = { at, source: `header:${name}` };
	}
	return best;
}

/**
 * Interpret one header value as an epoch milliseconds instant.
 *
 * `bareUnitMs` decides how a plain number that is too small to be an epoch is
 * read — milliseconds for `retry-after-ms`, seconds everywhere else.
 */
function parseInstant(raw: string, now: number, bareUnitMs: number): number | undefined {
	const value = raw.trim();
	if (value.length === 0) return undefined;

	if (/^\d+(?:\.\d+)?$/.test(value)) {
		const n = Number.parseFloat(value);
		if (n >= 1e12) return n; // epoch millis
		if (n >= 1e9) return n * 1000; // epoch seconds
		return now + n * bareUnitMs; // relative delay
	}

	// Go-style durations ("6m0s") and plain unit strings ("1500ms").
	if (/^[\d.]+\s*(?:ms|s|m|h|d)/i.test(value)) {
		const delay = parseDuration(value, bareUnitMs);
		if (delay !== undefined) return now + delay;
	}

	const parsed = Date.parse(value);
	return Number.isNaN(parsed) ? undefined : parsed;
}

function normalizeHeaders(headers: Record<string, string>): Map<string, string> {
	const lookup = new Map<string, string>();
	for (const [key, value] of Object.entries(headers)) {
		if (typeof value === "string") lookup.set(key.toLowerCase(), value);
	}
	return lookup;
}

/**
 * Prose patterns, most specific first. Each capture is handed to a reader that
 * turns it into an instant; the first reader that succeeds wins.
 */
const MESSAGE_RULES: { pattern: RegExp; read: (match: RegExpExecArray, now: number) => number | undefined }[] = [
	// Pi's own guard when a provider asks for a longer delay than it will honour:
	// "Server requested 3600s retry delay (max: 60s)."
	{
		pattern: /server requested\s+(\d+(?:\.\d+)?)\s*s(?:econds)?\s+retry delay/i,
		read: (m, now) => now + Number.parseFloat(m[1]) * 1000,
	},
	// Google: `"retryDelay": "34s"`.
	{
		pattern: /retry_?delay["'\s:=]+(\d+(?:\.\d+)?)\s*s/i,
		read: (m, now) => now + Number.parseFloat(m[1]) * 1000,
	},
	// Explicit epoch in a JSON error body: "resets_at": 1735660800.
	{
		pattern: /reset(?:s)?_?(?:at|time)?["'\s:=]+(\d{10,13})\b/i,
		read: (m) => {
			const n = Number.parseInt(m[1], 10);
			return n >= 1e12 ? n : n * 1000;
		},
	},
	// "retry in 4m12s", "try again after 30 seconds".
	{
		pattern: /(?:retry|try again|retrying)\s+(?:again\s+)?(?:in|after)\s+([\d][\d.\s a-z]*?)(?=[.,;:)\]]|\bbefore\b|$)/i,
		read: (m, now) => addDuration(m[1], now),
	},
	// "please wait 5 minutes before retrying".
	{
		pattern: /wait\s+(?:for\s+)?([\d][\d.\s a-z]*?)(?=[.,;:)\]]|\bbefore\b|$)/i,
		read: (m, now) => addDuration(m[1], now),
	},
	// "your limit will reset at 3:00 PM", "resets on 2026-08-31T15:00:00Z".
	{
		pattern: /(?:will\s+)?reset(?:s|ting)?\s+(?:at|on)\s+([^.,;)\]]+)/i,
		read: (m, now) => parseWhen(m[1], now),
	},
	// "available again at 18:00".
	{
		pattern: /available\s+(?:again\s+)?(?:at|on)\s+([^.,;)\]]+)/i,
		read: (m, now) => parseWhen(m[1], now),
	},
	// Last resort: a bare "in 45 seconds" anywhere in the text.
	{
		pattern: /\bin\s+(\d+(?:\.\d+)?\s*(?:seconds?|secs?|minutes?|mins?|hours?|hrs?))\b/i,
		read: (m, now) => addDuration(m[1], now),
	},
];

/** Pull a reset instant out of the provider's error prose. */
export function resetFromMessage(errorMessage: string | undefined, now: number): ResetHint | undefined {
	if (!errorMessage) return undefined;

	for (const rule of MESSAGE_RULES) {
		const match = rule.pattern.exec(errorMessage);
		if (!match) continue;
		const at = rule.read(match, now);
		if (at === undefined || Number.isNaN(at)) continue;
		if (at > now + MAX_HORIZON_MS) continue;
		return { at, source: `message:${rule.pattern.source.slice(0, 24)}` };
	}
	return undefined;
}

function addDuration(text: string, now: number): number | undefined {
	const delay = parseDuration(text);
	return delay === undefined ? undefined : now + delay;
}

/**
 * Read a captured "when" phrase: an absolute date, or a bare wall-clock time
 * such as "3:00 PM" which providers print without a date. A bare clock time is
 * resolved to its next occurrence in local time.
 */
function parseWhen(text: string, now: number): number | undefined {
	const value = text.trim().replace(/\s+/g, " ");
	if (value.length === 0) return undefined;

	const clock = /^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(am|pm)?\b/i.exec(value);
	if (clock && !/\d{4}/.test(value)) return nextClockTime(clock, now);

	const parsed = Date.parse(value);
	return Number.isNaN(parsed) ? undefined : parsed;
}

function nextClockTime(clock: RegExpExecArray, now: number): number {
	let hours = Number.parseInt(clock[1], 10);
	const minutes = Number.parseInt(clock[2], 10);
	const seconds = clock[3] ? Number.parseInt(clock[3], 10) : 0;
	const meridiem = clock[4]?.toLowerCase();

	if (meridiem === "pm" && hours < 12) hours += 12;
	if (meridiem === "am" && hours === 12) hours = 0;

	const target = new Date(now);
	target.setHours(hours, minutes, seconds, 0);
	if (target.getTime() <= now) target.setDate(target.getDate() + 1);
	return target.getTime();
}

/**
 * Best available reset instant for a failed run, or undefined when the provider
 * gave us nothing to go on.
 *
 * The captured response is only trusted while it is fresh and its status looks
 * like a limit — otherwise a stale 200 from an earlier turn would leak its
 * headers into this decision.
 */
export function resolveResetHint(
	errorMessage: string | undefined,
	response: ProviderResponse | undefined,
	now: number,
	responseMaxAgeMs = 120_000,
): ResetHint | undefined {
	if (response && isLimitStatus(response.status) && now - response.at <= responseMaxAgeMs) {
		const fromHeaders = resetFromHeaders(response.headers, now);
		if (fromHeaders) return fromHeaders;
	}
	return resetFromMessage(errorMessage, now);
}
