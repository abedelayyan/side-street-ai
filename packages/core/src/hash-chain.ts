/**
 * Tamper-evident hash chain over the session event log (PLAN.md §3).
 *
 * Each event's hash covers its full unsigned form — including `prevHash` —
 * so editing, dropping, or reordering any historical event invalidates every
 * subsequent hash. Uses WebCrypto SHA-256, available in Workers, Node ≥ 20,
 * and browsers alike.
 */

import { canonicalStringify } from "./canonical-json.js";
import {
  SCHEMA_VERSION,
  signedEventSchema,
  type EventBody,
  type SignedEvent,
  type UnsignedEvent,
} from "./events.js";

/** prevHash of the first event in a session. */
export const GENESIS_HASH = "0".repeat(64);

export async function computeEventHash(event: UnsignedEvent): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalStringify(event));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

export interface AppendInput {
  authorId: string;
  body: EventBody;
  ts: number;
}

/**
 * Seal a new event onto the chain. `log` only needs its last element; pass
 * the full log or just `[lastEvent]` — the caller owns persistence.
 */
export async function appendEvent(
  log: readonly SignedEvent[],
  input: AppendInput,
): Promise<SignedEvent> {
  const last = log[log.length - 1];
  const unsigned: UnsignedEvent = {
    v: SCHEMA_VERSION,
    seq: last === undefined ? 0 : last.seq + 1,
    ts: input.ts,
    authorId: input.authorId,
    body: input.body,
    prevHash: last === undefined ? GENESIS_HASH : last.hash,
  };
  return { ...unsigned, hash: await computeEventHash(unsigned) };
}

export type VerifyResult =
  { valid: true; length: number } | { valid: false; firstInvalidSeq: number; reason: string };

/**
 * Verify a contiguous log slice. `expectedPrevHash` defaults to the genesis
 * hash; pass the hash preceding the slice to verify a tail on its own.
 */
export async function verifyChain(
  events: readonly SignedEvent[],
  expectedPrevHash: string = GENESIS_HASH,
): Promise<VerifyResult> {
  let prevHash = expectedPrevHash;
  let expectedSeq = events[0]?.seq ?? 0;

  for (const event of events) {
    const parsed = signedEventSchema.safeParse(event);
    if (!parsed.success) {
      return { valid: false, firstInvalidSeq: event.seq, reason: "malformed event" };
    }
    if (event.seq !== expectedSeq) {
      return {
        valid: false,
        firstInvalidSeq: event.seq,
        reason: `non-contiguous seq: expected ${expectedSeq}, got ${event.seq}`,
      };
    }
    if (event.prevHash !== prevHash) {
      return { valid: false, firstInvalidSeq: event.seq, reason: "broken prevHash link" };
    }
    const { hash, ...unsigned } = event;
    if ((await computeEventHash(unsigned)) !== hash) {
      return { valid: false, firstInvalidSeq: event.seq, reason: "hash mismatch" };
    }
    prevHash = hash;
    expectedSeq += 1;
  }

  return { valid: true, length: events.length };
}
