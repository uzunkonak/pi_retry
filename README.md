# pi_retry

A [pi](https://pi.dev) extension that waits out provider rate limits instead of failing the
run, then resumes the interrupted work once the limit window reopens.

Pi's own retry budget is deliberately small — 3 attempts, and anything asking for a delay
longer than 60s fails immediately. That is right for a blip and wrong for a five-hour usage
window. This extension picks up where that budget ends: it works out when the window reopens,
sleeps with a live countdown, and restarts the agent from where it stopped.

## Install

```bash
pi install npm:pi_retry
```

Or install from git, or try it for a single run without installing at all:

```bash
pi install git:github.com/uzunkonak/pi_retry
pi -e npm:pi_retry
```

## Use

It works with no configuration. When a run hits a rate limit you get a countdown; press
<kbd>Esc</kbd> to cancel it.

```bash
/retry-limit           # status and current configuration
/retry-limit cancel    # stop waiting, drop the pending retry
/retry-limit now       # skip the wait and resume immediately
/retry-limit wait 5m   # change the fallback wait interval
```

Exhausted credit or billing quota is not retried — that needs a human, so the extension stops
and says so rather than sleeping until the end of the month.

Configuration lives in `~/.pi/agent/retry-limit.json` or `<project>/.pi/retry-limit.json`, with
`PI_RETRY_LIMIT_*` environment overrides. See [docs/reference.md](docs/reference.md) for every
option, how reset times are detected, and the development setup.

## Development

```bash
npm install
npm run check   # typecheck + unit tests
npm run test:e2e
```

## License

[MIT](LICENSE) © Caner Uzunkonak
