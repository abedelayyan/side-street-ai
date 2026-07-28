import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    // Only the in-process suites. `benchmark/` drives a running Worker over
    // the network and has its own config (vitest.benchmark.config.ts).
    include: ["test/**/*.test.ts"],
    poolOptions: {
      workers: {
        // Isolated storage can't roll back while WebSockets are open, and
        // these tests hold sockets on purpose; each test isolates itself
        // with a unique session id instead.
        isolatedStorage: false,
        singleWorker: true,
        wrangler: { configPath: "./wrangler.jsonc" },
      },
    },
  },
});
