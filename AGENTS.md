# Takio development

Takio is a simple, local-first native book-library manager. The core journey is
add existing books, organize and find them, then send a compatible copy to a
reader. Calibre feature parity is not the product goal.

Before choosing product work, read `docs/plans/2026-10-22-focused-native-library.md`.
It supersedes earlier expansion roadmaps for prioritization. For native UI work,
also read `docs/specs/gpui-desktop.md`. For file ownership or device changes,
read the relevant existing engine implementation and tests first.

## Autonomous iteration

1. Inspect the working tree and current acceptance evidence. Preserve unrelated
   changes and use isolated temporary libraries, never the user's real books.
2. Pick the smallest incomplete core-journey acceptance criterion. Record the
   intended behavior and a reproducible check before implementation.
3. Reuse the Rust library engine. Keep filesystem and database work off the UI
   thread, retain typed results, and surface partial failures honestly.
4. Exercise the changed workflow through native state integration tests and,
   where available, the actual app. Run formatting, native tests, and strict
   native Clippy. Run CLI tests when shared engine behavior changes.
5. Review safety and error paths, update the plan with observed evidence and
   remaining blockers, and commit a coherent tested slice. Continue to the next
   core gap within the current authorized session.

Ask before destructive changes to real data, account access, publishing, or
hardware writes outside an explicitly requested user workflow. Copy is the
default import mode. Purge and moving originals require explicit confirmation.
Never claim a simulated destination test proves physical Kindle compatibility.
Do not install a background self-modifying service or schedule unbounded work.
