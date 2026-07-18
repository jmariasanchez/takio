# Takio Plan: Viewer, Editor, and Content Server

> Planning artifact produced read-only with `claude-fable-5` on 2026-07-18.

**Decision up front:** Takio builds none of the three Calibre-scale subproducts now. The first user need — "look at an item in my library" — is met by opening it with the OS default application. That is the only code this plan adds. Viewer, editor, and content server are demand-gated below with concrete evidence thresholds.

## Goal and current state

**Goal:** Let a user or agent view a library item today with zero new rendering code, and record honest gates for the deferred subproducts so nobody scaffolds them speculatively.

**Current state:**

- `@takio/core` has an eight-format catalogue, `detectFormat`, the planner, and the Zod `libraryItemSchema`.
- `@takio/library-contract` and `@takio/library-store-bun` provide SQLite `open/list/get/add/remove` operations and typed error codes. `get` exists in the store but is not exposed by the CLI.
- `@takio/cli` has `formats`, `devices`, `plan`, and `library add|list` with a single-line JSON `{ok,...}` protocol and Commander `exitOverride` plumbing via `storageCommand`.
- `@takio/desktop` is a Tauri v2 shell rendering mock library rows, with no IPC bridge to the real store.
- No conversion execution, queue, or produced artifacts exist. The only viewable file per item is `sourcePath`.

## Explicit assumptions

- Every supported format has a plausible OS default handler. Where one is missing, the OS can show its own choose-an-app flow. Its observed failure rate becomes evidence for the built-in viewer gate.
- Stored `sourcePath` values are untrusted because the database is a plain file and users or agents can add rows.
- Development is on macOS (`open`); Linux uses `xdg-open`, and Windows uses `explorer.exe`. CI asserts platform command selection through an injected fake launcher and never opens a real application.
- Produced-artifact opening is deferred until conversion exists; the command operates only on `sourcePath`.

## Dependency ordering

1. Nothing blocks the CLI MVP. Store `get`, the format catalogue, and the library JSON protocol already exist.
2. A desktop Open affordance is blocked by the absent store wiring. Add it only after the mock data is replaced by real Tauri IPC.
3. A built-in viewer is gated on evidence that default applications do not meet the need.
4. An editor is gated on demand; even metadata editing first needs an `update` operation in the library contract.
5. A content server is gated on demand and blocked by the absence of a queue and artifacts.

## MVP — `takio library open`

This is the only implementation in the plan.

### Required behavior

```text
takio library open --db <path> --id <id> [--json]
```

1. Open the store and get the item. An absent item returns exit 1 and `{"ok":false,"error":{"code":"not-found"}}`.
2. Stat `sourcePath`; it must exist and be a regular file, otherwise return `missing-file`.
3. The file extension must be one of the declared format's extensions in `FORMAT_CATALOG`; otherwise return `format-mismatch` without invoking the launcher. This prevents a tampered row from turning the command into an arbitrary executable launcher.
4. Spawn the platform opener with an argument array, never a shell string: macOS `["open", path]`, Linux `["xdg-open", path]`, Windows `["explorer.exe", path]`. A spawn failure returns `open-failed`.
5. Success means the opener spawned, not that the application exited. JSON output is one physical line: `{"ok":true,"value":{"id":...,"path":...}}`. Human output is one line. All failures preserve the existing library command protocol.

The new `not-found`, `missing-file`, `format-mismatch`, and `open-failed` codes are CLI-layer errors. Existing store error codes pass through unchanged.

### Files

- Modify `apps/cli/src/main.ts`: add `library open` via `storageCommand`; add a launcher injection parameter to `createProgram`, defaulting to a small `openWithDefaultApp(path)` helper built on `Bun.spawn`.
- Modify `apps/cli/test/main.test.ts`: add the focused cases below.
- No new packages or dependencies.

### Trust boundaries and security

- `--db`, `--id`, and stored `sourcePath` are untrusted. Use only argument-array spawning; interpolate nothing into a shell.
- The extension-vs-declared-format allowlist prevents opening executables, scripts, or app bundles recorded in a tampered database.
- The regular-file check rejects directories and dangling paths. A symlink whose target passes the extension check opens with that extension's handler, at the same trust level as a Finder/Explorer double-click.
- Accepted residual risk: an OS default application parses a potentially malicious document. This is why Takio adds no parser in the MVP.

### Tests that encode intent

Use a fake launcher injected into `createProgram`:

- Opening an added item invokes the correct platform opener and exact path as separate argv entries. This fails if a shell string replaces argument arrays.
- Unknown ID returns exit 1 and one-line `not-found` JSON.
- Missing source file returns `missing-file` and never calls the launcher.
- An item declared EPUB whose path ends in `.sh` returns `format-mismatch` and never calls the launcher. This must fail if the security allowlist is removed.
- Launcher failure returns `open-failed`, exit 1.
- Existing library help and JSON protocol tests remain green.

### Exact runnable verification

```sh
bun install
bun run check
bun run test

DB="$(mktemp -d)/lib.db"
printf 'hello takio' > /tmp/takio-sample.txt
bun run takio library add --db "$DB" --id t1 --title Sample \
  --source-path /tmp/takio-sample.txt --format txt --added-at 2026-07-18T00:00:00Z
bun run takio library open --db "$DB" --id t1 --json
bun run takio library open --db "$DB" --id nope --json; echo "exit=$?"
```

### Rollback and safe disable

The command is additive and persists no state. Revert the commit; no migration or cleanup is required.

## Deferred subproduct 1 — Built-in viewer

**Not built.** EPUB/CBZ/PDF rendering is its own product: pagination, TOC, images, and hostile book HTML. Rendering that HTML inside Takio's webview creates a worse trust position than using an OS application.

**Gate — any one with evidence:**

- Repeated reports that a target platform lacks a usable default handler for a core format.
- A demanded feature requires in-app rendering, such as reading position or item-linked annotations.
- A real-flow usability review shows the app-to-OS-app round trip breaks the core journey.

If gated in: start read-only with EPUB and CBZ; keep PDF in the OS; render untrusted content in a sandboxed frame with no Tauri IPC exposure. Editing remains separate.

## Deferred subproduct 2 — Editor

**Not built.** There is no demand, and the library contract has no `update` operation.

**Two demand gates:**

- Metadata tier: the first concrete request to change stored item metadata. Add one `update` store operation and one CLI command. This is not a content editor.
- Content tier: repeated demonstrated demand to modify book internals. Only then design an editor.

If content editing is gated in, scope it to EPUB. MOBI/AZW3/PDF round trips are lossy and remain out of scope. Preserve untouched zip-entry bytes. Save atomically in the same directory: write and verify a temporary file, `fsync`, then rename while retaining the old bytes until verification succeeds.

## Deferred subproduct 3 — Content server

**Not built.** A network listener is a standing security liability, and today there is nothing to serve that `library open` does not cover.

**Gate:** concrete demand to read library items from another device/browser, or a future Horizon 4 device-agent protocol that needs an HTTP artifact channel. It is also blocked until artifacts and the queue exist.

If gated in, these requirements are non-negotiable:

- Off by default. Start only through explicit `takio serve`; stop with the process. No daemon, autostart, or persisted enablement.
- Bind to `127.0.0.1` by default. Non-loopback binding requires an explicit flag and configured authentication.
- Authenticate even on loopback with a per-run cryptographically random bearer token printed once; compare in constant time.
- Expose routes such as `/items/:id/file`; resolve IDs through `LibraryStore.get` and the same extension allowlist. Requests never contain filesystem paths. No static root, directory listing, or arbitrary file exposure.
- Read-only. Derive content types from `FORMAT_CATALOG` and stream files rather than buffering them.
- Use `Bun.serve`; add no HTTP framework.
- Process exit fully disables the server; removing the command removes the surface, with no state to clean up.

## Non-goals and deferred work

- No viewer, editor, server code, scaffolding, interfaces, or adapters "for later."
- No desktop change until store/IPC wiring lands. Then use a row-level native opener.
- No conversion-artifact opening, file watching, MIME database, or per-format viewer preferences.

## Success and exit criteria

- `bun run check` and `bun run test` pass with the new intent-focused tests.
- The manual macOS verification behaves exactly as documented.
- All four new error codes are reachable and tested; deleting the extension allowlist makes the security test fail.
- The document remains the explicit record that built-in viewer, editor, and server work is demand-gated rather than imminent.

## Blocking prerequisites

- Desktop Open is blocked by mock-only desktop state and absent store/IPC wiring.
- Content server is blocked by the absent artifacts/queue and its demand gate.
- The CLI MVP has no blocker and needs no new dependency.
