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
pi install npm:@uzunkonak/pi_retry            # published package
pi install git:github.com/uzunkonak/pi_retry  # straight from the repo
pi install /path/to/pi_retry                  # local checkout
```

Or try it for one run without installing:

```bash
pi -e npm:@uzunkonak/pi_retry
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
      │     2. the provider's error prose   ("try again in ~109 min",
      │                                      "resets 11:30pm (Europe/Istanbul)")
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
Context-length/window errors are not treated as rate limits: waiting cannot make the same
oversized request fit, so those remain pi's responsibility.

**Subscription wording.** Consumer plans rarely say "rate limit". ChatGPT/Codex reports
`You have hit your ChatGPT usage limit (plus plan). Try again in ~109 min.` or
`You've hit your session limit · resets 11:30pm (Europe/Istanbul)`, and Claude says
`Your limit will reset at 3pm (Europe/Istanbul)`. All of these are recognised: hedged delays
(`~`, `about`, `roughly`), preposition-less resets (`resets 11:30pm`), hour-only clock times
(`3pm`), and a trailing IANA timezone, which is resolved properly instead of being read as
local time. A wall-clock time that has already passed today is taken as tomorrow's occurrence.

**Recovering the reset headers.** `retry-after` is the most precise signal there is, but pi's
`after_provider_response` hook never sees it: the Anthropic and OpenAI SDKs throw on a 429
before a response object reaches pi, so the hook only fires on success. To get those headers
back, the extension installs a pass-through wrapper around `globalThis.fetch` that reads the
status and headers of limit-shaped responses (429/402/403/529) and changes nothing else — the
response is returned untouched and its body is never consumed. Turn it off with
`observeResponses: false` and the extension falls back to parsing the error text.
Relative delays count from when the response arrived, not from when pi finishes retrying.
Cached headers are cleared before each new provider request. Overlapping observers share
one wrapper and unsubscribe independently; shutdown also suppresses their in-flight callbacks.

**Where the wait happens.** In `pi -p`, JSON, and RPC modes the wait blocks inside pi's
`agent_settled` hook, which pi awaits as part of the prompt call. That is deliberate: it keeps
those runs alive for the whole wait instead of letting them exit on the rate-limit error.

In the TUI it must not block, and that is not a matter of taste. The interactive main loop is
`await getUserInput()` → `await session.prompt()`, and it only accepts keyboard submissions
while parked on the first half. Blocking inside `agent_settled` keeps it parked on the second
half, where pi has already cleared its "streaming" flag — so submitted text takes neither the
streaming path (which dispatches extension commands immediately) nor the idle path, and is
silently pushed onto a pending-input queue that is not drained until the wait ends. The
symptom is `/retry-limit now`, `/retry-limit cancel`, and every other command doing nothing
at all for the whole countdown and then all firing at once. So in the TUI the countdown runs
on a timer, `agent_settled` returns immediately, and the resume is injected with
`pi.sendMessage(..., { triggerTurn: true })` when the window reopens. Override with
`waitMode`.

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
Config and command durations must be non-negative, finite, and contain only a duration;
invalid values such as `"-5m"` or `"5m junk"` warn and leave the previous setting unchanged.
`maxAttempts` must be a non-negative safe integer; `0` still means unlimited.
These checks do not restrict duration extraction from provider error prose.

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
  "waitMode": "auto",            // auto | detached | blocking; see "Where the wait happens"
  "showResumeMessage": true,     // show the resume message in the transcript
  "notify": true,                // status notifications (errors are always shown)
  "resumePrompt": "..."          // the message used to restart the work
}
```

Environment overrides use the same names: `PI_RETRY_LIMIT_ENABLED`,
`PI_RETRY_LIMIT_MAX_ATTEMPTS`, `PI_RETRY_LIMIT_MIN_WAIT`, `PI_RETRY_LIMIT_MAX_WAIT`,
`PI_RETRY_LIMIT_PADDING`, `PI_RETRY_LIMIT_FALLBACK_WAIT`, `PI_RETRY_LIMIT_FALLBACK_FACTOR`,
`PI_RETRY_LIMIT_FALLBACK_MAX_WAIT`, `PI_RETRY_LIMIT_QUOTA`, `PI_RETRY_LIMIT_PRUNE_ERRORS`,
`PI_RETRY_LIMIT_OBSERVE_RESPONSES`, `PI_RETRY_LIMIT_WAIT_MODE`, `PI_RETRY_LIMIT_SHOW_RESUME`,
`PI_RETRY_LIMIT_NOTIFY`, `PI_RETRY_LIMIT_PROMPT`.

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
npm test            # config, classification, reset parsing, observers, wait planning/mode
npm run test:e2e    # runs the real `pi` binary against a fake 429 endpoint
```

`test/wait-mode.test.ts` drives the extension against a fake extension host and asserts the
thing that is easy to break by accident: that `agent_settled` returns immediately in the TUI,
that `/retry-limit now` and `cancel` work *during* a countdown, and that non-TUI modes still
block.

`test/config.test.ts` covers config/command duration validation separately from permissive
provider prose parsing. `test/response-observer.test.ts` checks transparent fetch forwarding,
overlapping subscriptions, in-flight cleanup, and coexistence with another fetch wrapper.

The end-to-end suite starts a local Anthropic-compatible server that returns 429 for the first
N requests, then runs `pi -p` with the extension loaded and asserts the exit code, the number
of provider requests, and the elapsed time:

```
PASS  retry-after header             2 request(s), 8.8s, exit 0
PASS  two consecutive limits         3 request(s), 10.7s, exit 0
PASS  delay parsed from error text   2 request(s), 8.7s, exit 0
PASS  chatgpt usage limit            2 request(s), 8.7s, exit 0
PASS  chatgpt session limit          2 request(s), 10.8s, exit 0
PASS  exhausted quota is not retried 1 request(s), 0.4s, exit 1
```

## Layout

```
extensions/retry-limit.ts   hooks, countdown UI, commands, the wait/resume drivers
src/detect.ts               error classification, header and prose reset parsing
src/plan.ts                 reset hint + config -> a concrete wait
src/config.ts               layered configuration
src/duration.ts             duration parsing and formatting
src/response-observer.ts    fetch wrapper that recovers rate-limit headers
test/                       unit tests, fake extension host, e2e harness, fake provider
```
