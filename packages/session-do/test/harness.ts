/**
 * Shared workerd test harness: a collecting WebSocket client and the URL
 * helpers the session tests drive the Durable Object with.
 */

import { SELF } from "cloudflare:test";
import { expect } from "vitest";

export const BASE = "https://session.test";

export interface CollectedSocket {
  ws: WebSocket;
  frames: Array<Record<string, unknown>>;
  waitFor(predicate: (frame: Record<string, unknown>) => boolean): Promise<Record<string, unknown>>;
}

export async function connect(path: string): Promise<CollectedSocket> {
  const response = await SELF.fetch(`${BASE}${path}`, {
    headers: { Upgrade: "websocket" },
  });
  expect(response.status).toBe(101);
  const ws = response.webSocket;
  if (!ws) throw new Error("no websocket on response");
  const frames: Array<Record<string, unknown>> = [];
  const waiters: Array<{
    predicate: (frame: Record<string, unknown>) => boolean;
    resolve: (frame: Record<string, unknown>) => void;
  }> = [];
  ws.accept();
  ws.addEventListener("message", (event) => {
    const frame = JSON.parse(String(event.data)) as Record<string, unknown>;
    frames.push(frame);
    const index = waiters.findIndex((w) => w.predicate(frame));
    if (index >= 0) {
      const [waiter] = waiters.splice(index, 1);
      waiter!.resolve(frame);
    }
  });
  return {
    ws,
    frames,
    waitFor(predicate) {
      const existing = frames.find(predicate);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve, reject) => {
        waiters.push({ predicate, resolve });
        setTimeout(() => reject(new Error("timed out waiting for frame")), 2000);
      });
    },
  };
}

export function viewerPath(sessionId: string, id: string, role: string): string {
  return `/session/${sessionId}/ws?participantId=${id}&displayName=${id}&role=${role}`;
}

export function isEventOf(type: string) {
  return (frame: Record<string, unknown>): boolean =>
    frame["type"] === "event" && (frame["event"] as { body: { type: string } }).body.type === type;
}

let sessionCounter = 0;
export function freshSession(): string {
  return `s${Date.now()}-${sessionCounter++}`;
}
