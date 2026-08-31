/**
 * End-to-end checks against the real `pi` binary.
 *
 * Serves a fake Anthropic-compatible endpoint whose first N requests fail, then
 * runs `pi -p` with the extension loaded and asserts what happened: whether the
 * run recovered, how many provider requests it took, and how long it waited.
 *
 * Usage: node test/e2e.mjs [scenario-name]
 */

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const ANSWER = "pong-after-rate-limit";
const RUN_TIMEOUT_MS = 90_000;

/** Body shapes the fake provider can fail with. */
const FAILURES = {
	rateLimit: {
		type: "error",
		error: { type: "rate_limit_error", message: "Number of requests has exceeded your rate limit" },
	},
	quota: {
		type: "error",
		error: { type: "invalid_request_error", message: "insufficient_quota: your credit balance is too low" },
	},
	textualDelay: {
		type: "error",
		error: { type: "rate_limit_error", message: "Rate limit reached. Please try again in 6s." },
	},
};

const SCENARIOS = [
	{
		name: "retry-after header",
		failures: 1,
		body: FAILURES.rateLimit,
		headers: { "retry-after": "6" },
		expect: { code: 0, answer: true, requests: 2, minSeconds: 6, maxSeconds: 20 },
	},
	{
		name: "two consecutive limits",
		failures: 2,
		body: FAILURES.rateLimit,
		headers: { "retry-after": "3" },
		expect: { code: 0, answer: true, requests: 3, minSeconds: 8, maxSeconds: 25 },
	},
	{
		name: "delay parsed from error text",
		failures: 1,
		body: FAILURES.textualDelay,
		headers: {},
		expect: { code: 0, answer: true, requests: 2, minSeconds: 6, maxSeconds: 20 },
	},
	{
		name: "exhausted quota is not retried",
		failures: 99,
		body: FAILURES.quota,
		headers: {},
		expect: { code: 1, answer: false, requests: 1, minSeconds: 0, maxSeconds: 20 },
	},
];

async function startServer(scenario) {
	const requests = [];
	const server = createServer((req, res) => {
		req.resume();
		req.on("end", () => {
			const index = requests.length;
			requests.push(Date.now());

			if (index < scenario.failures) {
				res.writeHead(429, { "content-type": "application/json", ...scenario.headers });
				res.end(JSON.stringify(scenario.body));
				return;
			}
			res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
			for (const frame of streamFrames()) res.write(frame);
			res.end();
		});
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	return { server, requests, port: server.address().port };
}

function streamFrames() {
	const frame = (type, data) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
	return [
		frame("message_start", {
			type: "message_start",
			message: {
				id: "msg_fake",
				type: "message",
				role: "assistant",
				model: "fake-model",
				content: [],
				stop_reason: null,
				stop_sequence: null,
				usage: { input_tokens: 10, output_tokens: 1 },
			},
		}),
		frame("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
		frame("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: ANSWER } }),
		frame("content_block_stop", { type: "content_block_stop", index: 0 }),
		frame("message_delta", {
			type: "message_delta",
			delta: { stop_reason: "end_turn", stop_sequence: null },
			usage: { output_tokens: 5 },
		}),
		frame("message_stop", { type: "message_stop" }),
	];
}

function makeWorkdir() {
	const workdir = mkdtempSync(join(tmpdir(), "pi-retry-limit-"));
	mkdirSync(join(workdir, ".pi"), { recursive: true });
	// Disable pi's own bounded retry so the extension is the only thing that can
	// rescue the run, keeping request counts and timings unambiguous.
	writeFileSync(join(workdir, ".pi", "settings.json"), JSON.stringify({ retry: { enabled: false } }));
	writeFileSync(join(workdir, ".pi", "retry-limit.json"), JSON.stringify({ minWait: "1s", fallbackWait: "5s" }));
	return workdir;
}

async function runScenario(scenario) {
	const { server, requests, port } = await startServer(scenario);
	const workdir = makeWorkdir();
	const started = Date.now();

	const child = spawn(
		"pi",
		[
			"-p",
			"Say pong.",
			"--provider",
			"ratelimit-test",
			"--model",
			"fake-model",
			"--no-tools",
			"--no-session",
			"--offline",
			"--approve",
			"-e",
			join(projectRoot, "test", "fake-provider.ts"),
			"-e",
			join(projectRoot, "extensions", "retry-limit.ts"),
		],
		{
			cwd: workdir,
			// stdin must be closed: pi -p reads piped stdin and would block on an open pipe.
			stdio: ["ignore", "pipe", "pipe"],
			env: {
				...process.env,
				FAKE_PROVIDER_URL: `http://127.0.0.1:${port}`,
				FAKE_PROVIDER_KEY: "test-key",
				PI_OFFLINE: "1",
			},
		},
	);

	let stdout = "";
	let stderr = "";
	child.stdout.on("data", (chunk) => {
		stdout += chunk;
	});
	child.stderr.on("data", (chunk) => {
		stderr += chunk;
	});

	const killer = setTimeout(() => child.kill("SIGKILL"), RUN_TIMEOUT_MS);
	const code = await new Promise((resolve) => child.on("close", resolve));
	clearTimeout(killer);
	server.close();
	rmSync(workdir, { recursive: true, force: true });

	const seconds = (Date.now() - started) / 1000;
	const failures = [];
	const { expect } = scenario;
	if (code !== expect.code) failures.push(`exit code ${code}, expected ${expect.code}`);
	if (stdout.includes(ANSWER) !== expect.answer) failures.push(`answer present=${stdout.includes(ANSWER)}`);
	if (requests.length !== expect.requests) failures.push(`${requests.length} provider requests, expected ${expect.requests}`);
	if (seconds < expect.minSeconds) failures.push(`finished in ${seconds.toFixed(1)}s, expected >= ${expect.minSeconds}s`);
	if (seconds > expect.maxSeconds) failures.push(`took ${seconds.toFixed(1)}s, expected <= ${expect.maxSeconds}s`);

	return { failures, seconds, requests: requests.length, code, stdout, stderr };
}

const only = process.argv[2];
const scenarios = only ? SCENARIOS.filter((s) => s.name.includes(only)) : SCENARIOS;
let failed = 0;

for (const scenario of scenarios) {
	const result = await runScenario(scenario);
	const status = result.failures.length === 0 ? "PASS" : "FAIL";
	if (result.failures.length > 0) failed++;
	console.log(
		`${status}  ${scenario.name.padEnd(30)} ${result.requests} request(s), ${result.seconds.toFixed(1)}s, exit ${result.code}`,
	);
	for (const failure of result.failures) console.log(`      ${failure}`);
	if (result.failures.length > 0) {
		console.log(`      stdout: ${result.stdout.trim().split("\n").join(" | ")}`);
		console.log(`      stderr: ${result.stderr.trim().split("\n").join(" | ")}`);
	}
}

console.log(failed === 0 ? `\nAll ${scenarios.length} scenario(s) passed.` : `\n${failed} scenario(s) failed.`);
process.exit(failed === 0 ? 0 : 1);
