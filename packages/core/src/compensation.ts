/**
 * Idempotency keys for side-effecting tool calls (PLAN.md §3.7: anything that
 * hit a remote system gets compensation, not rollback, and every
 * side-effecting call carries a key `(session_id, step_id, attempt)`).
 *
 * `stepId` identifies the *action*, not the tool call. Agents mint a fresh
 * `toolCallId` for every retry, so keying off it would make each retry look
 * like a first attempt — precisely the "checkpoint illusion" this is here to
 * catch. Hashing the approval prompt instead means the same action, asked for
 * twice, lands on the same `stepId`, and `attempt` is what separates a
 * deliberate repeat from a duplicate nobody meant to run.
 */

import { z } from "zod";

export const idempotencyKeySchema = z.object({
  sessionId: z.string().min(1),
  stepId: z.string().min(1),
  /** 1 for the first approval of this step in this session. */
  attempt: z.number().int().positive(),
});
export type IdempotencyKey = z.infer<typeof idempotencyKeySchema>;

/**
 * Stable id for the action described by an approval prompt — the exact text
 * the human is asked to approve, so two prompts that read identically are the
 * same step.
 * ponytail: 64 bits of SHA-256. Wide enough that an accidental collision
 * within one session is not a real risk; not a security boundary (nobody is
 * authenticated by a stepId).
 */
export async function stepIdFor(title: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(title));
  return Array.from(new Uint8Array(digest).slice(0, 8), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}
