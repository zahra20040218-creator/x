#!/usr/bin/env bash
# Autonomous loop driver (RUN_AUTONOMOUS.md §2).
#
# A loop rather than one giant prompt, because one giant prompt fills the
# context window and then degrades silently: the agent starts making
# contradictory edits and rewriting work it already finished. Each iteration
# here gets a CLEAN context; all state lives in files, not in the conversation.
set -uo pipefail

MAX_ITERATIONS=${MAX_ITERATIONS:-120}
ITERATION_TIMEOUT=${ITERATION_TIMEOUT:-45m}
CONSECUTIVE_FAILURES=0

mkdir -p logs

for i in $(seq 1 "$MAX_ITERATIONS"); do
  echo "=== iteration $i / $MAX_ITERATIONS — $(date -u) ==="

  # `tee` in a pipeline makes $? the exit status of tee, not claude. Capture
  # claude's own status via PIPESTATUS or the loop's abort rule never fires.
  timeout "$ITERATION_TIMEOUT" claude -p "$(cat AGENT_LOOP_PROMPT.md)" \
    --permission-mode bypassPermissions \
    --output-format text \
    2>&1 | tee -a logs/run.log
  EXIT=${PIPESTATUS[0]}

  if [ "$EXIT" -ne 0 ]; then
    CONSECUTIVE_FAILURES=$((CONSECUTIVE_FAILURES + 1))
    echo "!!! non-zero exit ($EXIT), consecutive=$CONSECUTIVE_FAILURES"
    if [ "$CONSECUTIVE_FAILURES" -ge 3 ]; then
      echo "ABORT: 3 consecutive failures"
      break
    fi
    sleep 60
    continue
  fi
  CONSECUTIVE_FAILURES=0

  if grep -q "^ALL_TASKS_RESOLVED" STATUS.txt 2>/dev/null; then
    echo "=== agent reports completion at iteration $i ==="
    break
  fi
done

echo "=== run ended $(date -u) — read FINAL_REPORT.md ==="
