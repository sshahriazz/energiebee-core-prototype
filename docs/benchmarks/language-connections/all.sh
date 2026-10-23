#!/bin/bash
cd "$(dirname "$0")"
echo "##### PASS 1 (go rust elixir node)"
for L in go rust elixir node; do ./run.sh $L 15000 2>&1 | grep -v Terminated; done
echo "##### PASS 2 (node elixir rust go)"
for L in node elixir rust go; do ./run.sh $L 15000 2>&1 | grep -v Terminated; done
echo ALLDONE
