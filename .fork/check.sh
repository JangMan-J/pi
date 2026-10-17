#!/usr/bin/env bash
# Verify the fork's branch invariants. Usage: .fork/check.sh [branch ...]  (default: current branch)
# Exit 1 on any violation. Safe to run anywhere; makes no changes.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

UPSTREAM_REF="${UPSTREAM_REF:-upstream/main}"
if ! git rev-parse -q --verify "$UPSTREAM_REF" >/dev/null; then
  UPSTREAM_REF="${UPSTREAM_REF_FALLBACK:-origin/main}"
fi
MAIN_REF="${MAIN_REF:-main}"
git rev-parse -q --verify "$MAIN_REF" >/dev/null || MAIN_REF="origin/main"

# Paths every branch may touch besides its own area.
COMMON_OK='^(package-lock\.json|packages/coding-agent/install-lock/|scripts/build-coding-agent-bundle\.mjs|\.fork/|\.github/workflows/fork-structure\.yml)'
# Per-branch allowed prefixes. Default: packages/ai/ only.
allowed_for() {
  case "$1" in
    feat/generic-endpoints-coding-agent|fix/coding-agent) echo '^(packages/ai/|packages/coding-agent/|packages/env/)' ;;
    *) echo '^packages/ai/' ;;
  esac
}

fail=0
say() { printf '%s\n' "$*" >&2; }

check_main() {
  if [ "$(git rev-parse "$MAIN_REF")" != "$(git rev-parse "$UPSTREAM_REF")" ]; then
    if git merge-base --is-ancestor "$MAIN_REF" "$UPSTREAM_REF"; then
      say "note: $MAIN_REF is behind $UPSTREAM_REF (run .fork/sync.sh)"
    else
      say "FAIL: $MAIN_REF is not a byte-for-byte mirror of $UPSTREAM_REF (it has its own commits)"; fail=1
    fi
  fi
}

check_branch() {
  local b="$1"
  local mb; mb="$(git merge-base "$b" "$MAIN_REF")"
  if [ "$mb" != "$(git rev-parse "$MAIN_REF")" ]; then
    say "note: $b is based on $(git rev-parse --short "$mb"), not on $MAIN_REF head (run .fork/sync.sh)"
  fi
  local allowed; allowed="$(allowed_for "$b")"
  local bad
  bad="$(git diff --name-only "$mb" "$b" | grep -Ev "$COMMON_OK" | grep -Ev "$allowed" || true)"
  if [ -n "$bad" ]; then
    say "FAIL: $b touches files outside its allowed area:"; say "$bad" | sed 's/^/  /'; fail=1
  fi
}

check_next() {
  local b
  while read -r b; do
    [[ -z "$b" || "$b" == \#* ]] && continue
    git rev-parse -q --verify "$b" >/dev/null || continue
    if ! git merge-base --is-ancestor "$b" next 2>/dev/null; then
      say "FAIL: next does not contain $b"; fail=1
    fi
  done < .fork/branches
  if ! git merge-base --is-ancestor "$MAIN_REF" next 2>/dev/null; then
    say "FAIL: next does not contain $MAIN_REF"; fail=1
  fi
}

targets=("$@")
[ ${#targets[@]} -eq 0 ] && targets=("$(git rev-parse --abbrev-ref HEAD)")
for t in "${targets[@]}"; do
  case "$t" in
    main|origin/main) check_main ;;
    next|origin/next) check_next ;;
    *) check_branch "$t" ;;
  esac
done
exit $fail
