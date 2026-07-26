import { describe, expect, it } from "vitest";
import { SteeringController, type Participant, type SteeringEffect } from "../src/steering.js";

const alice: Participant = { id: "alice", role: "driver" };
const bob: Participant = { id: "bob", role: "navigator" };
const carol: Participant = { id: "carol", role: "observer" };

let msgSeq = 0;
function msg(text: string, delivery: "queue" | "interrupt" = "queue") {
  return { id: `m${msgSeq++}`, text, delivery };
}

function controllerWithDriver(id = "alice"): SteeringController {
  const c = new SteeringController();
  expect(c.handoff({ id, role: "driver" }, id)).toEqual({ ok: true });
  return c;
}

function deliveredTexts(effects: SteeringEffect[]): string[] {
  return effects.flatMap((e) => (e.kind === "deliver" ? e.messages.map((m) => m.text) : []));
}

describe("role authority", () => {
  it("rejects observer messages outright", () => {
    const c = controllerWithDriver();
    const result = c.submit(carol, msg("try restarting"), 1);
    expect(result).toEqual({ accepted: false, reason: "observers are read-only" });
  });

  it("rejects interrupt from a navigator", () => {
    const c = controllerWithDriver();
    c.onTurnStarted();
    const result = c.submit(bob, msg("stop!", "interrupt"), 1);
    expect(result).toEqual({ accepted: false, reason: "only the driver may interrupt" });
  });

  it("rejects steering from a driver-role participant who doesn't hold the wheel", () => {
    const c = controllerWithDriver("alice");
    const impostor: Participant = { id: "dave", role: "driver" };
    const result = c.submit(impostor, msg("do it my way"), 1);
    expect(result).toMatchObject({ accepted: false });
  });
});

describe("driver steering", () => {
  it("starts a turn immediately when the driver messages an idle agent", () => {
    const c = controllerWithDriver();
    const result = c.submit(alice, msg("fix the flaky test"), 1);
    expect(result.accepted).toBe(true);
    if (result.accepted) {
      expect(deliveredTexts(result.effects)).toEqual(["fix the flaky test"]);
    }
  });

  it("queues driver messages while a turn runs, draining at the boundary", () => {
    const c = controllerWithDriver();
    c.submit(alice, msg("first task"), 1);
    c.onTurnStarted();
    const mid = c.submit(alice, msg("also check the logs"), 2);
    expect(mid).toEqual({ accepted: true, effects: [] });
    expect(deliveredTexts(c.onToolCallBoundary())).toEqual(["also check the logs"]);
  });

  it("keeps attribution and role-at-submission on drained messages", () => {
    const c = controllerWithDriver();
    c.onTurnStarted();
    c.submit(alice, msg("driver says"), 1);
    c.submit(bob, msg("navigator suggests"), 2);
    const [effect] = c.onToolCallBoundary();
    expect(effect).toMatchObject({
      kind: "deliver",
      messages: [
        { authorId: "alice", role: "driver", text: "driver says" },
        { authorId: "bob", role: "navigator", text: "navigator suggests" },
      ],
    });
  });
});

describe("navigator suggestions", () => {
  it("never initiate a turn on their own", () => {
    const c = controllerWithDriver();
    const result = c.submit(bob, msg("maybe it's the cache"), 1);
    expect(result).toEqual({ accepted: true, effects: [] });
    expect(c.onTurnEnded()).toEqual([]);
    expect(c.state.queue).toHaveLength(1);
  });

  it("ride along when the driver starts a turn, ordered behind driver messages", () => {
    const c = controllerWithDriver();
    c.submit(bob, msg("suggestion first in time"), 1);
    const result = c.submit(alice, msg("driver instruction"), 2);
    expect(result.accepted).toBe(true);
    if (result.accepted) {
      expect(deliveredTexts(result.effects)).toEqual([
        "driver instruction",
        "suggestion first in time",
      ]);
    }
  });
});

describe("hard-interrupt", () => {
  it("cancels a running turn and re-prompts with the queue when the turn ends", () => {
    const c = controllerWithDriver();
    c.submit(alice, msg("long task"), 1);
    c.onTurnStarted();
    const result = c.submit(alice, msg("stop, wrong branch", "interrupt"), 2);
    expect(result.accepted).toBe(true);
    if (result.accepted) {
      expect(result.effects).toEqual([{ kind: "cancel_turn" }]);
    }
    expect(c.state.turnPhase).toBe("cancelling");
    // Agent acknowledges the cancel; the interrupt message becomes the next prompt.
    expect(deliveredTexts(c.onTurnEnded())).toEqual(["stop, wrong branch"]);
    expect(c.state.turnPhase).toBe("idle");
  });

  it("does not send a second cancel while one is in flight", () => {
    const c = controllerWithDriver();
    c.onTurnStarted();
    c.submit(alice, msg("stop", "interrupt"), 1);
    const second = c.submit(alice, msg("really stop", "interrupt"), 2);
    expect(second).toEqual({ accepted: true, effects: [] });
    expect(deliveredTexts(c.onTurnEnded())).toEqual(["stop", "really stop"]);
  });

  it("delivers immediately when the driver interrupts an idle agent", () => {
    const c = controllerWithDriver();
    const result = c.submit(alice, msg("urgent", "interrupt"), 1);
    expect(result.accepted).toBe(true);
    if (result.accepted) {
      expect(deliveredTexts(result.effects)).toEqual(["urgent"]);
    }
  });
});

describe("boundaries and turn end", () => {
  it("returns nothing at a boundary with an empty queue", () => {
    const c = controllerWithDriver();
    c.onTurnStarted();
    expect(c.onToolCallBoundary()).toEqual([]);
  });

  it("returns nothing at a boundary when idle even with suggestions queued", () => {
    const c = controllerWithDriver();
    c.submit(bob, msg("idea"), 1);
    expect(c.onToolCallBoundary()).toEqual([]);
  });

  it("drains driver + suggestions as the next prompt after a natural turn end", () => {
    const c = controllerWithDriver();
    c.onTurnStarted();
    c.submit(bob, msg("check DNS"), 1);
    c.submit(alice, msg("next: write the postmortem"), 2);
    // No boundary arrives before the turn ends naturally.
    expect(deliveredTexts(c.onTurnEnded())).toEqual(["next: write the postmortem", "check DNS"]);
  });
});

describe("take the wheel", () => {
  it("lets only the current driver hand off", () => {
    const c = controllerWithDriver("alice");
    expect(c.handoff(bob, "bob")).toEqual({
      ok: false,
      reason: "only the current driver may hand off control",
    });
    expect(c.handoff(alice, "bob")).toEqual({ ok: true });
    expect(c.state.driverId).toBe("bob");
  });

  it("lets a navigator claim a driverless wheel but never an observer", () => {
    const c = new SteeringController();
    expect(c.handoff(carol, "carol")).toEqual({
      ok: false,
      reason: "observers cannot claim the wheel",
    });
    expect(c.handoff(bob, "bob")).toEqual({ ok: true });
  });

  it("frees the wheel when the driver leaves, and ignores non-driver departures", () => {
    const c = controllerWithDriver("alice");
    c.releaseWheel("bob");
    expect(c.state.driverId).toBe("alice");
    c.releaseWheel("alice");
    expect(c.state.driverId).toBeNull();
  });
});

describe("authority follows the wheel (exit-benchmark regression)", () => {
  /** The driver leaves; the navigator legitimately claims the freed wheel. */
  function navigatorAtTheWheel(): SteeringController {
    const c = controllerWithDriver("alice");
    c.releaseWheel("alice");
    expect(c.handoff(bob, "bob")).toEqual({ ok: true });
    return c;
  }

  it("lets the wheel-holding navigator start a turn on an idle agent", () => {
    const c = navigatorAtTheWheel();
    const result = c.submit(bob, msg("run the tests"), 1);
    expect(result.accepted).toBe(true);
    if (result.accepted) {
      expect(deliveredTexts(result.effects)).toEqual(["run the tests"]);
    }
  });

  it("delivers the wheel-holder's messages as authoritative, not suggestions", () => {
    const c = navigatorAtTheWheel();
    const result = c.submit(bob, msg("run the tests"), 1);
    expect(result.accepted).toBe(true);
    if (result.accepted) {
      const delivered = result.effects.flatMap((e) => (e.kind === "deliver" ? e.messages : []));
      expect(delivered[0]?.role).toBe("driver");
    }
  });

  it("lets the wheel-holding navigator hard-interrupt a running turn", () => {
    const c = navigatorAtTheWheel();
    c.submit(bob, msg("start"), 1);
    c.onTurnStarted();
    const result = c.submit(bob, msg("stop!", "interrupt"), 2);
    expect(result).toEqual({ accepted: true, effects: [{ kind: "cancel_turn" }] });
  });

  it("drains the wheel-holder's queued message when the turn ends", () => {
    const c = navigatorAtTheWheel();
    c.submit(bob, msg("start"), 1);
    c.onTurnStarted();
    c.submit(bob, msg("next task"), 2);
    expect(deliveredTexts(c.onTurnEnded())).toEqual(["next task"]);
  });

  it("still rejects a driver-role participant who does not hold the wheel", () => {
    const c = navigatorAtTheWheel();
    const result = c.submit(alice, msg("my wheel now?"), 1);
    expect(result).toEqual({
      accepted: false,
      reason: "not the current driver — take the wheel first",
    });
  });
});

describe("state round-trip", () => {
  it("restores queue, phase, and driver from a snapshot", () => {
    const c = controllerWithDriver();
    c.onTurnStarted();
    c.submit(alice, msg("in flight"), 1);
    const restored = new SteeringController(c.state);
    expect(restored.state).toEqual(c.state);
    expect(deliveredTexts(restored.onToolCallBoundary())).toEqual(["in flight"]);
  });
});
