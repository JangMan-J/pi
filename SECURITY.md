# Security

## Reporting a vulnerability

Please report security issues privately, through GitHub's
[private vulnerability reporting](https://github.com/opensec-git/Pi-Bolt/security/advisories/new), not in public issues. We
will acknowledge the report, investigate, and coordinate a fix and disclosure with you.

In scope: the Pi-Bolt runtime and engine changes (`patches/`), the release executables, and the scripts and installer in this
repository. Vulnerabilities in Pi itself belong to [Pi](https://github.com/earendil-works/pi). Vulnerabilities in upstream Bun
or JavaScriptCore that Pi-Bolt does not change belong to their projects.

## Verifying downloads

Every release publishes `SHA256SUMS`. The installer verifies each download against it; check manual downloads with:

```bash
sha256sum -c --ignore-missing SHA256SUMS
```

## Plugins

Pi extensions run inside the Pi process with your permissions, whether they are loaded at run time or compiled in. Only use
plugins from sources you trust.
