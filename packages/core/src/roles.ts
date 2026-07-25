/**
 * The three-role steering model (PLAN.md §3).
 *
 * Only the Driver is authoritative: single-Driver authority is a correctness
 * requirement, because concurrent injection into one agent context window
 * produces incoherent prompts. Navigators queue suggestions behind the
 * Driver; Observers are strictly read-only.
 */

import { z } from "zod";

export const ROLES = ["driver", "navigator", "observer"] as const;

export const roleSchema = z.enum(ROLES);

export type Role = z.infer<typeof roleSchema>;

/** Steer the agent directly: authoritative messages, hard-interrupt, handoff initiation. */
export function canSteer(role: Role): boolean {
  return role === "driver";
}

/** Approve or deny side-effecting tool calls (the ACP request_permission path). */
export function canApproveTools(role: Role): boolean {
  return role === "driver";
}

/** Submit suggestions that queue behind the Driver's messages. */
export function canSuggest(role: Role): boolean {
  return role === "driver" || role === "navigator";
}
