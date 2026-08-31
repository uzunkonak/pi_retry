/**
 * Duration parsing and formatting shared by the config loader, the header/message
 * parsers, and the countdown UI.
 */

const UNIT_MS: Record<string, number> = {
	ms: 1,
	millisecond: 1,
	milliseconds: 1,
	s: 1_000,
	sec: 1_000,
	secs: 1_000,
	second: 1_000,
	seconds: 1_000,
	m: 60_000,
	min: 60_000,
	mins: 60_000,
	minute: 60_000,
	minutes: 60_000,
	h: 3_600_000,
	hr: 3_600_000,
	hrs: 3_600_000,
	hour: 3_600_000,
	hours: 3_600_000,
	d: 86_400_000,
	day: 86_400_000,
	days: 86_400_000,
};

// Longest alternatives first so "ms" never gets split into "m" + "s". The trailing
// lookahead rejects longer words but still allows digit-adjacent units like "6m0s".
const DURATION_PART =
	/(\d+(?:\.\d+)?)\s*(milliseconds|millisecond|ms|seconds|second|secs|sec|minutes|minute|mins|min|hours|hour|hrs|hr|days|day|s|m|h|d)(?![a-z])/gi;

/**
 * Parse a duration string into milliseconds.
 *
 * Accepts compound forms ("1h30m", "6m0s", "2h 5m 10s"), decimals ("34.5s"),
 * and bare numbers, which are read as seconds unless `bareUnitMs` says otherwise.
 * Returns undefined when nothing parseable is found.
 */
export function parseDuration(input: string, bareUnitMs = 1_000): number | undefined {
	const text = input.trim();
	if (text.length === 0) return undefined;

	if (/^\d+(\.\d+)?$/.test(text)) return Number.parseFloat(text) * bareUnitMs;

	DURATION_PART.lastIndex = 0;
	let total = 0;
	let matched = false;
	for (;;) {
		const part = DURATION_PART.exec(text);
		if (!part) break;
		const unit = UNIT_MS[part[2].toLowerCase()];
		if (unit === undefined) continue;
		total += Number.parseFloat(part[1]) * unit;
		matched = true;
	}
	return matched ? total : undefined;
}

/** Human-readable countdown text: "38s", "4m 12s", "3h 07m", "2d 4h". */
export function formatDuration(ms: number): string {
	const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
	if (totalSeconds < 60) return `${totalSeconds}s`;

	const seconds = totalSeconds % 60;
	const totalMinutes = Math.floor(totalSeconds / 60);
	if (totalMinutes < 60) return `${totalMinutes}m ${pad(seconds)}s`;

	const minutes = totalMinutes % 60;
	const totalHours = Math.floor(totalMinutes / 60);
	if (totalHours < 24) return `${totalHours}h ${pad(minutes)}m`;

	const hours = totalHours % 24;
	return `${Math.floor(totalHours / 24)}d ${hours}h`;
}

/** Local wall-clock time, used to tell the user when the wait ends. */
export function formatClock(timestamp: number): string {
	return new Date(timestamp).toLocaleTimeString(undefined, {
		hour: "2-digit",
		minute: "2-digit",
	});
}

function pad(value: number): string {
	return value < 10 ? `0${value}` : String(value);
}
