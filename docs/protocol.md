# Side Street session protocol — v0 (draft)

Authoritative spec for the session event log, steering semantics, and transport implemented
in `@side-street/core`, `@side-street/session`, and `@side-street/session-do`. Breaking
changes to anything here require an RFC issue first (PLAN.md §6).

## Event envelope

Every observable fact in a session is one event in an append-only log. Events are never
mutated or deleted; corrections are new events.

| Field      | Type               | Meaning                                               |
| ---------- | ------------------ | ----------------------------------------------------- |
| `v`        | `1`                | Envelope schema version                               |
| `seq`      | integer ≥ 0        | Position in the log; contiguous, starts at 0          |
| `ts`       | integer (epoch ms) | Assigned by the session actor (single writer)         |
| `authorId` | string             | Participant id, or `"agent"` / `"system"`             |
| `body`     | tagged union       | `{ type, payload }` — see event types below           |
| `prevHash` | 64-char hex        | Hash of the previous event; genesis value is 64 zeros |
| `hash`     | 64-char hex        | SHA-256 over the canonical JSON of all fields above   |

**Canonical JSON**: object keys sorted recursively; `undefined`, non-finite numbers, and
non-plain objects are rejected (never silently coerced). Two structurally equal events always
hash identically on every runtime.

**Tamper evidence**: `hash` covers `prevHash`, so editing, dropping, reordering, or
re-signing any historical event breaks verification at (or immediately after) the altered
position. A log tail can be verified independently given the hash of the event preceding it.

## Event types

| Type                  | Author        | Payload (summary)                                            |
| --------------------- | ------------- | ------------------------------------------------------------ |
| `session_started`     | system        | `sessionId`, `agent`, `sandboxProvider`                      |
| `participant_joined`  | the joiner    | `participantId`, `displayName`, `role`                       |
| `participant_left`    | the leaver    | `participantId`                                              |
| `role_changed`        | actor causing | `participantId`, new `role`                                  |
| `control_handoff`     | requester     | `fromParticipantId`, `toParticipantId`                       |
| `human_message`       | the human     | `text`, `delivery: "queue" \| "interrupt"`                   |
| `agent_message_chunk` | agent         | `text` (token-level streaming)                               |
| `tool_call`           | agent         | `toolCallId`, `title`, `status`                              |
| `tool_call_update`    | agent         | `toolCallId`, `status`, optional `output`                    |
| `permission_request`  | agent         | `requestId`, `toolCallId`, `title`, `options[]`              |
| `permission_decision` | the Driver    | `requestId`, `outcome` (selected optionId or cancelled)      |
| `turn_ended`          | agent         | `stopReason: end_turn \| max_tokens \| refusal \| cancelled` |
| `checkpoint`          | system        | `summary`, optional `snapshotRef`                            |

Tool-call statuses: `pending`, `in_progress`, `completed`, `failed`, `cancelled`.

## Steering semantics

Roles: **Driver** (steers, interrupts, approves tools — at most one holds the wheel),
**Navigator** (suggests; queued behind the Driver), **Observer** (read-only).

1. Rejected submissions (Observer messages, non-Driver interrupts, steering by a
   driver-capable participant who doesn't hold the wheel) are returned privately to the
   sender and **never** enter the log.
2. Accepted submissions are logged as `human_message` with the author's identity and
   role-at-submission-time, then queued.
3. A Driver message to an **idle** agent starts a turn immediately, carrying any queued
   Navigator suggestions behind it (Driver messages always lead the delivered batch).
4. During a **running** turn, the queue drains at the next tool-call boundary — a
   `tool_call_update` with status `completed` or `failed`.
5. Navigator suggestions alone never initiate a turn; they wait for Driver action or a
   boundary of an already-running turn.
6. **Hard-interrupt** (Driver only): cancels the running turn (ACP `session/cancel`); when
   the turn ends with `stopReason: cancelled`, the queue — led by the interrupt message —
   becomes the next prompt. Duplicate interrupts while a cancel is in flight do not send a
   second cancel.
7. **Take the wheel**: only the current Driver hands off; a driverless wheel can be claimed
   by any non-Observer. The Driver leaving frees the wheel. Every transfer is logged as
   `control_handoff`.

## Replay

A late joiner or reconnecting client requests events from a `seq` offset and receives the
ordered tail, then live events. Clients can verify the tail's chain by supplying the hash of
the event preceding the offset. Checkpoint-plus-tail compaction (Phase 2) will bound replay
size; the `checkpoint` event type reserves the hook.

## Transport (Durable Object wire protocol)

Each session lives at `/session/:id` on the Worker; the id maps to one Durable Object.
Three surfaces:

### `GET /session/:id/ws` — viewer socket (WebSocket upgrade)

Join parameters (query): `participantId`, `displayName`, `role`. **v0 trusts these
parameters; authenticated identity is a Phase 2 deliverable — do not expose v0 beyond
development environments.**

Viewer → server frames:

| Frame     | Fields                                           | Meaning                                   |
| --------- | ------------------------------------------------ | ----------------------------------------- |
| `steer`   | `id`, `text`, `delivery: "queue" \| "interrupt"` | Submit a steering message                 |
| `handoff` | `toParticipantId`                                | Hand off / claim the wheel                |
| `decide`  | `requestId`, `outcome`                           | Answer a permission request (Driver only) |

Server → viewer frames:

| Frame            | Fields                             | Meaning                                                      |
| ---------------- | ---------------------------------- | ------------------------------------------------------------ |
| `welcome`        | `participantId`, `role`, `lastSeq` | Sent once on join; `lastSeq` tells the client what to replay |
| `event`          | `event` (signed envelope)          | Live fan-out of every appended event                         |
| `steer_rejected` | `messageId`, `reason`              | Private rejection (sender only; never broadcast)             |
| `error`          | `message`                          | Malformed frame                                              |

A participant's departure is logged only when their last open socket closes (multi-tab and
reconnect races keep them present).

**Redaction**: every `event` frame is passed through the redaction pass, keyed by the
recipient socket's role, before it is sent (`@side-street/redaction`; PLAN.md invariant 5).
Secrets are stripped and replaced with `[redacted:<label>]`. A redacted event keeps the
canonical `hash` (the frame is a per-role view of the stored event), so a viewer that
received redacted content cannot re-hash locally and verifies via `/verify` instead;
secret-free events are unchanged and verify normally. The default policy redacts for every
role — the Observer floor applied to all.

### `GET /session/:id/agent` — agent bridge socket (WebSocket upgrade)

Connected by the sandbox-side ACP bridge. Server → bridge frames: `prompt` (attributed
`messages` to deliver to the agent), `cancel` (hard-interrupt), and `permission_decision`
(`requestId`, `outcome` — the Driver's answer to relay to the ACP agent). Bridge → server
frames: `agent_event` (a translated event body to append), `turn_ended` (`stopReason`), and
`permission_request` (`requestId`, `toolCallId`, `title`, `options[]` — the agent is asking
to run a side-effecting tool). Server→bridge frames emitted while the bridge is disconnected
are buffered durably and flushed in order on (re)connect.

**Approval gates**: a `permission_request` from the agent is logged and broadcast, then held
pending — nothing runs until the **Driver** (the wheel-holder) sends a `decide` frame. A
non-Driver `decide` is privately rejected (`steer_rejected`) and the tool stays blocked; each
request is answered at most once. The pending set survives DO hibernation, so a Driver
decision after a reconnect still resolves the waiting tool call. If no Driver ever decides,
the tool stays blocked — the safe default for a gate.

### `GET /session/:id/verify` — chain verification

Re-verifies the full hash chain server-side and returns the result
(`{ valid: true, length }`, or `{ valid: false, firstInvalidSeq, reason }`), so any client or
auditor can check the log's integrity without downloading it.

### `GET /session/:id/events?from=N` — replay

Returns `{ events: [...] }` — the ordered tail with `seq >= N`. A late joiner connects the
viewer socket, reads `welcome.lastSeq`, fetches the tail it's missing, then applies live
`event` frames (deduplicating by `seq`).

## ACP mapping (informative)

`@side-street/acp-client` drives backing agents: `session/prompt` starts turns,
`session/update` notifications translate into `agent_message_chunk` / `tool_call` /
`tool_call_update` events (`toEventBody`), `session/cancel` realizes hard-interrupts, and
`session/request_permission` is surfaced to the Driver, whose decision is returned to the
agent (handler failure returns `cancelled` — deny, never allow, on error). ACP has no
mid-turn injection method, so boundary delivery is realized by the agent bridge as
cancel-then-reprompt until the protocol grows one.
