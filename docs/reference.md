# pi_retry — reference

A [pi](https://pi.dev) extension that waits out provider rate limits instead of failing the
run, then resumes the interrupted work once the limit window reopens.

## Why

Pi already retries transient errors, but that budget is deliberately small: `retry.maxRetries`
defaults to 3 attempts with 2s/4s/8s backoff, and a provider that asks for a delay longer than
`retry.provider.maxRetryDelayMs` (60s) fails immediately rather than waiting silently. That is
the right default for a blip. It is the wrong default for a five-hour usage window, an hourly
throttle, or a Copilot premium-request cap, where the correct move is to wait and carry on.

This extension picks up where pi's retry budget ends. When a run finally settles on a
rate-limit error it works out when the window reopens, sleeps with a live countdown, and
restarts the agent from where it stopped.

## Install

```bash
pi install npm:pi_retry                       # published package
pi install git:github.com/uzunkonak/pi_retry  # straight from the repo
pi install /path/to/pi_retry                  # local checkout
```

Or try it for one run without installing:

```bash
pi -e npm:pi_retry
pi -e /path/to/pi_retry/extensions/retry-limit.ts
```

## How it works

```
run ends on an error
      │
      ├─ classify the error text ──── not a limit ─────────────► do nothing
      │                          └── exhausted quota ─────────► stop, tell the user
      │
      ├─ find the reset time
      │     1. rate-limit response headers  (retry-after, *-ratelimit-*-reset)
      │     2. the provider's error prose   ("try again in 4m12s", "resets at 3:00 PM")
      │     3. blind fallback               (60s, escalating to 15m)
      │
      ├─ sleep with a countdown ──── Esc / /retry-limit cancel ─► give up
      │
      └─ drop the failed turn from context, inject a resume message, run again
            └─ limited again? repeat.
```

**Rate limit vs. quota.** A rate limit is a window that reopens on its own, so waiting works.
Exhausted credit or billing quota needs a human, so the extension stops and says so rather than
sleeping until the end of the month. Set `retryOnQuotaExhausted` if you want it to wait anyway.

**Recovering the reset headers.** `retry-after` is the most precise signal there is, but pi's
`after_provider_response` hook never sees it: the Anthropic and OpenAI SDKs throw on a 429
before a response object reaches pi, so the hook only fires on success. To get those headers
back, the extension installs a pass-through wrapper around `globalThis.fetch` that reads the
status and headers of limit-shaped responses (429/402/403/529) and changes nothing else — the
response is returned untouched and its body is never consumed. Turn it off with
`observeResponses: false` and the extension falls back to parsing the error text.

**Blocking on purpose.** The wait happens inside pi's `agent_settled` hook, which pi awaits as
part of the prompt call. That keeps `pi -p` runs and RPC callers alive for the whole wait
instead of letting them exit on the rate-limit error.

**Context hygiene.** A failed turn stays in the transcript for history, but replaying it to the
provider is at best noise and at worst a hard 400 (an assistant message with empty content, or
a tool call that never got a result). The extension drops those from the resumed request, the
same thing pi does internally for its own retries.

## Commands

| Command | Effect |
|---|---|
| `/retry-limit` or `/retry-limit status` | Show configuration and any wait in progress |
| `/retry-limit cancel` | Stop waiting and drop the pending retry |
| `/retry-limit now` | Skip the remaining wait and resume immediately |
| `/retry-limit on` / `off` | Toggle for this session |
| `/retry-limit wait 5m` | Change the blind fallback interval |
| `/retry-limit <option> <value>` | Set any config option for this session |

Pressing <kbd>Esc</kbd> during a countdown cancels it.

## Configuration

Layered, later wins:

```
defaults → ~/.pi/agent/retry-limit.json → <project>/.pi/retry-limit.json → PI_RETRY_LIMIT_* env
```

Durations accept milliseconds or a string (`"90s"`, `"15m"`, `"2h"`, `"1h30m"`).

```jsonc
{
  "enabled": true,               // master switch; --no-retry-limit disables per run
  "maxAttempts": 0,              // consecutive resumes before giving up; 0 = unlimited
  "minWait": "5s",               // never retry sooner than this
  "maxWait": 0,                  // cap on one wait; 0 = sleep the whole window
  "padding": "2s",               // slack added to a parsed reset time, for clock skew
  "fallbackWait": "60s",         // used when no reset time can be found
  "fallbackFactor": 1.5,         // growth per consecutive blind attempt
  "fallbackMaxWait": "15m",      // ceiling for the blind wait
  "retryOnQuotaExhausted": false,// also wait out exhausted credit/billing quota
  "pruneErrorMessages": true,    // drop failed turns from the resumed request
  "observeResponses": true,      // wrap fetch to recover rate-limit headers
  "showResumeMessage": true,     // show the resume message in the transcript
  "notify": true,                // status notifications (errors are always shown)
  "resumePrompt": "..."          // the message used to restart the work
}
```

Environment overrides use the same names: `PI_RETRY_LIMIT_ENABLED`,
`PI_RETRY_LIMIT_MAX_ATTEMPTS`, `PI_RETRY_LIMIT_MIN_WAIT`, `PI_RETRY_LIMIT_MAX_WAIT`,
`PI_RETRY_LIMIT_PADDING`, `PI_RETRY_LIMIT_FALLBACK_WAIT`, `PI_RETRY_LIMIT_FALLBACK_FACTOR`,
`PI_RETRY_LIMIT_FALLBACK_MAX_WAIT`, `PI_RETRY_LIMIT_QUOTA`, `PI_RETRY_LIMIT_PRUNE_ERRORS`,
`PI_RETRY_LIMIT_OBSERVE_RESPONSES`, `PI_RETRY_LIMIT_SHOW_RESUME`, `PI_RETRY_LIMIT_NOTIFY`,
`PI_RETRY_LIMIT_PROMPT`.

### Interaction with pi's own retry

Leave pi's settings alone and the two compose: pi burns its 3 quick attempts on the blip case,
and this extension takes over for the real window. If you would rather not wait through
2s/4s/8s of pointless retries before the long wait starts, set `retry.maxRetries` to `0` in
`settings.json`.

Keep `retry.provider.maxRetries` at `0` (the default). Above zero, the SDK retries inside the
request and can block on a rate limit before pi — and therefore this extension — ever sees it.

## Development

```bash
npm install
npm run typecheck   # tsc against the real pi type definitions
npm test            # unit tests for classification, header/prose parsing, wait planning
npm run test:e2e    # runs the real `pi` binary against a fake 429 endpoint
```

The end-to-end suite starts a local Anthropic-compatible server that returns 429 for the first
N requests, then runs `pi -p` with the extension loaded and asserts the exit code, the number
of provider requests, and the elapsed time:

```
PASS  retry-after header             2 request(s), 9.9s, exit 0
PASS  two consecutive limits         3 request(s), 11.3s, exit 0
PASS  delay parsed from error text   2 request(s), 9.4s, exit 0
PASS  exhausted quota is not retried 1 request(s), 1.0s, exit 1
```

## Layout

```
extensions/retry-limit.ts   hooks, countdown UI, commands, the wait/resume loop
src/detect.ts               error classification, header and prose reset parsing
src/plan.ts                 reset hint + config -> a concrete wait
src/config.ts               layered configuration
src/duration.ts             duration parsing and formatting
src/response-observer.ts    fetch wrapper that recovers rate-limit headers
test/                       unit tests, e2e harness, fake provider extension
```
