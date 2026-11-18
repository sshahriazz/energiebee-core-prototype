#!/bin/sh
# Run a command while holding the machine-wide test lock. The laptop loses power when several test runs overlap, so at
# most one test run (or other heavy command) goes at a time across every checkout and every worker:
#   scripts/with-test-lock.sh node --test --test-concurrency=4 --disable-warning=ExperimentalWarning test/a.test.js test/b.test.js
# Waits up to 8 minutes for the lock (a foreground command may not run longer than 10), then exits 75 so the caller can try
# again. A lock whose owner has died (power loss, kill) is taken over.
lock=/tmp/eb-test.lock
waited=0
while ! mkdir "$lock" 2>/dev/null; do
  pid=$(cat "$lock/pid" 2>/dev/null)
  if [ -n "$pid" ] && ! kill -0 "$pid" 2>/dev/null; then rm -rf "$lock"; continue; fi
  if [ "$waited" -ge 480 ]; then echo "test lock is held by pid ${pid:-?}; still busy after 8 minutes, try again" >&2; exit 75; fi
  sleep 5; waited=$((waited + 5))
done
echo $$ > "$lock/pid"
trap 'rm -rf "$lock"' EXIT INT TERM HUP
"$@"
