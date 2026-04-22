# continuum

Auto-resume Claude Code sessions through rate limits, with proactive `/compact` so a session can loop indefinitely.

## What it does

A tiny wrapper around `claude --resume <id> -p <prompt>` that:

1. **Survives rate limits.** Detects `429`/usage-limit errors, parses the reset timestamp, sleeps until the limit lifts, then retries the same session.
2. **Auto-compacts before the context fills.** Reads the session JSONL (`~/.claude/projects/<cwd>/<session-id>.jsonl`) after every turn. If context usage crosses the threshold (default 80%), the next prompt becomes `/compact` so Claude shrinks the conversation before it hits the hard ceiling.
3. **Stops on a sentinel.** When the model emits `<<TASK_COMPLETE>>` (or your custom string), the loop exits cleanly.

Designed for Claude 4.7 1M — the model already understands the full session on resume, so no checkpoint files or intent capture is needed.

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

## Usage

```bash
continuum <session-id> [initial-prompt]
```

Get the session id from `claude /sessions` or from the filename in `~/.claude/projects/.../<id>.jsonl`.

### Examples

```bash
# Resume a session and just keep going
continuum 0134c106-cb75-4055-9016-e3b2f2483897

# Resume with a specific kickoff prompt and tighter compact threshold
continuum 0134c106-cb75-4055-9016-e3b2f2483897 \
  "Finish OPS-152, then emit <<TASK_COMPLETE>>" \
  --threshold 0.7

# Cap iterations and use a specific model
continuum 0134c106-... --model opus --max-iter 50
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

## Uninstall

```bash
# macOS / Linux
rm -rf ~/.continuum && rm -f /usr/local/bin/continuum ~/.local/bin/continuum

# Windows PowerShell
Remove-Item -Recurse -Force $HOME\.continuum
```

## License

MIT
