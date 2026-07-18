# Packet 002 — Core Declaration Build Repair

**Horizon:** Foundation

**Trigger:** Packet 001 integration review found that `@takio/core` advertises declaration files through its `types` contract, but its tracked build command does not generate them from a clean checkout.

**Objective:** Make the existing `@takio/core` build reproducibly emit the declaration files its package contract references.

## Scope

**In scope**

- `packages/core/package.json` and the minimum existing TypeScript configuration change, if needed, to emit declarations as part of the tracked core build.
- A focused regression test or clean-build verification procedure if it can be expressed without adding dependencies.

**Out of scope**

- Library-domain behavior, CLI, desktop, converter work, new dependencies, package API changes, and broad build-system redesign.

## Required behavior

1. After deleting `packages/core/dist`, `bun run --filter '@takio/core' build` creates `dist/index.js` and the declaration file referenced by `@takio/core`’s `types` field.
2. A subsequent clean `bun run check`, `bun run test`, and `bun run build` succeeds without relying on pre-existing ignored artifacts.
3. The runtime bundle behavior remains unchanged.

## Required evidence

- Show the clean-artifact removal and rebuild command/output.
- Show the generated declaration file exists.
- Show all workspace checks, tests, and build pass after the clean rebuild.
- Review the diff for narrow scope.

## Micro-commit requirement

After verification passes, create exactly one commit:

```text
fix(core): emit package declarations
```

## Rollback

Revert the single commit; no public runtime behavior or stored data changes.
