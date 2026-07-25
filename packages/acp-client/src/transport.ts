/**
 * Message transport abstraction. ACP runs over JSON-RPC 2.0; the wire can be
 * stdio to a local agent process, a WebSocket into the session sandbox, or an
 * in-memory pair in tests. Messages are already-parsed JSON values — framing
 * (newline-delimited stdio, WebSocket frames) is the transport's concern.
 */

export interface Transport {
  send(message: unknown): void;
  onMessage(handler: (message: unknown) => void): void;
  close(): void;
}

interface LoopbackEndpoint extends Transport {
  peer: LoopbackEndpoint | undefined;
  deliver(message: unknown): void;
}

function makeEndpoint(): LoopbackEndpoint {
  let handler: ((message: unknown) => void) | undefined;
  let closed = false;
  const endpoint: LoopbackEndpoint = {
    peer: undefined,
    send(message: unknown): void {
      if (closed) {
        throw new Error("transport is closed");
      }
      // Async delivery mirrors real transports and avoids reentrancy.
      queueMicrotask(() => endpoint.peer?.deliver(message));
    },
    onMessage(h: (message: unknown) => void): void {
      handler = h;
    },
    deliver(message: unknown): void {
      handler?.(message);
    },
    close(): void {
      closed = true;
    },
  };
  return endpoint;
}

/** Two connected in-memory transports: what one sends, the other receives. */
export function createTransportPair(): [Transport, Transport] {
  const a = makeEndpoint();
  const b = makeEndpoint();
  a.peer = b;
  b.peer = a;
  return [a, b];
}
