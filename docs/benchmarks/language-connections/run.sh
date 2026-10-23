#!/bin/bash
# usage: run.sh <name> <n> ; starts the named server, runs the load generator, kills the server
set -u
cd "$(dirname "$0")"
NAME=$1; N=$2
ulimit -n 65000
case $NAME in
  go)     ./go/srv 4001 10 & ;;
  node)   node node/srv.js 4001 10 & ;;
  rust)   ./rust/target/release/srv 4001 10 & ;;
  elixir) elixir elixir/srv.exs 4001 10 & ;;
  elixirh) elixir elixir/srv_h.exs 4001 10 & ;;
  go512)  ./go512/srv 4001 10 & ;;
esac
SP=$!
for i in $(seq 1 100); do lsof -nP -iTCP:4001 -sTCP:LISTEN -t >/dev/null 2>&1 && break; sleep 0.2; done
PID=$(lsof -nP -iTCP:4001 -sTCP:LISTEN -t | head -1)
echo "== $NAME server pid=$PID, N=$N =="
./loadgen/loadgen -pid "$PID" -n "$N" -ramp 1000 -idle 10
kill $PID 2>/dev/null; kill $SP 2>/dev/null; sleep 3
