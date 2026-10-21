# Contributing to Takio

## Prerequisites and setup

- Rust 1.97.1, pinned by `rust-toolchain.toml`, with rustfmt and Clippy.
- Bun 1.3+ (the workspace requires at least 1.3.13 and pins 1.3.14).
- Xcode Command Line Tools on macOS for native packaging and verification.
- Calibre is optional for library-only development. Install 9.9.0 or newer
  when exercising the advertised conversion pairs and metadata backends.

From the repository root:

```bash
bun install
```

Use `bun run desktop` for the desktop app or `cargo run -p takio` for the TUI.
Pass CLI arguments after `cargo run -p takio --`.

## Quality gates

Run the root scripts before submitting a change:

```bash
bun run check
bun run test
bun run build
```

These are the exact `package.json` script bodies, in the same order:

```bash
cargo fmt --all --check && cargo clippy -p takio --all-targets -- -D warnings && bun run --filter '@takio/core' check && bun run --filter '@takio/epub-transform' check && bun run --filter '@takio/library-contract' check && bun run --filter '@takio/library-store-bun' check && bun run --filter '@takio/desktop' check
cargo test -p takio && bun run --filter '@takio/core' test && bun run --filter '@takio/epub-transform' test && bun run --filter '@takio/library-contract' test && bun run --filter '@takio/library-store-bun' test && bun run --filter '@takio/desktop' test
cargo build --release -p takio && bun run --filter '@takio/core' build && bun run --filter '@takio/epub-transform' build && bun run --filter '@takio/library-contract' build && bun run --filter '@takio/library-store-bun' build && bun run --filter '@takio/desktop' build
```

Run the library performance gates, not just the functional tests:

```bash
bun run test:performance:library
bun run test:performance:native:library
```

On macOS, also run the native packaging and startup gates:

```bash
bun run check:native:macos
bun run test:performance:native:macos
```

CI rejects committed JavaScript/TypeScript test `.skip`, `.only`, and `.todo`
markers and Rust `#[ignore]` attributes. Fix failing tests instead of disabling
or focusing them. Add regression coverage for behavior changes and keep tests
independent of a contributor's real library and device files.

## Design and safety policies

- No unsafe Rust. Preserve the workspace's `unsafe_code = "forbid"` lint.
- Takio is MIT licensed. Use Calibre only through its public command-line
  interface. Never copy, translate, or incorporate GPL source code.
- Implement native transformations independently from public specifications,
  interoperability tests, and observed file behavior.
- Preserve explicit managed/reference ownership. Never delete caller-owned
  references or overwrite existing destinations. Verify bytes and SHA-256 at
  ownership and transfer boundaries.
- Keep the desktop process boundary explicit and validate wire data. The Rust
  executable must not silently fall back to Bun or JavaScript.

Read [the architecture](docs/architecture.md) before changing module boundaries.
Put behavior and acceptance specifications in `docs/specs/`, and implementation
plans and sequencing in `docs/plans/`. Update documentation alongside changes
to schemas, commands, protocols, and supported workflows.

## Commits and pull requests

Prefer the Conventional Commit style used in recent history: `fix(cli): ...`,
`feat(desktop): ...`, `refactor(cli): ...`, `build: ...`, or `docs: ...`.
Keep each change focused and explain the behavior, relevant specification,
validation performed, and any remaining limitations in the pull request.
Do not include generated artifacts, credentials, or personal library data.

For vulnerabilities, follow [SECURITY.md](SECURITY.md) instead of opening a
public issue with exploit details.
