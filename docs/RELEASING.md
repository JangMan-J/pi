# Releasing Pi-Bolt

Four workflows, all on GitHub's own runners and none holding a secret:

| Workflow | When | What |
|---|---|---|
| `ci` | every push to `pi-bolt`, every pull request | lint and types, Pi's tests, Pi-Bolt built and tested on Linux x86-64 and macOS (Apple silicon), the installer's checks, whether the engine patches apply |
| `release` | a `bolt-vX.Y.Z` tag | builds the 12 archives on Linux and macOS, tests each as unpacked from its archive, and makes a **draft** release with `SHA256SUMS` and `RUNTIME_STAMP` |
| `publish` | by hand, after signing | checks the signature and the checksums, publishes the release, puts `install.sh` and the site on `gh-pages`, and publishes npm |
| `upstream` | daily | opens an issue when Pi has a new release, with the files where merging it conflicts |

The release key never leaves the maintainer's machine: a release is signed there, between `release` and `publish`.

- [A release, step by step](#a-release-step-by-step)
- [When the engine changed](#when-the-engine-changed)
- [npm](#npm)
- [A new Pi version](#a-new-pi-version)
- [The macOS builds](#the-macos-builds)
- [Signing](#signing)

## A release, step by step

1. Write the release notes in `docs/releases/X.Y.Z.md`; they become the GitHub release's text.
2. `scripts/bump-version.sh` (the last number goes up by one, 0.7.0 to 0.7.1; `--version X.Y.Z` sets another), commit, push, and
   wait for `ci` to pass.
3. Tag it: `git tag -a bolt-vX.Y.Z -m "Pi-Bolt X.Y.Z" && git push origin bolt-vX.Y.Z`. The `release` workflow builds and tests
   for about an hour, then leaves a draft. Its summary shows the SHA-256 of `SHA256SUMS`.
4. Sign, on your machine:
   ```bash
   gh release download bolt-vX.Y.Z -R opensec-git/Pi-Bolt -p SHA256SUMS -D dist/X.Y.Z --clobber
   scripts/sign-release.sh --key ~/pi-bolt-signing-key.pem dist/X.Y.Z
   gh release upload bolt-vX.Y.Z -R opensec-git/Pi-Bolt dist/X.Y.Z/SHA256SUMS.sig
   ```
5. Run `publish` from the tag: in the Actions tab, publish → "Use workflow from" → the tag, or
   `gh workflow run publish.yml -R opensec-git/Pi-Bolt --ref bolt-vX.Y.Z`. It refuses a draft whose signature does not
   verify against `keys/release.pub`.
6. Try both installs: `curl -fsSL https://pi-bolt.opensec.in/install.sh | sh` and `npm install -g pi-bolt`, looking for
   "signature verified".

Either workflow can be run again with the same tag: the draft's files are replaced, and a published release is left as it is.

Old-distribution and old-CPU checks (`tests/compat/run.sh`: CentOS 7, Debian 9, Amazon Linux 2, emulated Haswell to Nehalem)
need bubblewrap and qemu-user, which GitHub's runners do not allow; run them on a Linux machine before a release that changes
the engine or the build.

## When the engine changed

The runtime (patched WebKit and Bun) takes about 32 GB of RAM, 40 GB of disk and an hour on 16 cores to build, more than
GitHub's runners give. `release` therefore uses the previous release's runtime when the engine is the same: `RUNTIME_STAMP`
is the hash of the engine entries of `sources.json`, the patches and the runtime build scripts
(`scripts/runtime-stamp.sh`). `ci` says when it differs.

When it changed, build both runtimes by hand before tagging:

1. On Linux x86-64: `scripts/toolchain/make-sysroot.sh` once, then `scripts/fetch-sources.sh` and `scripts/build-runtime.sh`
   ([BUILDING.md](BUILDING.md)). On a Mac with Apple silicon: `scripts/fetch-sources.sh` and `scripts/build-runtime.sh`.
2. On each, `scripts/package-release.sh` and keep `pi-bolt-runtime-<platform>.tar.gz` from `dist/X.Y.Z`. Run
   `tests/aot/run.sh` and `tests/runtime/run.sh` there.
3. Make a draft for the tag and upload both: `gh release create bolt-vX.Y.Z --draft --title "Pi-Bolt X.Y.Z" --notes ""`, then
   `gh release upload bolt-vX.Y.Z pi-bolt-runtime-linux-x64.tar.gz pi-bolt-runtime-darwin-arm64.tar.gz`.
4. Push the tag (or run `release` for it): it builds Pi on those runtimes.

## npm

The installer downloads the executable from npm when it can (`pi-bolt-<platform>-<variant>@X.Y.Z`, the release's `.tar.xz` in a
package), a CDN that is fast where GitHub's downloads are slow, and from GitHub otherwise. The checksums and their signature
always come from the GitHub release.

`publish` publishes the six packages with npm's trusted publishing: npm trusts this repository's `publish.yml` through OpenID
Connect, so no token is stored in GitHub, and each version carries a provenance statement. The job runs in the `npm`
environment, which accepts only `bolt-v*` tags. To set it up once, logged in to npm with two-factor authentication:

```bash
for p in pi-bolt pi-bolt-linux-x64 pi-bolt-linux-x64-baseline pi-bolt-linux-x64-jit pi-bolt-darwin-arm64 pi-bolt-darwin-arm64-jit; do
  npm trust github "$p" --file publish.yml --repo opensec-git/Pi-Bolt --env npm --allow-publish --yes
done
```

(or on npmjs.com: each package's Settings → Trusted publishing → GitHub Actions, `opensec-git` / `Pi-Bolt` / `publish.yml`,
environment `npm`). Then set the repository variable `NPM_TRUSTED_PUBLISHING` to `true` (Settings → Secrets and variables →
Actions → Variables).

Until then the npm job is skipped, and the packages are published from the maintainer's machine after `publish`:

```bash
gh release download bolt-vX.Y.Z -R opensec-git/Pi-Bolt -p '*.tar.xz' -p SHA256SUMS -D dist/X.Y.Z --clobber
scripts/publish-npm-builds.sh dist/X.Y.Z
(cd npm && npm publish --access public)
```

npm answers a publish with "being processed": a new version can take a few minutes to appear.

## A new Pi version

`upstream` opens an issue for each new Pi release. To follow it:

1. Merge the tag into `pi-bolt` (`git fetch https://github.com/earendil-works/pi.git tag vX.Y.Z && git merge vX.Y.Z`). Where
   Pi-Bolt changed the same code, keep both: Pi-Bolt's changes are listed in the README under [The fork](../README.md#the-fork).
2. `scripts/bump-version.sh --pi X.Y.Z` (the last number goes up by one, as for any release), then `scripts/train-profile.sh` **on Linux**, and commit
   `profiles/pi-X.Y.Z`. A profile recorded on Linux serves both platforms.
3. Push; `ci` builds and tests it. Then release as above.

## The macOS builds

`release` builds them on GitHub's macOS runners (Apple silicon). The executables are signed ad hoc, as `bun build --compile`
signs them, which is what an install through `install.sh` or npm needs: neither quarantines what it downloads. A build downloaded
with a browser is quarantined, and Gatekeeper only accepts a Developer ID signature that is notarized. Notarization requires the
hardened runtime, under which the executable needs the entitlement `com.apple.security.cs.disable-library-validation` to map
its compiled code from its own file (and the `-jit` build `com.apple.security.cs.allow-jit`);
[ARCHITECTURE.md](ARCHITECTURE.md#the-macos-arm64-port) says why.

## Signing

`SHA256SUMS` in every release is signed with an Ed25519 key. The installer carries the public key and refuses a download
whose signature is missing or does not verify. It checks it with OpenSSL 3 (on `PATH` or Homebrew's), or else with the Pi-Bolt
already installed; with neither (a first install on a Mac without OpenSSL 3), it checks the checksums alone and says so.
`scripts/fetch-runtime.sh` and the `publish` workflow require the signature too. To make the key pair:

```bash
openssl genpkey -algorithm ed25519 -out pi-bolt-signing-key.pem
openssl pkey -in pi-bolt-signing-key.pem -pubout -out keys/release.pub
```

Then copy the contents of `keys/release.pub` into `RELEASE_KEY` in `install.sh`, commit both, and keep
`pi-bolt-signing-key.pem` somewhere safe and private (a password manager), never in the repository or in GitHub. Rotating the
key is the same procedure; releases signed with the old key stay verifiable with an installer that carries the old key.
