# Releasing Pi-Bolt

Releases are made by the `release` workflow when a `bolt-vX.Y.Z` tag is pushed. It builds the runtime if the engine changed,
builds and tests Pi, packages, signs, publishes the GitHub release, updates the installer site and publishes the npm package.
The `upstream` workflow watches Pi's releases and opens a pull request for each new one.

- [The self-hosted runner](#the-self-hosted-runner)
- [Secrets](#secrets)
- [A release, step by step](#a-release-step-by-step)
- [A new Pi version](#a-new-pi-version)
- [Signing](#signing)

## The self-hosted runner

Building the runtime (patched WebKit and Bun) needs about 32 GB of RAM, 40 GB of disk and an hour on 16 cores, more than
GitHub's standard runners have, so the release workflow runs on a self-hosted runner with the labels `linux`, `x64` and
`pi-bolt`. Any Linux x86-64 machine that can run [`scripts/build-runtime.sh`](BUILDING.md#building-the-runtime) will do.

1. In the repository, Settings → Actions → Runners → New self-hosted runner, and follow GitHub's instructions. When it asks
   for labels, add `pi-bolt`.
2. Install the build requirements from [BUILDING.md](BUILDING.md), and make the glibc 2.17 sysroot once:
   `scripts/toolchain/make-sysroot.sh` in the runner's checkout (it is kept between runs).
3. Run the runner as a service (`./svc.sh install && ./svc.sh start`).

The `ci` workflow (lint, build Pi with the released runtime, tests) runs on GitHub's runners and needs nothing.

GitHub Actions must be allowed for the repository in the organization's settings (Settings → Actions → General).

## Secrets

| Secret | What |
|---|---|
| `PIBOLT_SIGNING_KEY` | The Ed25519 private key that signs `SHA256SUMS` (see [Signing](#signing)) |
| `NPM_TOKEN` | A granular npm access token with publish rights on `pi-bolt`, so `npm publish --provenance` can run |

## A release, step by step

1. Write the release notes in `docs/releases/X.Y.Z.md` (the workflow uses them as the GitHub release's text).
2. `scripts/bump-version.sh --version X.Y.Z` (or without `--version`: a patch bump), commit.
3. Push, and wait for `ci` to pass.
4. `git tag -a bolt-vX.Y.Z -m "Pi-Bolt X.Y.Z" && git push origin bolt-vX.Y.Z`.
5. The `release` workflow does the rest. If it fails after the GitHub release was created, fix the cause and run it again from
   the Actions tab with the tag as input: every step is safe to repeat.

To release by hand instead, run the same steps as the workflow: `scripts/package-release.sh`, `tests/aot/run.sh`, the
end-to-end checks, `scripts/sign-release.sh --key ... dist/X.Y.Z`, `gh release create`, `scripts/publish-installer.sh` and
`npm publish --access public` in `npm/`.

## A new Pi version

The `upstream` workflow runs daily. When Pi has a new release it opens a pull request that:

- merges Pi's tag into a branch `upstream/vX.Y.Z` (a conflict is left to be resolved by hand, and said in the pull request);
- bumps Pi-Bolt's minor version and `sources.json` with `scripts/bump-version.sh --pi X.Y.Z`;
- records a training profile with `scripts/train-profile.sh` and commits `profiles/pi-X.Y.Z`;
- builds and tests, on the self-hosted runner.

Review it, merge it, and push the tag.

## Signing

`SHA256SUMS` in every release is signed with an Ed25519 key. The installer carries the public key and refuses a download
whose signature does not verify (when `openssl` is installed; otherwise it checks the checksums alone). To make the key pair:

```bash
openssl genpkey -algorithm ed25519 -out pi-bolt-signing-key.pem
openssl pkey -in pi-bolt-signing-key.pem -pubout -out keys/release.pub
gh secret set PIBOLT_SIGNING_KEY --repo opensec-git/Pi-Bolt < pi-bolt-signing-key.pem
```

Then copy the contents of `keys/release.pub` into `RELEASE_KEY` in `install.sh`, commit both, and keep
`pi-bolt-signing-key.pem` somewhere safe and private (a password manager). Rotating the key is the same procedure; releases
signed with the old key stay verifiable with an installer that carries the old key.
