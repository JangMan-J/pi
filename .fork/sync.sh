#!/usr/bin/env bash
# Sync the fork to upstream: ff main, rebase every branch in .fork/branches onto it,
# rebuild next, run checks. Usage: .fork/sync.sh [--push] [--no-check]
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
export GIT_EDITOR=true GIT_SEQUENCE_EDITOR=true

PUSH=0; CHECK=1
for a in "$@"; do case "$a" in --push) PUSH=1 ;; --no-check) CHECK=0 ;; *) echo "unknown arg $a" >&2; exit 2 ;; esac; done

[ -z "$(git status --porcelain)" ] || { echo "working tree not clean; stash or commit first" >&2; exit 1; }
git remote get-url upstream >/dev/null 2>&1 || git remote add upstream https://github.com/earendil-works/pi.git

mapfile -t BRANCHES < <(grep -Ev '^\s*(#|$)' .fork/branches)
start="$(git rev-parse --abbrev-ref HEAD)"
stamp="$(date +%Y%m%d-%H%M)"

echo "== fetch upstream"
git fetch -q upstream
echo "== main -> upstream/main (ff-only)"
git checkout -q main
git merge --ff-only upstream/main
echo "   main = $(git rev-parse --short main)"

echo "== backup tags pre-sync-$stamp-*"
for b in "${BRANCHES[@]}" next; do
  git rev-parse -q --verify "$b" >/dev/null && git tag -f -m "pre-sync backup" "pre-sync-$stamp-${b//\//-}" "$b" >/dev/null
done

echo "== rebase branches onto main"
for b in "${BRANCHES[@]}"; do
  git checkout -q "$b"
  if ! git -c core.hooksPath=/dev/null rebase main >/dev/null 2>&1; then
    echo "CONFLICT rebasing $b. Resolve, then: git -c core.hooksPath=/dev/null rebase --continue; then rerun $0" >&2
    exit 1
  fi
  echo "   $b -> $(git rev-parse --short "$b")"
done

echo "== rebuild next = main + branches"
git checkout -q -B next main
for b in "${BRANCHES[@]}"; do
  if ! git -c core.hooksPath=/dev/null merge --no-edit "$b" >/dev/null 2>&1; then
    echo "CONFLICT merging $b into next. Resolve, commit, then rerun $0 (next is rebuilt from scratch)" >&2
    exit 1
  fi
done
echo "   next = $(git rev-parse --short next)"

if [ "$CHECK" = 1 ]; then
  echo "== checks on next"
  .fork/check.sh main next "${BRANCHES[@]}"
  npm run check
  npx vitest run packages/ai/test/antigravity-*.test.ts packages/ai/test/supports-xhigh.test.ts
fi

if [ "$PUSH" = 1 ]; then
  echo "== push"
  git push origin main
  for b in "${BRANCHES[@]}"; do git push --force-with-lease origin "$b"; done
  git push --force-with-lease origin next
fi

git checkout -q "$start" 2>/dev/null || true
echo "done"
