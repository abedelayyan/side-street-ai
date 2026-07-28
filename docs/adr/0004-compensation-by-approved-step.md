# ADR-0004: Idempotency keys are minted per approved step, not per tool call

- **Status:** Accepted
- **Date:** 2026-07-28
- **Deciders:** project founder

## Context

PLAN.md §3 locks the principle: anything that hit a remote system gets **compensation, not
rollback**, and every side-effecting tool call carries an idempotency key
`(session_id, step_id, attempt)`. The Phase 2 deliverable turns that into code.

The obvious `step_id` is the ACP `toolCallId`. It is also useless for this purpose: agents
mint a fresh `toolCallId` every time they retry, so a replayed turn — the exact case the key
exists for — produces a _new_ id and looks like a first attempt. That is the "checkpoint
illusion" §3 names as a known failure mode: state that looks restored while a remote system
has already been written to.

The second force is the shape of what we own. Side Street wraps agents (ADR-0002); the tool
runs inside the sandbox, under the agent's control, and ACP's `request_permission` response
carries no field for an idempotency key. We cannot make the agent's outbound HTTP call carry
ours. What we _can_ do is know — and say — that an action is being run again.

## Decision

`step_id` is a SHA-256 prefix of the **approval prompt**: the exact text a human was shown
and agreed to. Two requests that read identically are the same step, whatever ids the agent
attached to them. `attempt` counts approvals of that step within the session and is stamped
onto the `permission_decision` event; a denial runs nothing, so it burns no attempt. The
counter lives in the session actor's snapshot and therefore survives hibernation and Durable
Object eviction.

The key is **recorded and surfaced, not injected**. It is written into the hash-chained log,
so "this exact action was approved three times" is an auditable fact rather than a guess, and
`permission_request` carries `priorAttempts` so the Driver is warned _before_ approving a
repeat. A step approved but never observed to finish is surfaced on restore as an explicit
replay-or-fork choice for the Driver rather than silently re-run.

## Consequences

Duplicate work becomes visible with no cooperation from the backing agent, which is what
makes this worth shipping now: a prompt-injected loop that asks to POST the same endpoint
twenty times is twenty warnings on the Driver's screen, each requiring a human click.

What we give up: the key does not reach the remote system, so it cannot dedupe server-side.
That needs a Side Street-aware tool wrapper (an MCP server we ship, or an ACP extension
field) — the interface is ready for it, nothing else has to change.

Two known edges, both deliberate. Hashing the prompt means an agent that varies its wording
for the same action produces a new `step_id` and no warning — prompts are agent-authored, so
this is a floor, not a guarantee. And two _genuinely_ distinct actions that read identically
share a `step_id`, which costs an unnecessary warning; over-warning on a side effect is the
right direction to be wrong in.

We revisit if backing agents start exposing stable step identity of their own, or if the
warning proves noisy enough in the Phase 2 exit benchmark that Drivers click through it.
