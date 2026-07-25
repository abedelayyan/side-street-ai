/**
 * Worker entry: routes /session/:id/* to that session's Durable Object.
 * One DO per session id (ADR-0001); everything else is the DO's business.
 */

import { SessionDurableObject, type Env } from "./session-do.js";

export { SessionDurableObject };
export type { Env };

const SESSION_PATH = /^\/session\/([A-Za-z0-9_-]{1,64})\/(events|ws|agent)$/;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const match = SESSION_PATH.exec(url.pathname);
    if (match === null) {
      return Response.json({ error: "not found" }, { status: 404 });
    }
    const sessionId = match[1] as string;
    const stub = env.SESSIONS.get(env.SESSIONS.idFromName(sessionId));
    return stub.fetch(request);
  },
} satisfies ExportedHandler<Env>;
