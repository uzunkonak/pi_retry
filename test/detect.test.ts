import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { classifyLimitError, resetFromHeaders, resetFromMessage, resolveResetHint } from "../src/detect.ts";
import { planWait } from "../src/plan.ts";

const NOW = Date.parse("2026-08-31T12:00:00.000Z");

test("classifies resetting windows as rate limits", () => {
	const messages = [
		"429 Too Many Requests",
		"Rate limit exceeded for requests",
		"Server requested 3600s retry delay (max: 60s). rate_limit_exceeded",
		"You have exceeded your premium request allowance",
		"ResourceExhausted: quota for requests per minute",
		"Your usage limit will reset at 3:00 PM",
	];
	for (const message of messages) {
		assert.equal(classifyLimitError(message)?.kind, "rate-limit", message);
	}
});

test("classifies ChatGPT and Codex subscription wording as rate limits", () => {
	const messages = [
		"You have hit your ChatGPT usage limit (plus plan). Try again in ~109 min.",
		"Auto-compaction failed: Summarization failed: Codex error: The usage limit has been reached.",
		"You've hit your session limit \u00b7 resets 11:30pm (Europe/Istanbul)",
		"You've hit your 5h limit \u00b7 resets 14:32",
		"You've used up your weekly limit. Resets in 1 hour 49 minutes.",
		"Claude usage limit reached. Your limit will reset at 3pm (Europe/Istanbul).",
	];
	for (const message of messages) {
		assert.equal(classifyLimitError(message)?.kind, "rate-limit", message);
	}
});

test("classifies exhausted credit as quota, not a window", () => {
	const messages = [
		"insufficient_quota: You exceeded your current quota, please check your plan and billing details",
		"GoUsageLimitError: Monthly usage limit reached, enable available balance",
		"Your credit balance is too low to access the API",
	];
	for (const message of messages) {
		assert.equal(classifyLimitError(message)?.kind, "quota", message);
	}
});

test("ignores unrelated failures", () => {
	assert.equal(classifyLimitError("fetch failed: ECONNRESET"), undefined);
	assert.equal(classifyLimitError("400 invalid_request_error: bad tool schema"), undefined);
	assert.equal(classifyLimitError(undefined), undefined);
});

test("does not retry context-size limits as resetting windows", () => {
	for (const message of [
		"400 context window limit exceeded",
		"context_length_exceeded: token limit exceeded",
		"Your prompt is too long; request limit exceeded",
		"Maximum context length exceeded",
	]) {
		assert.equal(classifyLimitError(message), undefined, message);
	}
});

test("reads retry-after in seconds and as an HTTP date", () => {
	assert.equal(resetFromHeaders({ "retry-after": "120" }, NOW)?.at, NOW + 120_000);
	assert.equal(
		resetFromHeaders({ "Retry-After": "Mon, 31 Aug 2026 12:05:00 GMT" }, NOW)?.at,
		Date.parse("2026-08-31T12:05:00.000Z"),
	);
	assert.equal(resetFromHeaders({ "retry-after-ms": "4500" }, NOW)?.at, NOW + 4_500);
});

test("retry-after wins over reset headers", () => {
	const hint = resetFromHeaders(
		{ "retry-after": "30", "anthropic-ratelimit-unified-reset": String(Math.floor(NOW / 1000) + 3600) },
		NOW,
	);
	assert.equal(hint?.source, "header:retry-after");
	assert.equal(hint?.at, NOW + 30_000);
});

test("picks the earliest future reset when several windows are reported", () => {
	const hint = resetFromHeaders(
		{
			"anthropic-ratelimit-unified-7d-reset": String(Math.floor(NOW / 1000) + 7 * 86_400),
			"anthropic-ratelimit-unified-5h-reset": String(Math.floor(NOW / 1000) + 5 * 3600),
			"anthropic-ratelimit-requests-reset": "2026-08-31T12:01:00Z",
		},
		NOW,
	);
	assert.equal(hint?.source, "header:anthropic-ratelimit-requests-reset");
	assert.equal(hint?.at, Date.parse("2026-08-31T12:01:00.000Z"));
});

test("sniffs epoch seconds, epoch millis, and Go durations", () => {
	assert.equal(resetFromHeaders({ "x-ratelimit-reset": String(Math.floor(NOW / 1000) + 60) }, NOW)?.at, NOW + 60_000);
	assert.equal(resetFromHeaders({ "x-ratelimit-reset": String(NOW + 60_000) }, NOW)?.at, NOW + 60_000);
	assert.equal(resetFromHeaders({ "x-ratelimit-reset-tokens": "6m0s" }, NOW)?.at, NOW + 360_000);
});

test("ignores past and absurd reset headers", () => {
	assert.equal(resetFromHeaders({ "x-ratelimit-reset": String(Math.floor(NOW / 1000) - 60) }, NOW), undefined);
	assert.equal(resetFromHeaders({ "x-ratelimit-reset": "99999999999999" }, NOW), undefined);
	assert.equal(resetFromHeaders({}, NOW), undefined);
});

test("reads reset times out of provider error prose", () => {
	const cases: [string, number][] = [
		["Server requested 3600s retry delay (max: 60s).", NOW + 3_600_000],
		['{"error":{"details":[{"retryDelay":"34s"}]}}', NOW + 34_000],
		["Rate limit reached. Please try again in 4m12s.", NOW + 252_000],
		["Too many requests, retry after 30 seconds.", NOW + 30_000],
		["Rate limited; please wait 5 minutes before retrying.", NOW + 300_000],
		["Usage limit reached. Resets at 2026-08-31T12:45:00Z", Date.parse("2026-08-31T12:45:00.000Z")],
		['{"error":"rate_limited","resets_at":1788177600}', 1_788_177_600_000],
	];
	for (const [message, expected] of cases) {
		assert.equal(resetFromMessage(message, NOW)?.at, expected, message);
	}
});

test("resolves a bare wall-clock reset to its next occurrence", () => {
	const midday = Date.parse("2026-08-31T12:00:00.000Z");
	const hint = resetFromMessage("You've hit your limit. Your limit will reset at 3:00 PM.", midday);
	assert.ok(hint, "expected a hint");
	const target = new Date(hint.at);
	assert.equal(target.getHours(), 15);
	assert.equal(target.getMinutes(), 0);
	assert.ok(hint.at > midday, "must be in the future");
});

test("reads approximate delays, the ChatGPT house style", () => {
	const cases: [string, number][] = [
		["You have hit your ChatGPT usage limit (plus plan). Try again in ~109 min.", NOW + 109 * 60_000],
		["Rate limited. Try again in about 5 minutes.", NOW + 300_000],
		["Please wait approximately 90 seconds before retrying.", NOW + 90_000],
		["You've used up your weekly limit. Resets in 1 hour 49 minutes.", NOW + 109 * 60_000],
	];
	for (const [message, expected] of cases) {
		assert.equal(resetFromMessage(message, NOW)?.at, expected, message);
	}
});

test("reads a preposition-less reset with an IANA timezone", () => {
	// 12:00 UTC. 11:30pm in Istanbul (UTC+3) is 20:30 UTC the same day.
	const hint = resetFromMessage("You've hit your session limit \u00b7 resets 11:30pm (Europe/Istanbul)", NOW);
	assert.equal(hint?.at, Date.parse("2026-08-31T20:30:00.000Z"));
	assert.equal(hint?.source, "message:resets-at");
});

test("rolls a reset that already passed today into tomorrow, in the stated zone", () => {
	// 09:00 UTC is 12:00 in Istanbul, so 10:00 there is already gone.
	const morning = Date.parse("2026-08-31T09:00:00.000Z");
	const hint = resetFromMessage("Limit reached, resets 10:00 (Europe/Istanbul)", morning);
	assert.equal(hint?.at, Date.parse("2026-09-01T07:00:00.000Z"));
});

test("reads an hour-only reset and honours an explicit day", () => {
	assert.equal(
		resetFromMessage("Claude usage limit reached. Your limit will reset at 3pm (Europe/Istanbul).", NOW)?.at,
		// 15:00 Istanbul is 12:00 UTC, i.e. exactly NOW, so it must roll to tomorrow.
		Date.parse("2026-09-01T12:00:00.000Z"),
	);
	assert.equal(
		resetFromMessage("Your limit resets tomorrow at 9am (Europe/Istanbul).", NOW)?.at,
		Date.parse("2026-09-01T06:00:00.000Z"),
	);
});

test("ignores a parenthetical that is not a timezone", () => {
	const hint = resetFromMessage("Usage limit reached. Resets at 2026-08-31T12:45:00Z (plus plan)", NOW);
	assert.equal(hint?.at, Date.parse("2026-08-31T12:45:00.000Z"));
});

test("does not read a bare hour as a clock time", () => {
	// "reset 5 times today" must not become 05:00.
	assert.equal(resetFromMessage("The connection was reset 5 times", NOW), undefined);
});

test("returns nothing when the error text has no timing", () => {
	assert.equal(resetFromMessage("429 Too Many Requests", NOW), undefined);
});

test("headers are only trusted while fresh and limit-shaped", () => {
	const headers = { "retry-after": "60" };
	const fresh = { status: 429, headers, at: NOW - 1_000 };
	assert.equal(resolveResetHint("rate limit", fresh, NOW)?.source, "header:retry-after");

	const stale = { status: 429, headers, at: NOW - 10 * 60_000 };
	assert.equal(resolveResetHint("rate limit", stale, NOW), undefined);

	const ok = { status: 200, headers, at: NOW - 1_000 };
	assert.equal(resolveResetHint("rate limit", ok, NOW), undefined);
});

test("relative reset headers count from receipt, not the retry decision", () => {
	const at = NOW - 30_000;
	const cases: Record<string, string>[] = [
		{ "retry-after": "60" },
		{ "retry-after-ms": "60000" },
		{ "x-ratelimit-reset-tokens": "1m" },
	];
	for (const headers of cases) {
		assert.equal(resolveResetHint("429", { status: 429, headers, at }, NOW)?.at, NOW + 30_000);
	}
	// An elapsed relative delay stays elapsed; the wait planner supplies its minimum.
	assert.equal(resolveResetHint("429", { status: 429, headers: { "retry-after": "10" }, at }, NOW)?.at, NOW - 20_000);
	assert.equal(
		resolveResetHint("429", { status: 429, headers: { "retry-after": "Mon, 31 Aug 2026 12:05:00 GMT" }, at }, NOW)?.at,
		NOW + 300_000,
	);
});

test("reset windows that elapsed since receipt do not hide a future window", () => {
	const response = {
		status: 429,
		at: NOW - 30_000,
		headers: { "x-ratelimit-reset-requests": "10s", "x-ratelimit-reset-tokens": "1m" },
	};
	const hint = resolveResetHint("429", response, NOW);
	assert.equal(hint?.source, "header:x-ratelimit-reset-tokens");
	assert.equal(hint?.at, NOW + 30_000);
});

test("future-dated observations are ignored after a clock change", () => {
	const response = { status: 429, headers: { "retry-after": "60" }, at: NOW + 1_000 };
	assert.equal(resolveResetHint("Rate limit. Try again in 90s", response, NOW)?.at, NOW + 90_000);
});

test("headers lose to error text only when they yield nothing", () => {
	const response = { status: 429, headers: { "x-request-id": "abc" }, at: NOW };
	const hint = resolveResetHint("Rate limited, try again in 90s", response, NOW);
	assert.equal(hint?.at, NOW + 90_000);
});

test("planWait pads a known reset and honours the minimum", () => {
	const config = { ...DEFAULT_CONFIG, paddingMs: 2_000, minWaitMs: 5_000 };
	const padded = planWait({ hint: { at: NOW + 60_000, source: "header:retry-after" }, now: NOW, attempt: 1, config });
	assert.equal(padded.waitMs, 62_000);
	assert.equal(padded.blind, false);

	const floored = planWait({ hint: { at: NOW + 100, source: "header:retry-after" }, now: NOW, attempt: 1, config });
	assert.equal(floored.waitMs, 5_000);
});

test("planWait escalates the blind fallback and respects its ceiling", () => {
	const config = { ...DEFAULT_CONFIG, fallbackWaitMs: 60_000, fallbackFactor: 2, fallbackMaxWaitMs: 200_000 };
	assert.equal(planWait({ hint: undefined, now: NOW, attempt: 1, config }).waitMs, 60_000);
	assert.equal(planWait({ hint: undefined, now: NOW, attempt: 2, config }).waitMs, 120_000);
	assert.equal(planWait({ hint: undefined, now: NOW, attempt: 3, config }).waitMs, 200_000);
	assert.equal(planWait({ hint: undefined, now: NOW, attempt: 1, config }).blind, true);
});

test("planWait caps long waits and flags that the retry may be early", () => {
	const config = { ...DEFAULT_CONFIG, maxWaitMs: 60_000 };
	const plan = planWait({ hint: { at: NOW + 7_200_000, source: "header:x" }, now: NOW, attempt: 1, config });
	assert.equal(plan.waitMs, 60_000);
	assert.equal(plan.capped, true);
});
