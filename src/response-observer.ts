/**
 * Recovers rate-limit headers that pi's `after_provider_response` hook cannot see.
 *
 * That hook only fires once a provider request has *succeeded* — the Anthropic and
 * OpenAI SDKs throw on a 429 before pi ever gets a response object, so exactly the
 * headers we care about (`retry-after`, `*-ratelimit-*-reset`) are dropped. This
 * installs a pass-through wrapper around `globalThis.fetch` that reads the status
 * and headers of limit-shaped responses and otherwise changes nothing: the original
 * response object is returned untouched and its body is never consumed.
 */

import { type ProviderResponse, isLimitStatus } from "./detect.ts";

/** Marks our wrapper so repeated installs (e.g. `/reload`) do not nest. */
const INSTALLED = Symbol.for("pi-retry-limit.fetch-observer");

type FetchLike = typeof globalThis.fetch;

export type ObserverCleanup = () => void;

/**
 * Start observing. Returns a cleanup function that restores the previous fetch,
 * or a no-op when there is nothing to patch or an observer is already active.
 */
export function observeLimitResponses(record: (response: ProviderResponse) => void): ObserverCleanup {
	const original = globalThis.fetch;
	if (typeof original !== "function") return () => {};

	const marked = original as FetchLike & { [INSTALLED]?: true };
	if (marked[INSTALLED]) return () => {};

	const wrapped = (async (input, init) => {
		const response = await original(input, init);
		try {
			if (isLimitStatus(response.status)) {
				record({ status: response.status, headers: toRecord(response.headers), at: Date.now() });
			}
		} catch {
			// Observation must never be able to break a provider request.
		}
		return response;
	}) as FetchLike & { [INSTALLED]?: true };

	wrapped[INSTALLED] = true;
	globalThis.fetch = wrapped;

	return () => {
		if (globalThis.fetch === wrapped) globalThis.fetch = original;
	};
}

function toRecord(headers: Headers): Record<string, string> {
	const record: Record<string, string> = {};
	headers.forEach((value, key) => {
		record[key.toLowerCase()] = value;
	});
	return record;
}
