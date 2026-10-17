# This fork's branch structure

Read this before touching any branch. The rules are enforced by `.fork/check.sh`
(run locally or by the `fork-structure` workflow) and applied by `.fork/sync.sh`.

## Branches

| branch | content | rule |
|---|---|---|
| `main` | byte-for-byte mirror of `upstream/main` (earendil-works/pi) | never commit here; only `git merge --ff-only upstream/main` |
| `feat/native-*`, `feat/generic-endpoints` | one provider each, moved into the `packages/ai` layer | changes only under `packages/ai/` (plus lockfiles and `scripts/build-coding-agent-bundle.mjs`) |
| `feat/generic-endpoints-coding-agent`, `fix/coding-agent` | the single coding-agent/env branch | the only branches that may touch `packages/coding-agent` or `packages/env` |
| `next` | `main` + every feature branch merged on top | derived; rebuilt by `.fork/sync.sh`, never edited directly |

Each feature branch sits directly on `main` (`git merge-base <branch> main == main`).
Fixes for a provider go on that provider's branch, even when they came from somewhere
else (for example a backport from an extension package). `main` is not a place for fixes.

## The process, every time upstream moves

```sh
.fork/sync.sh            # ff main, rebase every branch, rebuild next, run checks
.fork/sync.sh --push     # same, then push main, every branch (--force-with-lease), and next
```

What the script does, in order:

1. `git fetch upstream` and fast-forward `main` to `upstream/main`. If it cannot
   fast-forward, `main` has been edited: stop and fix that first.
2. Rebase every branch in `.fork/branches` onto `main`. A conflict stops the script
   with the branch checked out mid-rebase; resolve, `git rebase --continue`, rerun.
3. Rebuild `next`: `git checkout -B next main`, then merge each branch in the listed
   order. A merge conflict stops the script the same way.
4. Run `npm run check` and the provider test files on `next`.
5. With `--push`: push `main`, every branch with `--force-with-lease`, and `next`.

Backup tags `pre-sync-<date>-<branch>` are written before step 2.

## Why the pre-commit hook can fail on an unrelated error

`packages/ai/src/providers/data/` is gitignored and regenerated from the live
catalogs by `npm run check`. If a branch's base is older than the catalog, tests
on that branch can reference models the catalog no longer has (`tsc` errors in
test files you did not touch). That is base drift, not your change: run
`.fork/sync.sh` first.

## Adding a branch

Append it to `.fork/branches` in merge order and add its allowed path prefixes to
`.fork/check.sh` if it is not a `packages/ai`-only provider branch.
