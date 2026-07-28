# Phase 2 exit benchmark — runbook

> **The claim** (PLAN.md §5): the red-team suite passes — no injection path exfiltrates a
> secret to an Observer; a session survives DO eviction, sandbox pause/resume, and 24h of
> wall-clock time with replay intact.

Two halves, run differently.

| Half              | How it runs                             | Where                                           |
| ----------------- | --------------------------------------- | ----------------------------------------------- |
| Red-team fixtures | Permanently in CI, every PR             | `packages/session-do/test/red-team.test.ts`     |
| Durability + soak | Against a **running** Worker, on demand | `packages/session-do/benchmark/phase-2.test.ts` |

The durability half cannot run in-process: eviction, hibernation and wall-clock are properties
of the platform, not of the test runtime. So it drives a real deployment — or `wrangler dev` —
over HTTP and WebSockets, exactly as a browser would.

## Run it

```bash
# Terminal 1 — the Worker under test
pnpm --filter @side-street/session-do dev

# Terminal 2 — the benchmark (60s soak by default)
SIDE_STREET_BASE_URL=http://127.0.0.1:8787 \
  pnpm --filter @side-street/session-do benchmark
```

Without `SIDE_STREET_BASE_URL` the suite skips itself, so `pnpm test` stays offline and fast.
It is deliberately not in the Turborepo pipeline: the real run takes a day.

| Variable                  | Default | Meaning                                                   |
| ------------------------- | ------- | --------------------------------------------------------- |
| `SIDE_STREET_BASE_URL`    | —       | Worker origin. Required; absent means skip.               |
| `SIDE_STREET_SOAK_MS`     | `60000` | Soak duration. **`86400000` is the real phase-exit run.** |
| `SIDE_STREET_IDLE_MS`     | `30000` | Quiet window used to provoke an eviction.                 |
| `SIDE_STREET_RESTART_CMD` | —       | Command that bounces the Worker; makes eviction certain.  |

Traffic is spread over ~500 rounds however long the soak is, so a 24-hour run costs the same
number of events as a one-minute run — only the gaps get longer. The gaps are the point: they
are when a Durable Object gets evicted and a WebSocket hibernates.

### Deterministic eviction

`SIDE_STREET_RESTART_CMD` runs any command that bounces the Worker; the benchmark then waits
for the origin to answer again before continuing. Locally that is a kill-and-relaunch of
`wrangler dev` (it persists to `.wrangler/state`, so the session survives):

```bash
cat > restart-worker.sh <<'SH'
#!/usr/bin/env bash
pkill -f "wrangler dev" ; sleep 2
(cd packages/session-do && nohup npx wrangler dev --port 8787 --ip 127.0.0.1 > /tmp/wrangler.log 2>&1 &)
exit 0
SH
chmod +x restart-worker.sh

SIDE_STREET_BASE_URL=http://127.0.0.1:8787 \
SIDE_STREET_RESTART_CMD=./restart-worker.sh \
  pnpm --filter @side-street/session-do benchmark
```

Against a deployment, `wrangler deploy` works the same way — a new version means new instances.
The command must **exit** once the restart is issued (hence `&` and `exit 0`), or the benchmark
waits on it forever.

### The real 24-hour run

```bash
SIDE_STREET_BASE_URL=https://<your-worker>.workers.dev \
SIDE_STREET_SOAK_MS=86400000 \
  pnpm --filter @side-street/session-do benchmark
```

Run it detached (`nohup`, `tmux`, a CI job with a 25-hour timeout) and keep the output — the
per-round log line is the evidence. A failure prints the round number it broke in.

## What each phase asserts

1. **Seed and redaction.** A declared credential is echoed by the agent in prose and in tool
   output. It must appear in neither the Observer's live frames nor the replay.
2. **DO eviction.** After the quiet window (or the restart), the Driver's next steer is
   accepted — proving the roster and the wheel were rebuilt from durable storage, not held in
   memory — and `/verify` still returns valid over a longer chain.
3. **Sandbox pause/resume.** The agent bridge dies holding an approved step and a new one
   attaches. The session must log `step_unresolved` with `approved_unfinished` and the key that
   ran, and the chain must still verify.
4. **Soak.** Every round pushes events and steers, and asserts `/verify` after each one. At the
   end: compaction has bounded the replay (`from=checkpoint` is strictly shorter than
   `from=0`), the replay is contiguous and prevHash-linked, and the credential never appears.

## Reading a failure

- **Phase 1 fails** → a redaction path regressed. The red-team suite in CI should have caught
  it; if it didn't, add the case there first — that is where the fixtures live permanently.
- **Phase 2 fails with a `steer_rejected`** → state that should be durable was in memory. Look
  at `SessionActorSnapshot` and what `persistState` writes.
- **Phase 3 fails** → an orphaned step went unreported (silence is the failure mode this exists
  to prevent, see ADR-0004).
- **Phase 4 fails mid-soak** → the printed round number is the first broken one; `/verify`
  returns `firstInvalidSeq` for the exact event.

## Limits worth stating

- **Eviction is only certain with `SIDE_STREET_RESTART_CMD`.** Without it we rely on the quiet
  window, and Cloudflare gives no signal that an eviction happened. Locally, bouncing
  `wrangler dev` is a true cold start: the process holding every in-memory instance is gone, so
  anything the session still knows came from storage. This has been verified by hand — a
  179-event session's chain and checkpoint state survived a full restart of the dev server.
- **The chain is verified server-side.** Any session that declared a credential gets a
  _redacted_ replay, and a redacted event keeps the hash of its canonical form on purpose
  (`packages/redaction`), so a client shown a secret-free view cannot re-hash it. The benchmark
  checks what a client still can — seq contiguity and prevHash linkage — and takes `/verify` as
  the authority on hashes. Making redacted views independently verifiable (per-field commitments
  rather than a whole-body hash) is a Phase 3+ question, not a Phase 2 gap.
- **"Sandbox pause/resume" is exercised at the session boundary**, i.e. the bridge process
  dying and a new one attaching — which is precisely what a paused-and-resumed sandbox looks
  like to the session, because the runner exits when its socket closes. Pausing a real E2B
  microVM additionally exercises the vendor's own resume path; run
  `pnpm --filter @side-street/sandbox test` with `E2B_API_KEY` set for that.
