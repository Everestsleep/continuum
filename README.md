# continuum

Keep Claude Code sessions running through rate limits — schedule a one-shot resume of every interrupted session for when your 5h limit lifts, then walk away.

## The walk-away workflow

```bash
# At 11pm, you hit the 5h limit. You have 5 sessions open. Run:
continuum resume-all --at 4:10am

# Output:
#   Found 5 interrupted session(s):
#     1. [open] Anterior Implant     ~/dev  (1.8MB, 4m ago)
#     2. [open] Multi Tenant 2       ~/dev  (2.5MB, 22m ago)
#     ...
#   Scheduled to resume 5 session(s) at Tue 4:10 AM (in 5h 10m).
#     PID:    71489
#     Log:    ~/.continuum/scheduled-...log
#     Cancel: kill 71489
#   Safe to close this terminal — caffeinate keeps the machine awake until then.

# Close the laptop. At 4:10am, all 5 sessions resume automatically.
```

## What it does

1. **Scans for interrupted sessions** — finds JSONL files modified within the last hour that didn't end on a clean `assistant.stop_reason: end_turn`. Skips noise (claude-mem observers, orc sub-agent worktrees) by default.
2. **Schedules a one-shot resume** — uses `nohup + caffeinate` so closing the terminal doesn't kill it and the Mac stays awake until the timer fires.
3. **Resumes each session sequentially** — runs `continuum <id>` per session, which loops `claude --resume <id> -p continue` with auto-compact at 80% and rate-limit retry.

> **Honest caveat:** Claude Code doesn't write the actual 429 to the JSONL — the API client catches it and the file just stops growing. So we use *recently active + didn't end cleanly* as the proxy for "rate-limited." Works in practice, but the filter isn't strictly "rate-limited only."

## Install

### macOS / Linux

```bash
curl -fsSL https://raw.githubusercontent.com/Everestsleep/continuum/main/install.sh | bash
```

### Windows (PowerShell)

```powershell
irm https://raw.githubusercontent.com/Everestsleep/continuum/main/install.ps1 | iex
```

Both installers:
- Verify Node 18+ is present
- Clone (or update) into `~/.continuum`
- Build the TypeScript
- Drop a `continuum` shim onto your PATH

Requires: **Node.js 18+** and the `claude` CLI on PATH.

## Commands

```bash
continuum scan [--within Nh]
    List interrupted sessions. Default: last 1 hour.

continuum resume-all [--at <time>] [--within Nh] [--yes] [--dry-run]
    Resume every session scan would list.
    With --at, schedules a one-shot for that time.
    Without --at, requires --yes to actually fire.

continuum <session-id> [initial-prompt]
    Run the resume loop on one session manually.
    Auto-compacts at 80%, retries through rate limits, stops on <<TASK_COMPLETE>>.
```

### Examples

```bash
# See what's interrupted right now
continuum scan
continuum scan --within 6h

# Walk-away: schedule for 4:10am
continuum resume-all --at 4:10am

# Or relative time
continuum resume-all --at "in 30m"

# Resume immediately, no prompt
continuum resume-all --yes

# One specific session
continuum 0134c106-cb75-4055-9016-e3b2f2483897
```

### Flags

| Flag | Default | What it does |
|---|---|---|
| `--threshold <0-1>` | `0.8` | Compact when context usage crosses this ratio |
| `--window <n>` | `1000000` | Context window in tokens (set to `200000` for non-1M models) |
| `--sentinel <str>` | `<<TASK_COMPLETE>>` | Stop loop when this string appears in stdout |
| `--max-iter <n>` | infinite | Hard cap on iterations |
| `--model <alias>` | session default | `opus`, `sonnet`, `haiku`, or full model name |
| `--permission-mode <m>` | `bypassPermissions` | Passed through to `claude` |
| `--fallback-wait <sec>` | `600` | Sleep duration if rate-limit reset can't be parsed |
| `--cwd <path>` | autodetect | Hint for finding the session file |
| `-h, --help` | | Show help |
| `-v, --version` | | Show version |

## How it works

```
loop:
  spawn `claude --resume <id> -p <prompt>`
  on stdout contains <<TASK_COMPLETE>> → exit 0
  on stderr contains rate-limit       → sleep until reset → retry same prompt
  on context > threshold              → next prompt = "/compact then continue"
  else                                → next prompt = "continue"
```

## Tips

- **Tell the agent how to stop.** Either bake the sentinel into your initial prompt (`"...emit <<TASK_COMPLETE>> when done"`) or set a `--max-iter` cap.
- **Use a worktree.** If the loop is going to make commits unattended, run it from an isolated git worktree so you can review/revert atomically.
- **Pair with `tmux`/`screen`.** `continuum` is happy to run for hours — detach the terminal and check back later.
- **Logs.** Stdout is the model's output; stderr is `[continuum HH:MM:SS]` status lines. Tee both to a file: `continuum <id> 2>&1 | tee continuum.log`.

## Verify it works

After install, run the bundled test suite — 20 tests cover rate-limit detection, token counting, session file lookup, and end-to-end loop behavior against a mock `claude` binary:

```bash
cd ~/.continuum && npm test
```

You should see:

```
✔ integration: stops on sentinel after one normal turn
✔ integration: injects /compact when context exceeds threshold
✔ integration: retries after rate-limit
✔ integration: respects --max-iter cap
... (16 more unit tests)
ℹ tests 20  ℹ pass 20  ℹ fail 0
```

For a live smoke test against the real `claude` binary (uses ~1 turn of API budget). This picks the largest non-active session (active sessions can't be resumed):

```bash
SESSION_ID=$(
  find ~/.claude/projects -name '*.jsonl' -size +100k \
    -mtime +1 -print0 \
  | xargs -0 ls -S \
  | head -1 | xargs basename | sed 's/.jsonl$//'
)
echo "Testing with session $SESSION_ID"
continuum "$SESSION_ID" "Reply with EXACTLY this and nothing else: <<TASK_COMPLETE>>" --max-iter 2
```

If continuum prints `sentinel "<<TASK_COMPLETE>>" found — stopping` and exits 0, the loop works end-to-end.

## Uninstall

```bash
# macOS / Linux
rm -rf ~/.continuum && rm -f /usr/local/bin/continuum ~/.local/bin/continuum

# Windows PowerShell
Remove-Item -Recurse -Force $HOME\.continuum
```

## License

MIT
