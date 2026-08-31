/**
 * Turns a reset hint (or the absence of one) into a concrete wait.
 * Kept separate from the extension so the arithmetic is directly testable.
 */

import type { RetryLimitConfig } from "./config.ts";
import type { ResetHint } from "./detect.ts";

export interface WaitPlan {
	/** How long to sleep, in milliseconds. */
	waitMs: number;
	/** Epoch milliseconds at which the resume fires. */
	resumeAt: number;
	/** Provenance of the wait: a header, the error text, or the blind fallback. */
	source: string;
	/** True when `maxWaitMs` shortened the wait, so the retry may still be early. */
	capped: boolean;
	/** True when no reset time was discoverable and the fallback interval was used. */
	blind: boolean;
}

export function planWait(options: {
	hint: ResetHint | undefined;
	now: number;
	/** 1-based count of consecutive resume attempts, used to escalate blind waits. */
	attempt: number;
	config: RetryLimitConfig;
}): WaitPlan {
	const { hint, now, attempt, config } = options;

	let waitMs: number;
	let source: string;
	const blind = hint === undefined;

	if (hint) {
		waitMs = hint.at + config.paddingMs - now;
		source = hint.source;
	} else {
		const factor = config.fallbackFactor > 0 ? config.fallbackFactor : 1;
		const escalated = config.fallbackWaitMs * factor ** Math.max(0, attempt - 1);
		waitMs = config.fallbackMaxWaitMs > 0 ? Math.min(escalated, config.fallbackMaxWaitMs) : escalated;
		source = "fallback";
	}

	waitMs = Math.max(waitMs, config.minWaitMs);

	let capped = false;
	if (config.maxWaitMs > 0 && waitMs > config.maxWaitMs) {
		waitMs = config.maxWaitMs;
		capped = true;
	}

	waitMs = Math.round(waitMs);
	return { waitMs, resumeAt: now + waitMs, source, capped, blind };
}
