# CLAUDE.md — Side Street working agreement

Side Street is the **open-source multiplayer layer for coding agents**: shared, durable,
steerable agent sessions with tamper-evident attribution. We wrap existing agents (Claude
Code, Codex, Gemini CLI) via the Agent Client Protocol — **we never build our own coding
agent**.

## Source of truth

**`docs/PLAN.md` governs everything.** Before starting any task:

1. Identify which phase and deliverable in `docs/PLAN.md` the task serves.
2. If it serves none, stop — either the task is out of scope, or the plan needs an amendment
   PR _first_ (and locked architecture decisions additionally need an ADR in `docs/adr/`).
3. Check the current phase's exit benchmark; work that doesn't move a benchmark is suspect.

Background context lives in `docs/research/2026-07-multiplayer-ai-foundation.md`. Facts in it
(pricing, vendor limits, agent steering behavior) are mid-2026 snapshots — re-verify against
primary docs before writing code that depends on them.

## Architecture invariants (never violate; full detail in PLAN.md §3)

- The event log is **append-only**; corrections are new events, never mutations.
- Every event has an **author identity** and is **hash-chained**.
- The Durable Object does minimal per-message work (append + broadcast); heavy work goes to the sandbox.
- **Secrets never enter prompts**; redaction runs **before** any broadcast, per viewer role.
- Only the **Driver** is authoritative; Navigator queues, Observer is read-only. This is correctness, not polish.
- Remote side effects get **compensation + idempotency keys**, never blind rollback.
- Sandbox providers and backing agents are **swappable interfaces** — no hard-coded vendor dependencies.

## Development workflow

- **Stack:** TypeScript `strict` everywhere; pnpm workspaces + Turborepo; Vitest; ESLint + Prettier; zod schemas at every trust boundary (WebSocket, ACP, sandbox I/O).
- **Branches:** trunk-based; short-lived `feat/…`, `fix/…`, `docs/…`, `chore/…` branches off `main`; squash-merge via PR only.
- **Commits:** Conventional Commits (`feat:`, `fix:`, `docs:`, `test:`, `refactor:`, `chore:`), imperative mood, ≤72-char subject.
- **PRs:** small (< ~400 lines where possible), green CI, description states what + why + which PLAN.md deliverable it advances.
- **Tests:** new logic ships with tests. The hash chain, redaction pipeline, steering queue, and replay logic require exhaustive coverage — they _are_ the product. Red-team prompt-injection fixtures stay in CI permanently and must never be weakened to make a build pass.
- **No `any`** in `packages/core`, `packages/redaction`, or protocol code.
- **No secrets in the repo, ever** — including examples, fixtures, and docs.
- **Releases:** changesets → semver → signed tag; never bump versions by hand.

## Quality bar

- Neat and tidy is a requirement: consistent formatting (Prettier is authoritative), no dead
  code, no commented-out blocks, no TODOs without a linked issue.
- Public-facing output (README, docs, errors, UI copy) is part of the product — write it to
  the same standard as the code. This project will be judged publicly as open source.
- Match existing patterns in a package before introducing new ones.

## Definition of done

A task is done when: code + tests merged, CI green, relevant docs updated
(`docs/protocol.md` for wire changes, ADR for decision changes), and the corresponding
PLAN.md checkbox can honestly be ticked. If a phase exit benchmark is affected, run it.

## When context is missing

Prefer reading `docs/PLAN.md` §3 (decisions), §5 (current phase), and §6 (practices) over
guessing. If a decision genuinely isn't covered, propose a plan amendment rather than
improvising architecture.
