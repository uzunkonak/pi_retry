# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- Context-length and context-window errors are no longer mistaken for resetting rate
  limits, avoiding repeated waits for a request that needs a smaller context.
- Relative reset headers count from response receipt, rather than adding the full delay
  again after pi's own retries. Cached headers are cleared before new provider requests.
- `/retry-limit enabled false` cancels an active countdown, just like `/retry-limit off`.
- Invalid config/command durations (such as `-5m` or overflowing values) and invalid
  attempt counts now produce warnings instead of silently becoming different values.
  Provider error prose retains its permissive duration parsing.
- Overlapping fetch observers receive responses independently; cleanup stops callbacks
  from in-flight requests without removing another subscriber or another extension's wrapper.

### Tests

- Added regression coverage for configuration validation, header timing, false-positive
  classification, countdown controls, and fetch-observer cleanup.
- Test harness disposal now invokes extension shutdown to clean up timers and observers.

## [0.2.0] - 2026-09-01

### Fixed

- **Commands were dead during a wait.** `/retry-limit now`, `/retry-limit cancel`, and every
  other command did nothing for the whole countdown, then fired all at once when it ended.
  The wait blocked inside `agent_settled`, which pi awaits as part of the prompt call, so the
  interactive main loop never returned to `getUserInput()` and submitted text was queued
  rather than dispatched. In the TUI the countdown now runs on a timer and `agent_settled`
  returns immediately; `pi -p`, JSON, and RPC modes still block, since that is what keeps
  them alive. Force either with the new `waitMode` option.
- Decimal delays were truncated to their integer part (`"in 1.5 hours"` was read as one
  hour), because the decimal point was treated as the end of the sentence.
- The countdown no longer arms a single long `setTimeout`, which fires immediately past
  2^31-1 ms — reachable from a seven-day reset header.

### Added

- ChatGPT/Codex and Claude subscription wording is now recognised. Previously
  `You've hit your session limit · resets 11:30pm (Europe/Istanbul)` was not classified as a
  limit at all, and `Try again in ~109 min` produced no reset time, so the run fell back to
  blind polling. Newly understood:
  - `session limit`, `5h limit`, `plan limit`, `hit your … limit`, `used up your … limit`,
    and `limit has been reached`
  - hedged delays: `~109 min`, `about 5 minutes`, `roughly`, `around`, `under`, `up to`
  - preposition-less resets: `resets 11:30pm`, `resets in 1 hour 49 minutes`
  - hour-only clock times: `will reset at 3pm`
  - `today`/`tomorrow` qualifiers
- Trailing IANA timezones (`(Europe/Istanbul)`) are resolved in that zone rather than being
  read as local time, including across DST boundaries. A non-timezone parenthetical such as
  `(plus plan)` is ignored.
- `waitMode` config option (`auto`, `detached`, `blocking`) and `PI_RETRY_LIMIT_WAIT_MODE`.
- `/retry-limit status` reports the remaining wait and the active `waitMode`.

## [0.1.0] - 2026-08-31

First release.

### Added

- Waits out provider rate limits instead of failing the run, then resumes the interrupted
  work once the window reopens.
- Reset-time detection from three sources, in order of precision: rate-limit response
  headers (`retry-after`, `*-ratelimit-*-reset`), the provider's error prose ("try again in
  4m12s", "resets at 3:00 PM"), and a blind fallback that escalates from 60s to 15m.
- A `fetch` pass-through wrapper that recovers rate-limit headers the SDKs would otherwise
  swallow when they throw on a 429. Disable with `observeResponses: false`.
- Rate limits and exhausted quota are classified separately. A window that reopens is worth
  waiting for; exhausted credit needs a human, so the run stops and says so. Override with
  `retryOnQuotaExhausted`.
- Live countdown during the wait, cancellable with <kbd>Esc</kbd>.
- `/retry-limit` commands: `status`, `cancel`, `now`, `on`, `off`, `wait <duration>`, and
  per-session overrides for any config option.
- Layered configuration: defaults, `~/.pi/agent/retry-limit.json`,
  `<project>/.pi/retry-limit.json`, then `PI_RETRY_LIMIT_*` environment variables.
- Failed turns are pruned from the resumed request, so a retried run does not replay an
  empty assistant message or an orphaned tool call to the provider.

[0.2.0]: https://github.com/uzunkonak/pi_retry/releases/tag/v0.2.0
[0.1.0]: https://github.com/uzunkonak/pi_retry/releases/tag/v0.1.0
