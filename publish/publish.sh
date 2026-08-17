#!/usr/bin/env bash
# Commits vault changes and pushes them, which is what makes the site rebuild.
#
# Obsidian Sync brings notes to this host; nothing here reaches jakub.app until
# a commit lands on the default branch and the Pages workflow runs. This closes
# that gap on a timer rather than on every write: publishing a personal site is
# not latency-sensitive, and a timer batches an editing session into one commit
# instead of thirty.
#
# The repository is public and the vault is not entirely publishable, so what
# gets staged is inspected before anything is committed. .gitignore is the first
# line of defence, but it only covers paths someone thought of — twice already a
# private directory was one setting away from being published.
#
#   GARDEN_DRY_RUN=1 publish.sh   # or: publish.sh --dry-run
#
# reports what would be committed and changes nothing.
set -euo pipefail

repo="${GARDEN_REPO:?GARDEN_REPO must point at the checkout}"
remote="${GARDEN_REMOTE:-origin}"
branch="${GARDEN_BRANCH:-main}"

# A sync that goes wrong deletes notes wholesale, and an unattended committer
# would publish that faithfully. Anything above this is treated as an accident
# worth a human look rather than a change worth shipping.
max_deletions="${GARDEN_MAX_DELETIONS:-10}"

dry_run="${GARDEN_DRY_RUN:-}"
[ "${1:-}" = "--dry-run" ] && dry_run=1

cd "$repo"

# Only the vault is published from here. Code changes arrive by pull, and
# staging them too would let a half-finished edit on this host reach the site.
#
# .obsidian is excluded rather than gitignored: the settings in it matter and
# belong in the repository, but Obsidian rewrites app.json on a whim — reordering
# keys without changing meaning — and a timer would turn that into a commit every
# ten minutes. Excluded here, it still moves when someone commits it deliberately.
git add -A -- docs ':(exclude)docs/.obsidian'

if git diff --cached --quiet; then
  [ -n "$dry_run" ] && echo "publish: nothing to publish"
  exit 0
fi

mapfile -t changed < <(git diff --cached --name-only)

# Directory names are what get checked, not filenames. A note called
# "private equity.md" is ordinary writing; a directory called private/ is the
# vault's unpublished half, and a dot-prefixed one is some tool's scratch space.
suspicious=()
for path in "${changed[@]}"; do
  directory="${path%/*}"
  if [ "$directory" != "$path" ]; then
    IFS='/' read -r -a segments <<<"$directory"
    for segment in "${segments[@]}"; do
      case "$segment" in
      .* | private | secrets)
        suspicious+=("$path")
        break
        ;;
      esac
    done
  fi

  case "${path##*/}" in
  .env | .env.* | *.pem | *.key | id_rsa | id_ed25519)
    suspicious+=("$path")
    ;;
  esac
done

if [ "${#suspicious[@]}" -gt 0 ]; then
  git reset --quiet
  echo "publish: refusing to commit — these paths must not reach a public repository:" >&2
  printf '  %s\n' "${suspicious[@]}" >&2
  echo "publish: nothing was committed; add them to .gitignore or move them out of docs/" >&2
  exit 1
fi

deleted=$(git diff --cached --name-only --diff-filter=D | wc -l | tr -d ' ')

if [ "$deleted" -gt "$max_deletions" ]; then
  git reset --quiet
  echo "publish: refusing to commit — ${deleted} deletions exceed the limit of ${max_deletions}" >&2
  echo "publish: nothing was committed; inspect the vault and commit by hand if this is intended" >&2
  exit 1
fi

if [ -n "$dry_run" ]; then
  git reset --quiet
  echo "publish: would commit ${#changed[@]} file(s), ${deleted} deletion(s)"
  printf '  %s\n' "${changed[@]}"
  exit 0
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
