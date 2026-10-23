#!/bin/bash
cd "$(dirname "$0")"
for L in elixirh; do ./run.sh $L 15000 2>&1 | grep -v "Terminated\|SIGTERM\|^$"; done
echo ALLDONE
