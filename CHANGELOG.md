# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

[0.1.0]: https://github.com/uzunkonak/pi_retry/releases/tag/v0.1.0
