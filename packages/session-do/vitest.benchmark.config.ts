import { defineConfig } from "vitest/config";

const soakMs = Number(process.env["SIDE_STREET_SOAK_MS"] ?? 60_000);

// The exit benchmark drives a running Worker over the network, so it uses the
// plain Node runner rather than the workers pool `vitest.config.ts` uses for
// the in-process suites. Kept out of `pnpm test` on purpose: it needs a
// deployment, and the real run takes 24 hours.
export default defineConfig({
  test: {
    include: ["benchmark/**/*.test.ts"],
    // The soak phase runs as long as it is asked to; the suite must not
    // impose a shorter deadline than the thing it is measuring.
    testTimeout: soakMs + 3_600_000,
    hookTimeout: 60_000,
    // One live session, phases in order.
    fileParallelism: false,
    sequence: { concurrent: false },
  },
});
