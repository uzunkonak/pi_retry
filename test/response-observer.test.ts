import assert from "node:assert/strict";
import { test } from "node:test";
import type { ProviderResponse } from "../src/detect.ts";
import { observeLimitResponses } from "../src/response-observer.ts";

test("observer passes through arguments, receiver, response, and unread body", async (t) => {
	const response = new Response("rate limited", { status: 429, headers: { "Retry-After": "60" } });
	const receiver = {};
	const input = "https://example.invalid/provider";
	const init = { method: "POST" };
	const original = t.mock.method(globalThis, "fetch", async function (this: unknown, ...args: unknown[]) {
		assert.equal(this, receiver);
		assert.deepEqual(args, [input, init]);
		return response;
	});
	const records: ProviderResponse[] = [];
	const stop = observeLimitResponses((record) => records.push(record));
	t.after(stop);
	assert.equal(await globalThis.fetch.call(receiver, input, init), response);
	assert.equal(response.bodyUsed, false);
	assert.equal(records.length, 1);
	assert.equal(records[0].headers["retry-after"], "60");
	stop();
	stop();
	assert.equal(globalThis.fetch, original);
});

test("overlapping observers share a wrapper and unsubscribe independently", async (t) => {
	const original = t.mock.method(globalThis, "fetch", async () => new Response(null, { status: 429 }));
	const first: ProviderResponse[] = [];
	const second: ProviderResponse[] = [];
	const stopFirst = observeLimitResponses((response) => first.push(response));
	const wrapped = globalThis.fetch;
	const stopSecond = observeLimitResponses((response) => second.push(response));
	t.after(stopFirst);
	t.after(stopSecond);
	assert.equal(globalThis.fetch, wrapped, "must not nest another wrapper");
	await fetch("https://example.invalid");
	assert.deepEqual([first.length, second.length], [1, 1]);
	stopFirst();
	stopFirst();
	assert.equal(globalThis.fetch, wrapped, "second observer still needs the wrapper");
	await fetch("https://example.invalid");
	assert.deepEqual([first.length, second.length], [1, 2]);
	stopSecond();
	assert.equal(globalThis.fetch, original);
});

test("cleanup suppresses responses from requests still in flight", async (t) => {
	let finish!: (response: Response) => void;
	t.mock.method(globalThis, "fetch", () => new Promise<Response>((resolve) => { finish = resolve; }));
	const records: ProviderResponse[] = [];
	const stop = observeLimitResponses((response) => records.push(response));
	t.after(stop);
	const request = fetch("https://example.invalid");
	stop();
	const response = new Response(null, { status: 429 });
	finish(response);
	assert.equal(await request, response);
	assert.deepEqual(records, []);
});

test("a new subscriber does not receive an earlier request's response", async (t) => {
	let finish!: (response: Response) => void;
	t.mock.method(globalThis, "fetch", () => new Promise<Response>((resolve) => { finish = resolve; }));
	const first: ProviderResponse[] = [];
	const second: ProviderResponse[] = [];
	const stopFirst = observeLimitResponses((response) => first.push(response));
	t.after(stopFirst);
	const request = fetch("https://example.invalid");
	const stopSecond = observeLimitResponses((response) => second.push(response));
	t.after(stopSecond);
	finish(new Response(null, { status: 429 }));
	await request;
	assert.deepEqual([first.length, second.length], [1, 0]);
});

test("observer failures cannot affect the request or other subscribers", async (t) => {
	const response = new Response(null, { status: 429 });
	t.mock.method(globalThis, "fetch", async () => response);
	const stopFirst = observeLimitResponses(() => { throw new Error("observer failed"); });
	const records: ProviderResponse[] = [];
	const stopSecond = observeLimitResponses((record) => records.push(record));
	t.after(stopFirst);
	t.after(stopSecond);
	assert.equal(await fetch("https://example.invalid"), response);
	assert.equal(records.length, 1);
});

test("cleanup does not overwrite another extension's fetch wrapper", async (t) => {
	t.mock.method(globalThis, "fetch", async () => new Response(null, { status: 429 }));
	const records: ProviderResponse[] = [];
	const stop = observeLimitResponses((response) => records.push(response));
	t.after(stop);
	const ours = globalThis.fetch;
	const theirs: typeof fetch = (...args) => ours(...args);
	globalThis.fetch = theirs;
	stop();
	assert.equal(globalThis.fetch, theirs);
	await fetch("https://example.invalid");
	assert.deepEqual(records, [], "the retained inner wrapper must be inert");
});

test("successful responses are ignored and fetch rejections are preserved", async (t) => {
	const failure = new Error("network failure");
	let fail = false;
	t.mock.method(globalThis, "fetch", async () => {
		if (fail) {
			throw failure;
		}
		return new Response(null, { status: 200 });
	});
	const records: ProviderResponse[] = [];
	const stop = observeLimitResponses((response) => records.push(response));
	t.after(stop);
	await fetch("https://example.invalid");
	fail = true;
	await assert.rejects(fetch("https://example.invalid"), (error: unknown) => error === failure);
	assert.deepEqual(records, []);
});
