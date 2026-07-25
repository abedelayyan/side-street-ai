import { describe, expect, it } from "vitest";
import { eventBodySchema } from "@side-street/core";
import { sessionUpdateSchema } from "../src/protocol.js";
import { toEventBody, turnEndedBody } from "../src/to-event-body.js";

describe("toEventBody", () => {
  it("maps agent_message_chunk, tool_call, and tool_call_update to valid event bodies", () => {
    const updates = [
      { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi" } },
      { sessionUpdate: "tool_call", toolCallId: "t1", title: "Edit file", status: "pending" },
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "t1",
        status: "completed",
        content: [
          { type: "text", text: "3 tests " },
          { type: "text", text: "passed" },
        ],
      },
    ];
    for (const raw of updates) {
      const body = toEventBody(sessionUpdateSchema.parse(raw));
      expect(body).not.toBeNull();
      expect(eventBodySchema.safeParse(body).success, JSON.stringify(body)).toBe(true);
    }
  });

  it("concatenates tool output blocks and omits output when absent", () => {
    const withOutput = toEventBody(
      sessionUpdateSchema.parse({
        sessionUpdate: "tool_call_update",
        toolCallId: "t1",
        status: "completed",
        content: [
          { type: "text", text: "a" },
          { type: "text", text: "b" },
        ],
      }),
    );
    expect(withOutput).toMatchObject({ payload: { output: "ab" } });

    const withoutOutput = toEventBody(
      sessionUpdateSchema.parse({
        sessionUpdate: "tool_call_update",
        toolCallId: "t1",
        status: "failed",
      }),
    );
    expect(withoutOutput).toMatchObject({ type: "tool_call_update" });
    expect((withoutOutput as { payload: object }).payload).not.toHaveProperty("output");
  });

  it("returns null for unknown update kinds instead of throwing", () => {
    const parsed = sessionUpdateSchema.parse({ sessionUpdate: "plan", entries: [] });
    expect(toEventBody(parsed)).toBeNull();
  });

  it("produces a valid turn_ended body for every stop reason", () => {
    for (const stopReason of ["end_turn", "max_tokens", "refusal", "cancelled"] as const) {
      expect(eventBodySchema.safeParse(turnEndedBody(stopReason)).success).toBe(true);
    }
  });
});
