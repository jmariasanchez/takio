# Takio

**Takio** is a lightweight, modern, minimalist alternative to Calibre.

It is a Bun monorepo with two deliberate product surfaces:

- **Desktop (`@takio/desktop`)** — a native Tauri application for people who want a calm, local-first library and conversion workspace.
- **CLI (`@takio/cli`)** — a structured, scriptable interface intended for AI agents, skills, automations, and power users.

The domain package (`@takio/core`) is shared by both surfaces, so a conversion request means the same thing whether it originates in the desktop app, a shell, or an agent skill.

## Current milestone

The workspace currently includes a polished Tauri/React desktop shell and a functional CLI conversion planner. It validates formats, plans jobs, and selects a compatible device. Converter adapters and real remote-device execution are the next milestone.

## Requirements

- [Bun](https://bun.sh/) 1.3+
- Rust/Cargo plus Xcode Command Line Tools for Tauri desktop builds

> This machine currently has Bun, but Rust/Cargo is not installed. The CLI and web UI build can be verified now; `bun run desktop` requires installing Rust first.

## Quick start

```bash
bun install
bun run build
bun run test

# Agent-friendly CLI commands
bun run takio formats --json
bun run takio devices
bun run takio plan --input ~/Books/example.epub --to pdf --json

# Native desktop app (after Rust/Cargo is installed)
bun run desktop
```

## CLI contract for skills and agents

The CLI is deliberately deterministic and supports JSON responses for consumption by tools:

| Command | Purpose |
| --- | --- |
| `takio formats --json` | Reads the built-in format catalogue. |
| `takio devices` | Lists known conversion devices. |
| `takio plan --input <path> --to <format> --json` | Validates a request and creates a machine-readable conversion plan. |

A plan is not execution. Until a converter adapter is installed, Takio never misrepresents a planned job as a converted artifact.

## Workspace

```text
apps/desktop       Tauri v2 + React minimalist native UI
apps/cli           Bun-powered CLI for agents and scripts
packages/core      Shared formats, request validation, device planner
docs/              Architecture and implementation records
```

## Quality commands

```bash
bun run check
bun run test
bun run build
```

Read [the architecture](docs/architecture.md) for the execution, multi-device, and security roadmap.
