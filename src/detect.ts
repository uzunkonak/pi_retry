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

/**
 * Throttles and rolling usage windows that reopen without intervention.
 *
 * The `hit your … limit` and `<window> limit` alternatives cover the
 * subscription wording used by ChatGPT/Codex and Claude, which never says
 * "rate limit": "You have hit your ChatGPT usage limit (plus plan)",
 * "You've hit your session limit", "You've hit your 5h limit".
 */
const RATE_LIMIT_PATTERN = new RegExp(
	[
		"rate.?limit",
		"ratelimit",
		"too many requests",
		"\\b429\\b",
		"resource.?exhausted",
		// "usage limit", "session limit", "weekly limit", "5h limit", "5-hour limit".
		"\\b(?:usage|session|context window|weekly|daily|hourly|\\d+\\s*-?\\s*(?:h|hr|hour)s?|five.hour|plan|model|message|token|request)\\s+limit\\b",
		// "You have hit your ChatGPT usage limit", "You've hit your limit".
		"hit your(?:[^.]{0,40}?)?\\blimit\\b",
		"used up your[^.]{0,40}?\\blimit\\b",
		// "limit reached", "limit has been reached", "limit is reached".
		"limit (?:(?:has|have|had|is|was|been)\\s+)*reached",
		"limit exceeded",
		"limit will reset",
		"limit resets",
		"premium request",
		"throttl",
		"server requested \\d+(?:\\.\\d+)?s retry delay",
		"retry.?after",
		"slow down",
	].join("|"),
	"i",
);

/**
 * Decide whether a failed assistant message is a limit we can wait out.
 * Returns undefined for unrelated errors (network drops, 500s, bad requests).
 */
export function classifyLimitError(errorMessage: string | undefined): LimitClassification | undefined {
	if (!errorMessage) return undefined;

	// Request-size limits do not reopen with time. Retrying the same context
	// indefinitely cannot recover them; leave these to pi's overflow handling.
	if (/context[_ -](?:length|window)|maximum context|prompt (?:is )?too long/i.test(errorMessage)) {
		return undefined;
	}

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
export function resetFromHeaders(
	headers: Record<string, string>,
	now: number,
	observedAt = now,
): ResetHint | undefined {
	const lookup = normalizeHeaders(headers);

	for (const { name, unitMs } of DELAY_HEADERS) {
		const raw = lookup.get(name);
		if (raw === undefined) continue;
		const at = parseInstant(raw, observedAt, unitMs);
		if (at !== undefined && at <= now + MAX_HORIZON_MS) return { at, source: `header:${name}` };
	}

	let best: ResetHint | undefined;
	for (const name of RESET_HEADERS) {
		const raw = lookup.get(name);
		if (raw === undefined) continue;
		const at = parseInstant(raw, observedAt, 1_000);
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
 * Hedges providers put in front of a duration: ChatGPT reports "Try again in
 * ~109 min", others say "in about 5 minutes" or "in less than a minute".
 */
const APPROX = String.raw`(?:[~≈<]|about|approx(?:\.|imately)?|roughly|around|nearly|almost|under|less than|up to|at least)?\s*`;

/**
 * A duration capture. Stops at sentence punctuation or at the separators
 * providers use to append the next fact ("·", "|").
 *
 * The stop character must not be followed by a digit, so the decimal point in
 * "~0.1 min" or "1.5 hours" is not mistaken for the end of the sentence — which
 * would silently truncate the delay to its integer part. Everything else still
 * terminates the capture, including the quote-and-brace tail of a delay quoted
 * inside a JSON error body.
 */
const DURATION = String.raw`(\d[\d.\s a-z]*?)(?=[.,;:)\]·|](?!\d)|\bbefore\b|$)`;

/** A "when" capture. Parentheses are kept so a trailing `(Europe/Istanbul)` survives. */
const WHEN = String.raw`([^.,;\]·|]+)`;

/**
 * Prose patterns, most specific first. Each capture is handed to a reader that
 * turns it into an instant; the first reader that succeeds wins. Rules that
 * capture something unparseable fall through to the next rule.
 */
const MESSAGE_RULES: {
	id: string;
	pattern: RegExp;
	read: (match: RegExpExecArray, now: number) => number | undefined;
}[] = [
	// Pi's own guard when a provider asks for a longer delay than it will honour:
	// "Server requested 3600s retry delay (max: 60s)."
	{
		id: "server-requested-delay",
		pattern: /server requested\s+(\d+(?:\.\d+)?)\s*s(?:econds)?\s+retry delay/i,
		read: (m, now) => now + Number.parseFloat(m[1]) * 1000,
	},
	// Google: `"retryDelay": "34s"`.
	{
		id: "retry-delay-field",
		pattern: /retry_?delay["'\s:=]+(\d+(?:\.\d+)?)\s*s/i,
		read: (m, now) => now + Number.parseFloat(m[1]) * 1000,
	},
	// Explicit epoch in a JSON error body: "resets_at": 1735660800.
	{
		id: "resets-at-epoch",
		pattern: /reset(?:s)?_?(?:at|time)?["'\s:=]+(\d{10,13})\b/i,
		read: (m) => {
			const n = Number.parseInt(m[1], 10);
			return n >= 1e12 ? n : n * 1000;
		},
	},
	// "resets in 1h 49m" — must be tried before the bare "resets <when>" rule below,
	// which would otherwise read "in 1h 49m" as a clock time and fail.
	{
		id: "resets-in",
		pattern: new RegExp(String.raw`reset(?:s|ting)?\s+in\s+${APPROX}${DURATION}`, "i"),
		read: (m, now) => addDuration(m[1], now),
	},
	// "retry in 4m12s", "try again after 30 seconds", "Try again in ~109 min".
	{
		id: "try-again-in",
		pattern: new RegExp(
			String.raw`(?:retry|try again|retrying)\s+(?:again\s+)?(?:in|after)\s+${APPROX}${DURATION}`,
			"i",
		),
		read: (m, now) => addDuration(m[1], now),
	},
	// "please wait 5 minutes before retrying".
	{
		id: "wait-for",
		pattern: new RegExp(String.raw`wait\s+(?:for\s+)?${APPROX}${DURATION}`, "i"),
		read: (m, now) => addDuration(m[1], now),
	},
	// "your limit will reset at 3:00 PM", "resets on 2026-08-31T15:00:00Z", and the
	// preposition-less ChatGPT form "resets 11:30pm (Europe/Istanbul)".
	{
		id: "resets-at",
		pattern: new RegExp(String.raw`(?:will\s+)?reset(?:s|ting)?\s+(?:at\s+|on\s+)?${WHEN}`, "i"),
		read: (m, now) => parseWhen(m[1], now),
	},
	// "available again at 18:00".
	{
		id: "available-at",
		pattern: new RegExp(String.raw`available\s+(?:again\s+)?(?:at|on)\s+${WHEN}`, "i"),
		read: (m, now) => parseWhen(m[1], now),
	},
	// Last resort: a bare "in 45 seconds" anywhere in the text.
	{
		id: "bare-in",
		pattern: new RegExp(
			String.raw`\bin\s+${APPROX}(\d+(?:\.\d+)?\s*(?:seconds?|secs?|minutes?|mins?|hours?|hrs?))\b`,
			"i",
		),
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
		return { at, source: `message:${rule.id}` };
	}
	return undefined;
}

function addDuration(text: string, now: number): number | undefined {
	const delay = parseDuration(text);
	return delay === undefined ? undefined : now + delay;
}

/**
 * Read a captured "when" phrase: an absolute date, or a bare wall-clock time
 * such as "3:00 PM" or "11:30pm (Europe/Istanbul)" which providers print
 * without a date. A bare clock time resolves to its next occurrence, in the
 * stated timezone when there is one and in local time otherwise.
 */
function parseWhen(text: string, now: number): number | undefined {
	const { value, zone } = splitZone(text.trim().replace(/\s+/g, " "));
	if (value.length === 0) return undefined;

	// A four-digit run means a real date ("2026-08-31", "Aug 31 2026"), not a clock.
	if (!/\d{4}/.test(value)) {
		const clock = CLOCK_PATTERN.exec(value);
		if (clock) return nextClockTime(clock, now, zone);
	}

	const parsed = Date.parse(zone && !/\b(?:[+-]\d{2}:?\d{2}|Z|GMT|UTC)\b/.test(value) ? `${value} ${zone}` : value);
	return Number.isNaN(parsed) ? undefined : parsed;
}

/**
 * Wall-clock times, with the date-relative words providers use around them:
 * "11:30pm", "3:00 PM", "tomorrow at 9am", "14:32:00". An hour on its own is
 * only accepted with a meridiem, so a bare number is never mistaken for a time.
 */
const CLOCK_PATTERN = /^(?:(today|tomorrow)\s+)?(?:at\s+)?(\d{1,2})(?::(\d{2}))?(?::(\d{2}))?\s*(am|pm)?\b/i;

function nextClockTime(clock: RegExpExecArray, now: number, zone: string | undefined): number | undefined {
	const [, dayWord, rawHours, rawMinutes, rawSeconds, rawMeridiem] = clock;
	const meridiem = rawMeridiem?.toLowerCase();
	if (rawMinutes === undefined && meridiem === undefined) return undefined;

	let hours = Number.parseInt(rawHours, 10);
	if (hours > 23) return undefined;
	const minutes = rawMinutes ? Number.parseInt(rawMinutes, 10) : 0;
	const seconds = rawSeconds ? Number.parseInt(rawSeconds, 10) : 0;
	if (minutes > 59 || seconds > 59) return undefined;

	if (meridiem === "pm" && hours < 12) hours += 12;
	if (meridiem === "am" && hours === 12) hours = 0;

	const tomorrow = dayWord?.toLowerCase() === "tomorrow";

	if (zone) {
		const today = wallClockDate(zone, now);
		let at = zonedTimeToEpoch(zone, today.year, today.month, today.day + (tomorrow ? 1 : 0), hours, minutes, seconds);
		// A window that already reopened today must mean tomorrow's occurrence.
		if (at <= now && !dayWord) {
			at = zonedTimeToEpoch(zone, today.year, today.month, today.day + 1, hours, minutes, seconds);
		}
		return at;
	}

	const target = new Date(now);
	if (tomorrow) target.setDate(target.getDate() + 1);
	target.setHours(hours, minutes, seconds, 0);
	if (target.getTime() <= now && !dayWord) target.setDate(target.getDate() + 1);
	return target.getTime();
}

/**
 * Separate a trailing timezone from the time itself. Providers append it either
 * parenthesised ("11:30pm (Europe/Istanbul)") or bare ("11:30pm Europe/Istanbul").
 * A parenthetical that is not a timezone — "(plus plan)" — is simply dropped.
 */
function splitZone(text: string): { value: string; zone?: string } {
	const paren = /\s*\(([^)]*)\)\s*$/.exec(text);
	if (paren) {
		const candidate = paren[1].trim();
		const head = text.slice(0, paren.index).trim();
		return isTimeZone(candidate) ? { value: head, zone: candidate } : { value: head };
	}

	const bare = /\s+([A-Za-z_]+(?:\/[A-Za-z_0-9+-]+)+)\s*$/.exec(text);
	if (bare && isTimeZone(bare[1])) return { value: text.slice(0, bare.index).trim(), zone: bare[1] };

	return { value: text };
}

function isTimeZone(candidate: string): boolean {
	if (!/^[A-Za-z_]+(?:\/[A-Za-z_0-9+-]+)*$/.test(candidate)) return false;
	try {
		new Intl.DateTimeFormat("en-US", { timeZone: candidate });
		return true;
	} catch {
		return false;
	}
}

interface WallClockDate {
	year: number;
	month: number;
	day: number;
}

const ZONE_FORMATTERS = new Map<string, Intl.DateTimeFormat>();

function zoneFormatter(zone: string): Intl.DateTimeFormat {
	let formatter = ZONE_FORMATTERS.get(zone);
	if (!formatter) {
		formatter = new Intl.DateTimeFormat("en-US", {
			timeZone: zone,
			hourCycle: "h23",
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
			hour: "2-digit",
			minute: "2-digit",
			second: "2-digit",
		});
		ZONE_FORMATTERS.set(zone, formatter);
	}
	return formatter;
}

function wallClockDate(zone: string, epoch: number): WallClockDate {
	const parts = zonePartsOf(zone, epoch);
	return { year: parts[0], month: parts[1], day: parts[2] };
}

function zonePartsOf(zone: string, epoch: number): [number, number, number, number, number, number] {
	const parts = zoneFormatter(zone).formatToParts(new Date(epoch));
	const read = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((part) => part.type === type)?.value);
	// `hourCycle: "h23"` still reports midnight as 24 in some ICU builds.
	const hour = read("hour") % 24;
	return [read("year"), read("month"), read("day"), hour, read("minute"), read("second")];
}

/** Milliseconds to add to a UTC instant to get the wall clock in `zone`. */
function zoneOffset(zone: string, epoch: number): number {
	const [year, month, day, hour, minute, second] = zonePartsOf(zone, epoch);
	return Date.UTC(year, month - 1, day, hour, minute, second) - epoch;
}

/**
 * Convert a wall-clock time in `zone` to an epoch. Two passes because the
 * offset used to undo the conversion is itself offset-dependent around DST
 * transitions; the second pass settles it. Out-of-range day numbers roll over,
 * so `day + 1` on the last of the month is safe.
 */
function zonedTimeToEpoch(
	zone: string,
	year: number,
	month: number,
	day: number,
	hours: number,
	minutes: number,
	seconds: number,
): number {
	const asUTC = Date.UTC(year, month - 1, day, hours, minutes, seconds);
	const first = asUTC - zoneOffset(zone, asUTC);
	return asUTC - zoneOffset(zone, first);
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
	if (response && isLimitStatus(response.status) && response.at <= now && now - response.at <= responseMaxAgeMs) {
		// Relative headers count from receipt, not from the end of pi's retries.
		const fromHeaders = resetFromHeaders(response.headers, now, response.at);
		if (fromHeaders) return fromHeaders;
	}
	return resetFromMessage(errorMessage, now);
}
