# Security Policy

## Supported versions

| Version | Security support |
| --- | --- |
| 0.1.x on `main` | Supported |
| Older versions | Not supported |

Retest against the current `main` branch when practical, without risking your
real library or device data.

## Reporting a vulnerability

Use GitHub private vulnerability reporting for `1jehuang/takio`: open the
repository's **Security** tab, choose **Report a vulnerability**, and submit a
private report. Do not disclose exploit details in a public issue or pull request.

Include the affected version or commit, platform, reproduction steps, expected
and observed behavior, and potential impact. Use a minimal synthetic library or
ebook when possible. Never attach credentials, bearer tokens, SSH private keys,
personal library data, or copyrighted books you cannot share.

## Security boundaries and scope

- The Electron desktop uses `contextIsolation`, renderer sandboxing, and a
  Content-Security-Policy. Browser permission requests are denied and webview
  attachment is blocked. Renderer-to-native requests must remain validated.
- The optional content server is read-only, loopback-only, and protected by a
  bearer token. It is not a public, multi-user, or remote TLS service. Do not
  expose it through a public proxy or share its token.
- Rooted Kindle SSH/SCP is an explicit per-command opt-in. It validates the
  host, user, key, and remote path, uses strict host-key checking, and does not
  handle passwords. Rooting a device is outside Takio's security boundary.
- Imported ebooks, metadata, paths, external-tool output, and device contents
  are untrusted. Managed-file ownership, verified publication, and protection
  of caller-owned references are security-sensitive behavior.
- Calibre is an optional external executable invoked through its public CLI.
  Reports about Takio's invocation and validation are in scope. Vulnerabilities
  confined to upstream tools should also be reported to their maintainers.
