#!/usr/bin/env bash
# Mock `claude` for integration tests. Behavior controlled via env vars:
#   MOCK_SESSION_DIR  — write turn output to this session JSONL
#   MOCK_SCRIPT       — path to a file with one mode per line, consumed in order
#                       Modes: NORMAL | SENTINEL | RATELIMIT
#   MOCK_TOKEN_DELTA  — tokens to append per NORMAL turn (default 100000)

set -e

# Find the prompt argument (after -p)
prompt=""
session_id=""
prev=""
for arg in "$@"; do
  if [ "$prev" = "-p" ]; then prompt="$arg"; fi
  if [ "$prev" = "--resume" ]; then session_id="$arg"; fi
  prev="$arg"
done

# Read next mode from script file (default NORMAL)
mode="NORMAL"
if [ -n "${MOCK_SCRIPT:-}" ] && [ -f "$MOCK_SCRIPT" ]; then
  mode=$(head -1 "$MOCK_SCRIPT" 2>/dev/null || echo "NORMAL")
  tail -n +2 "$MOCK_SCRIPT" > "$MOCK_SCRIPT.tmp" && mv "$MOCK_SCRIPT.tmp" "$MOCK_SCRIPT"
  [ -z "$mode" ] && mode="NORMAL"
fi

case "$mode" in
  RATELIMIT)
    echo "Error: rate_limit_exceeded. Retry-After: 1" >&2
    exit 1
    ;;
  SENTINEL)
    echo "All work done. <<TASK_COMPLETE>>"
    ;;
  NORMAL|*)
    echo "[mock-claude] turn for session=$session_id prompt=\"$prompt\""
    ;;
esac

# Append a usage entry to the session JSONL so getContextTokens advances.
# Real Claude sessions show CUMULATIVE cache_read on each turn, so we simulate
# that by tracking call count and multiplying.
if [ -n "${MOCK_SESSION_DIR:-}" ] && [ -n "$session_id" ]; then
  delta="${MOCK_TOKEN_DELTA:-100000}"
  proj_dir="$MOCK_SESSION_DIR/-tmp-mockproject"
  mkdir -p "$proj_dir"
  jsonl="$proj_dir/$session_id.jsonl"
  counter_file="$proj_dir/.$session_id.count"
  count=$(cat "$counter_file" 2>/dev/null || echo 0)
  count=$((count + 1))
  echo "$count" > "$counter_file"
  cumulative=$((count * delta))
  printf '%s\n' "{\"type\":\"assistant\",\"message\":{\"usage\":{\"input_tokens\":100,\"cache_creation_input_tokens\":0,\"cache_read_input_tokens\":$cumulative,\"output_tokens\":1000}}}" >> "$jsonl"
fi

exit 0
