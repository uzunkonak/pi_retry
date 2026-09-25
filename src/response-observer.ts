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

/** Shares one wrapper across overlapping installs without dropping listeners. */
const INSTALLED = Symbol.for("pi-retry-limit.fetch-observer");

type FetchLike = typeof globalThis.fetch;
type Listener = { record: (response: ProviderResponse) => void };
interface ObserverState {
	listeners: Set<Listener>;
	restore: () => void;
}
type ObservedFetch = FetchLike & { [INSTALLED]?: ObserverState };

export type ObserverCleanup = () => void;

/** Observe until cleanup, restoring fetch only after the final subscriber leaves. */
export function observeLimitResponses(record: (response: ProviderResponse) => void): ObserverCleanup {
	const original = globalThis.fetch as ObservedFetch;
	if (typeof original !== "function") {
		return () => {};
	}

	let state = original[INSTALLED];
	if (!state || typeof state !== "object") {
		const listeners = new Set<Listener>();
		const wrapped = (async function (this: unknown, ...args: Parameters<FetchLike>) {
			// A new subscriber must not receive responses to an earlier request.
			const recipients = [...listeners];
			const response = await original.apply(this, args);
			try {
				if (isLimitStatus(response.status)) {
					const observed = { status: response.status, headers: toRecord(response.headers), at: Date.now() };
					for (const listener of recipients) {
						if (!listeners.has(listener)) {
							continue;
						}
						try {
							listener.record(observed);
						} catch {
							// One subscriber must not break the request or another subscriber.
						}
					}
				}
			} catch {
				// Observation must never be able to break a provider request.
			}
			return response;
		}) as ObservedFetch;
		state = {
			listeners,
			restore: () => {
				// Do not overwrite a wrapper installed by another extension.
				if (globalThis.fetch === wrapped) {
					globalThis.fetch = original;
				}
			},
		};
		wrapped[INSTALLED] = state;
		globalThis.fetch = wrapped;
	}

	const listener = { record };
	state.listeners.add(listener);
	const subscription = state;
	return () => {
		if (!subscription.listeners.delete(listener)) {
			return;
		}
		if (subscription.listeners.size === 0) {
			subscription.restore();
		}
	};
}

function toRecord(headers: Headers): Record<string, string> {
	const record: Record<string, string> = {};
	headers.forEach((value, key) => {
		record[key.toLowerCase()] = value;
	});
	return record;
}
