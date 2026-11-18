#!/bin/sh
# A work package's own checkout: a git worktree on a new branch wp/<name> (from <base>, default the current branch), at
# $HOME/eb-wt/<name>, with the shared node_modules linked and the Prisma client generated. Tests there use their own
# database names (TEST_DB_PREFIX=wp_<name>), so several checkouts can test at the same time.
#   scripts/wp-worktree.sh <name> [base]      remove it later: git worktree remove --force $HOME/eb-wt/<name>
set -e
name=$1
[ -n "$name" ] || { echo "usage: $0 <name> [base]" >&2; exit 2; }
root=$(cd "$(dirname "$0")/.." && pwd)
base=${2:-$(git -C "$root" rev-parse --abbrev-ref HEAD)}
dir="$HOME/eb-wt/$name"
git -C "$root" worktree add -b "wp/$name" "$dir" "$base" >&2
ln -s "$root/node_modules" "$dir/node_modules"
( cd "$dir" && DATABASE_URL=postgresql://localhost:5432/postgres npx prisma generate >&2 )
echo "$dir"
