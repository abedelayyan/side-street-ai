import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { verifyChain, type SignedEvent } from "@side-street/core";
import { CHECKPOINT_EVERY } from "@side-street/session";
import { BASE, connect, freshSession, isEventOf, viewerPath } from "./harness.js";

describe("routing", () => {
  it("404s unknown paths and rejects non-upgrade ws requests", async () => {
    expect((await SELF.fetch(`${BASE}/nope`)).status).toBe(404);
    expect((await SELF.fetch(`${BASE}/session/abc/ws?x=1`)).status).toBe(426);
  });

  it("rejects invalid join parameters and bad replay offsets", async () => {
    const bad = await SELF.fetch(`${BASE}/session/abc/ws?participantId=a&role=admin`, {
      headers: { Upgrade: "websocket" },
    });
    expect(bad.status).toBe(400);
    expect((await SELF.fetch(`${BASE}/session/abc/events?from=-1`)).status).toBe(400);
  });
});

describe("session lifecycle over WebSocket", () => {
  it("sends welcome as the socket's first frame, before the joiner's own join event", async () => {
    const sessionId = freshSession();
    const alice = await connect(viewerPath(sessionId, "alice", "driver"));
    await alice.waitFor(isEventOf("participant_joined"));

    // A brand-new participant joining an existing session: if its own
    // participant_joined broadcast lands before welcome, the client's replay
    // cursor jumps past the history it never fetched (exit-benchmark regression).
    const bob = await connect(viewerPath(sessionId, "bob", "observer"));
    const bobJoin = await bob.waitFor(isEventOf("participant_joined"));
    expect(bob.frames[0]?.["type"]).toBe("welcome");
    const welcomeLastSeq = (bob.frames[0] as { lastSeq: number }).lastSeq;
    const joinSeq = (bobJoin as { event: { seq: number } }).event.seq;
    expect(welcomeLastSeq).toBeLessThan(joinSeq);
  });

  it("welcomes a joiner and streams attributed steering to all viewers", async () => {
    const sessionId = freshSession();
    const alice = await connect(viewerPath(sessionId, "alice", "driver"));
    const welcome = await alice.waitFor((f) => f["type"] === "welcome");
    expect(welcome).toMatchObject({ participantId: "alice", role: "driver" });

    const bob = await connect(viewerPath(sessionId, "bob", "observer"));
    await bob.waitFor((f) => f["type"] === "welcome");

    // Alice takes the wheel and steers; Bob sees both events live.
    alice.ws.send(JSON.stringify({ type: "handoff", toParticipantId: "alice" }));
    await bob.waitFor(isEventOf("control_handoff"));
    alice.ws.send(
      JSON.stringify({ type: "steer", id: "m1", text: "fix the flaky test", delivery: "queue" }),
    );
    const humanEvent = await bob.waitFor(isEventOf("human_message"));
    expect((humanEvent["event"] as { authorId: string }).authorId).toBe("alice");
  });

  it("privately rejects observer steering without broadcasting", async () => {
    const sessionId = freshSession();
    const alice = await connect(viewerPath(sessionId, "alice", "driver"));
    await alice.waitFor((f) => f["type"] === "welcome");
    const carol = await connect(viewerPath(sessionId, "carol", "observer"));
    await carol.waitFor((f) => f["type"] === "welcome");

    carol.ws.send(
      JSON.stringify({ type: "steer", id: "m9", text: "try again", delivery: "queue" }),
    );
    const rejection = await carol.waitFor((f) => f["type"] === "steer_rejected");
    expect(rejection).toMatchObject({ messageId: "m9", reason: "observers are read-only" });
    expect(alice.frames.filter(isEventOf("human_message"))).toHaveLength(0);
  });

  it("answers malformed frames with an error frame", async () => {
    const sessionId = freshSession();
    const alice = await connect(viewerPath(sessionId, "alice", "driver"));
    await alice.waitFor((f) => f["type"] === "welcome");
    alice.ws.send("not json");
    const error = await alice.waitFor((f) => f["type"] === "error");
    expect(error["message"]).toBe("frame is not valid JSON");
  });
});

describe("agent bridge", () => {
  it("forwards driver prompts to the agent socket and agent events to viewers", async () => {
    const sessionId = freshSession();
    const agent = await connect(`/session/${sessionId}/agent`);
    const alice = await connect(viewerPath(sessionId, "alice", "driver"));
    await alice.waitFor((f) => f["type"] === "welcome");

    alice.ws.send(JSON.stringify({ type: "handoff", toParticipantId: "alice" }));
    alice.ws.send(
      JSON.stringify({ type: "steer", id: "m1", text: "run tests", delivery: "queue" }),
    );
    const prompt = await agent.waitFor((f) => f["type"] === "prompt");
    expect(prompt["messages"]).toEqual([
      expect.objectContaining({ authorId: "alice", text: "run tests" }),
    ]);

    agent.ws.send(
      JSON.stringify({
        type: "agent_event",
        body: { type: "agent_message_chunk", payload: { text: "Running..." } },
      }),
    );
    await alice.waitFor(isEventOf("agent_message_chunk"));
    agent.ws.send(JSON.stringify({ type: "turn_ended", stopReason: "end_turn" }));
    await alice.waitFor(isEventOf("turn_ended"));
  });

  it("redacts secrets in broadcast events before they reach viewers", async () => {
    const sessionId = freshSession();
    const agent = await connect(`/session/${sessionId}/agent`);
    const observer = await connect(viewerPath(sessionId, "obs", "observer"));
    await observer.waitFor((f) => f["type"] === "welcome");

    // Agent surfaces an AWS key (assembled so no literal token lands in source).
    const awsKey = "AKIA" + "IOSFODNN7EXAMPLE";
    agent.ws.send(
      JSON.stringify({
        type: "agent_event",
        body: { type: "agent_message_chunk", payload: { text: `found ${awsKey} in .env` } },
      }),
    );
    const evt = await observer.waitFor(isEventOf("agent_message_chunk"));
    const text = ((evt["event"] as SignedEvent).body.payload as { text: string }).text;
    expect(text).toBe("found [redacted:aws-access-key] in .env");
    expect(text).not.toContain(awsKey);
  });

  it("redacts a declared session credential from broadcasts and from replay", async () => {
    const sessionId = freshSession();
    // A credential no built-in pattern would ever match: without the
    // declaration it sails straight through to the Observer.
    const credential = "s3ssion-scoped-value";
    const agent = await connect(`/session/${sessionId}/agent`);
    const observer = await connect(viewerPath(sessionId, "obs", "observer"));
    await observer.waitFor((f) => f["type"] === "welcome");

    agent.ws.send(JSON.stringify({ type: "register_secrets", values: [credential] }));
    agent.ws.send(
      JSON.stringify({
        type: "agent_event",
        body: { type: "agent_message_chunk", payload: { text: `exporting ${credential} now` } },
      }),
    );

    const evt = await observer.waitFor(isEventOf("agent_message_chunk"));
    const text = ((evt["event"] as SignedEvent).body.payload as { text: string }).text;
    expect(text).toBe("exporting [redacted:secret] now");

    // Replay is an outbound path too — the same secret must not leak there,
    // and the declaration itself must never have been logged as an event.
    const replay = await SELF.fetch(`${BASE}/session/${sessionId}/events?from=0`);
    expect(await replay.text()).not.toContain(credential);
  });

  it("buffers prompts while the agent bridge is down and flushes on connect", async () => {
    const sessionId = freshSession();
    const alice = await connect(viewerPath(sessionId, "alice", "driver"));
    await alice.waitFor((f) => f["type"] === "welcome");
    alice.ws.send(JSON.stringify({ type: "handoff", toParticipantId: "alice" }));
    alice.ws.send(
      JSON.stringify({ type: "steer", id: "m1", text: "queued while offline", delivery: "queue" }),
    );
    await alice.waitFor(isEventOf("human_message"));

    const agent = await connect(`/session/${sessionId}/agent`);
    const prompt = await agent.waitFor((f) => f["type"] === "prompt");
    expect(prompt["messages"]).toEqual([expect.objectContaining({ text: "queued while offline" })]);
  });

  it("gates a tool permission on the Driver's decision, then answers the agent", async () => {
    const sessionId = freshSession();
    const agent = await connect(`/session/${sessionId}/agent`);
    const alice = await connect(viewerPath(sessionId, "alice", "driver"));
    await alice.waitFor((f) => f["type"] === "welcome");
    alice.ws.send(JSON.stringify({ type: "handoff", toParticipantId: "alice" }));
    await alice.waitFor(isEventOf("control_handoff"));

    agent.ws.send(
      JSON.stringify({
        type: "permission_request",
        requestId: "perm-1",
        toolCallId: "tc-1",
        title: "Run rm -rf build",
        options: [{ optionId: "allow", name: "Allow once", kind: "allow_once" }],
      }),
    );
    const reqEvent = await alice.waitFor(isEventOf("permission_request"));
    expect((reqEvent["event"] as SignedEvent).body).toMatchObject({
      type: "permission_request",
      payload: { requestId: "perm-1", title: "Run rm -rf build" },
    });

    alice.ws.send(
      JSON.stringify({
        type: "decide",
        requestId: "perm-1",
        outcome: { kind: "selected", optionId: "allow" },
      }),
    );
    const decision = await agent.waitFor((f) => f["type"] === "permission_decision");
    expect(decision).toMatchObject({
      requestId: "perm-1",
      outcome: { kind: "selected", optionId: "allow" },
    });
  });

  it("blocks a non-Driver from approving a tool", async () => {
    const sessionId = freshSession();
    const agent = await connect(`/session/${sessionId}/agent`);
    const alice = await connect(viewerPath(sessionId, "alice", "driver"));
    await alice.waitFor((f) => f["type"] === "welcome");
    const bob = await connect(viewerPath(sessionId, "bob", "navigator"));
    await bob.waitFor((f) => f["type"] === "welcome");
    alice.ws.send(JSON.stringify({ type: "handoff", toParticipantId: "alice" }));
    await bob.waitFor(isEventOf("control_handoff"));

    agent.ws.send(
      JSON.stringify({
        type: "permission_request",
        requestId: "perm-2",
        toolCallId: "tc-2",
        title: "delete prod bucket",
        options: [{ optionId: "allow", name: "Allow" }],
      }),
    );
    await bob.waitFor(isEventOf("permission_request"));

    bob.ws.send(
      JSON.stringify({ type: "decide", requestId: "perm-2", outcome: { kind: "cancelled" } }),
    );
    const rejection = await bob.waitFor((f) => f["type"] === "steer_rejected");
    expect(rejection).toMatchObject({
      messageId: "perm-2",
      reason: "only the driver may approve tools",
    });
  });
});

describe("replay", () => {
  it("serves a verifiable tail from any offset", async () => {
    const sessionId = freshSession();
    const alice = await connect(viewerPath(sessionId, "alice", "driver"));
    await alice.waitFor((f) => f["type"] === "welcome");
    alice.ws.send(JSON.stringify({ type: "handoff", toParticipantId: "alice" }));
    alice.ws.send(JSON.stringify({ type: "steer", id: "m1", text: "go", delivery: "queue" }));
    await alice.waitFor(isEventOf("human_message"));

    const full = await SELF.fetch(`${BASE}/session/${sessionId}/events?from=0`);
    // The viewer fetches replay cross-origin; without this header late-joiner
    // replay silently fails in the browser (exit-benchmark regression).
    expect(full.headers.get("Access-Control-Allow-Origin")).toBe("*");
    const { events } = (await full.json()) as { events: SignedEvent[] };
    expect(events.length).toBeGreaterThanOrEqual(3);
    expect(await verifyChain(events)).toEqual({ valid: true, length: events.length });

    const verifyResponse = await SELF.fetch(`${BASE}/session/${sessionId}/verify`);
    expect(verifyResponse.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(await verifyResponse.json()).toEqual({ valid: true, length: events.length });

    const tailResponse = await SELF.fetch(`${BASE}/session/${sessionId}/events?from=2`);
    const { events: tail } = (await tailResponse.json()) as { events: SignedEvent[] };
    expect(tail).toEqual(events.filter((e) => e.seq >= 2));
    expect(await verifyChain(tail, events[1]!.hash)).toEqual({ valid: true, length: tail.length });
  });
  it("compacts a long session: from=checkpoint serves the checkpoint plus the tail", async () => {
    const sessionId = freshSession();
    const alice = await connect(viewerPath(sessionId, "alice", "driver"));
    await alice.waitFor((f) => f["type"] === "welcome");

    // Before the first checkpoint there is nothing to compact to, so a late
    // joiner still gets the head of the log.
    const early = await SELF.fetch(`${BASE}/session/${sessionId}/events?from=checkpoint`);
    const { events: earlyEvents } = (await early.json()) as { events: SignedEvent[] };
    expect(earlyEvents[0]?.seq).toBe(0);

    const agent = await connect(`/session/${sessionId}/agent`);
    for (let i = 0; i <= CHECKPOINT_EVERY; i++) {
      agent.ws.send(
        JSON.stringify({
          type: "agent_event",
          body: { type: "agent_message_chunk", payload: { text: `chunk ${i}` } },
        }),
      );
    }
    await alice.waitFor(isEventOf("checkpoint"));

    const compactedResponse = await SELF.fetch(
      `${BASE}/session/${sessionId}/events?from=checkpoint`,
    );
    const { events: compacted } = (await compactedResponse.json()) as { events: SignedEvent[] };
    const fullResponse = await SELF.fetch(`${BASE}/session/${sessionId}/events?from=0`);
    const { events: full } = (await fullResponse.json()) as { events: SignedEvent[] };

    expect(compacted[0]?.body.type).toBe("checkpoint");
    expect(compacted.length).toBeLessThan(full.length);
    expect(compacted).toEqual(full.filter((e) => e.seq >= compacted[0]!.seq));
    // A compacted replay is still a chain — it just starts later.
    const priorHash = full.find((e) => e.seq === compacted[0]!.seq - 1)!.hash;
    expect(await verifyChain(compacted, priorHash)).toEqual({
      valid: true,
      length: compacted.length,
    });
    // And it carries the state the elided events would have rebuilt.
    const body = compacted[0]!.body;
    if (body.type !== "checkpoint") throw new Error("expected a checkpoint");
    expect(body.payload.roster).toEqual([
      { participantId: "alice", displayName: "alice", role: "driver" },
    ]);
  });
});
