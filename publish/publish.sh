#!/usr/bin/env bash
# Commits vault changes and pushes them, which is what makes the site rebuild.
#
# Obsidian Sync brings notes to this host; nothing here reaches jakub.app until
# a commit lands on the default branch and the Pages workflow runs. This closes
# that gap on a timer rather than on every write: publishing a personal site is
# not latency-sensitive, and a timer batches an editing session into one commit
# instead of thirty.
set -euo pipefail

repo="${GARDEN_REPO:?GARDEN_REPO must point at the checkout}"
remote="${GARDEN_REMOTE:-origin}"
branch="${GARDEN_BRANCH:-main}"

# A sync that goes wrong deletes notes wholesale, and an unattended committer
# would publish that faithfully. Anything above this is treated as an accident
# worth a human look rather than a change worth shipping.
max_deletions="${GARDEN_MAX_DELETIONS:-10}"

cd "$repo"

# Only the vault is published from here. Code changes arrive by pull, and
# staging them too would let a half-finished edit on this host reach the site.
git add -A -- docs

if git diff --cached --quiet; then
  exit 0
fi

mapfile -t changed < <(git diff --cached --name-only)
deleted=$(git diff --cached --name-only --diff-filter=D | wc -l | tr -d ' ')

if [ "$deleted" -gt "$max_deletions" ]; then
  git reset --quiet
  echo "publish: refusing to commit — ${deleted} deletions exceed the limit of ${max_deletions}" >&2
  echo "publish: nothing was committed; inspect the vault and commit by hand if this is intended" >&2
  exit 1
fi

printf -v body '%s\n' "${changed[@]}"
git commit --quiet --message "vault: publish ${#changed[@]} changed file(s)" --message "$body"

# Code changes land on this branch from elsewhere, so rebase rather than merge:
# a merge commit per sync would bury the vault history in noise.
if ! git pull --quiet --rebase "$remote" "$branch"; then
  git rebase --abort || true
  echo "publish: rebase onto ${remote}/${branch} conflicted; the commit is left local" >&2
  exit 1
fi

git push --quiet "$remote" "$branch"
echo "publish: pushed ${#changed[@]} file(s)"
