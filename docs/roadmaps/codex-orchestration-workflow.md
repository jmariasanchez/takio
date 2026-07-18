# Codex Delegation and Orchestration Workflow

> Abstract operating model for delivering Takio through the Codex CLI. It governs work; it is not an implementation plan.

## Purpose

Use Codex as a focused delivery worker, not as an autonomous product manager. An orchestrator owns roadmap sequencing, task boundaries, review evidence, and merge decisions. Codex implements small, independently verifiable packets in isolated worktrees.

## Roles

| Role | Responsibility | Write authority |
| --- | --- | --- |
| **Roadmap steward** | Maintains the Claude-generated horizons, priorities, and explicit non-goals. | Roadmap documents only |
| **Orchestrator** | Converts one horizon into ordered packets, assigns work, evaluates evidence, and controls integration. | Integration branch only |
| **Codex implementer** | Delivers exactly one approved packet in an isolated worktree. | Assigned worktree and packet scope |
| **Spec reviewer** | Independently checks that requirements, boundaries, and acceptance criteria were met. | None |
| **Quality reviewer** | Independently checks correctness, security, test value, maintainability, and scope discipline. | None |
| **Human release owner** | Approves high-risk changes and public releases. | Final merge/release authority |

## Horizon-to-Packet Flow

1. **Select one horizon outcome.** Do not work across horizons unless the roadmap steward explicitly promotes a dependency.
2. **Define a packet.** A packet has one objective, a bounded surface, explicit in-scope and out-of-scope statements, acceptance criteria, verification evidence, and a rollback path.
3. **Classify risk.** Ordinary packets can proceed through automated gates. Contract, migration, authentication, device-protocol, capability-permission, and release packets require human approval before merge.
4. **Create an isolated worktree.** One Codex session owns one packet. Parallel Codex work is permitted only when packet scopes do not overlap.
5. **Delegate to Codex.** The prompt contains the complete packet, repository context, mandatory checks, and an instruction not to expand scope.
6. **Collect evidence.** Codex returns the diff, command transcripts, test result, caveats, and an explicit statement of remaining unverified assumptions.
7. **Review in order.** A read-only spec review must pass before a read-only quality review. Findings go back to a fresh Codex fix packet; reviews repeat until clean.
8. **Create the packet micro commit.** After all packet-local checks pass, Codex creates exactly one focused conventional commit containing only that packet. The commit message names the outcome; unrelated formatting or cleanup is excluded.
9. **Integrate one packet at a time.** The orchestrator reruns the required shared checks in the integration context, verifies the rollback path, and merges only green work.

## Codex Packet Contract

Every prompt sent to Codex must specify:

- the product-horizon outcome it advances;
- a single, observable objective;
- allowed and prohibited scope;
- relevant domain contracts and compatibility requirements;
- acceptance criteria stated as behaviors, not implementation preference;
- required verification commands and expected evidence;
- the required micro-commit message after verification passes;
- the rule that it must stop and report a blocker rather than invent missing requirements.

Codex must not change a shared contract, add a dependency, alter storage migrations, modify auth, or touch release configuration unless the packet explicitly authorizes it.

## Required Gates

| Gate | Decision | Required evidence |
| --- | --- | --- |
| **Machine gate** | Is the packet mechanically healthy? | Typecheck, tests, lint/build output, and relevant smoke checks |
| **Spec gate** | Did it meet the stated objective without omission or scope creep? | Independent reviewer verdict tied to acceptance criteria |
| **Quality gate** | Is it safe, understandable, maintainable, and appropriately simple? | Independent reviewer verdict and resolved findings |
| **Risk gate** | Is a high-consequence change acceptable to introduce? | Human approval, threat/migration/release plan, and rollback decision |
| **Integration gate** | Does it still work with the current main branch? | Fresh shared verification from the integration worktree |

A failed gate returns work to a new focused Codex packet. A gate is never bypassed because an agent claims success.

## Evidence Standard

A packet is incomplete without:

- a reviewable diff;
- exact verification transcripts or CI links;
- structured test results where the interface is machine-readable;
- spec and quality review verdicts with reasons;
- the Codex model/tool identity and permission mode used;
- a list of unverified assumptions, skipped tests, and blockers.

## Rollback and Failure Policy

- Each packet is merged as one revertible unit on a green main branch.
- The orchestrator records a revert or recovery path before merge.
- Storage-shape changes require a tested migration path or an explicit irreversible-change approval.
- A red main freezes new work until a verified revert or fix-forward restores the shared gates.
- If Codex, a review tool, or a dependency is unavailable, the orchestrator records a blocker and does not substitute unverified claims.

## Operating Principles

- Contracts before consumers.
- One packet, one owner, one accountable outcome.
- Independent review is not delegated to the implementer.
- Parallelism is earned by non-overlapping scopes, not assumed.
- Humans approve irreversible or trust-boundary changes.
- Completion is evidence, not narrative.

## Toolchain Preconditions

The workflow becomes executable after the repository has a working, authenticated Codex CLI installation. This machine currently has Claude Code authenticated and has no available `codex` executable; therefore this document defines the operating model but does not claim Codex delegation has begun.
