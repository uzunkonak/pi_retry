import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_CONFIG, applyRecord } from "../src/config.ts";
import { parseDuration, parseDurationStrict } from "../src/duration.ts";

test("strict duration parsing preserves supported compound and decimal forms", () => {
	for (const [text, expected] of [
		["1h30m", 5_400_000],
		["2h 5m 10s", 7_510_000],
		["1 hour and 30 minutes", 5_400_000],
		["34.5s", 34_500],
		["1500ms", 1_500],
		["0", 0],
		[" 90 ", 90_000],
	] as const) {
		assert.equal(parseDurationStrict(text), expected, text);
	}
	assert.equal(parseDurationStrict("90", 1), 90, "bare config durations stay in milliseconds");
});

test("strict durations reject negatives, partial input, and overflow", () => {
	for (const text of ["-5m", "1h -30m", "1m junk", "wait 5m", "1.2.3s", "", "Infinity", `${"9".repeat(400)}h`]) {
		assert.equal(parseDurationStrict(text), undefined, text);
	}
});

test("provider prose retains permissive duration extraction", () => {
	assert.equal(parseDuration("5 minutes before retrying"), 300_000);
	assert.equal(parseDuration("about 90 seconds"), 90_000);
	assert.equal(parseDuration("9".repeat(400)), undefined);
	assert.equal(parseDuration(`${"9".repeat(400)}s`), undefined);
});

test("invalid config values warn and preserve the previous setting", () => {
	for (const patch of [
		{ fallbackWait: "-5m" },
		{ maxWait: "3s junk" },
		{ minWait: -1 },
		{ padding: Infinity },
		{ fallbackWait: `${"9".repeat(400)}s` },
		{ maxAttempts: "2oops" },
		{ maxAttempts: -1 },
		{ maxAttempts: 1.5 },
		{ maxAttempts: Number.MAX_SAFE_INTEGER + 1 },
		{ fallbackFactor: "1.5oops" },
		{ fallbackFactor: "" },
	]) {
		const config = { ...DEFAULT_CONFIG };
		const warnings: string[] = [];
		applyRecord(config, patch, "test", warnings);
		assert.deepEqual(config, DEFAULT_CONFIG, JSON.stringify(patch));
		assert.equal(warnings.length, 1, JSON.stringify(patch));
	}
});

test("valid config aliases and numeric strings still work", () => {
	const config = { ...DEFAULT_CONFIG };
	const warnings: string[] = [];
	applyRecord(config, { maxAttempts: "0", fallbackWait: "1h30m", paddingMs: "500", fallbackFactor: "1.5" }, "test", warnings);
	assert.equal(config.maxAttempts, 0);
	assert.equal(config.fallbackWaitMs, 5_400_000);
	assert.equal(config.paddingMs, 500);
	assert.equal(config.fallbackFactor, 1.5);
	assert.deepEqual(warnings, []);
});

test("inherited object properties are not config options", () => {
	const config = { ...DEFAULT_CONFIG };
	const warnings: string[] = [];
	applyRecord(config, JSON.parse('{"__proto__":true,"constructor":"x","toString":"x"}'), "test", warnings);
	assert.deepEqual(config, DEFAULT_CONFIG);
	assert.equal(warnings.length, 3);
	assert.ok(warnings.every((message) => message.includes("unknown option")));
});
