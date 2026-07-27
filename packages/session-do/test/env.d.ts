import type { Env } from "../src/session-do.js";

declare module "cloudflare:test" {
  // Types the `env` the pool exposes to tests as the Worker's own bindings.
  type ProvidedEnv = Env;
}
