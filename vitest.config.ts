import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The DB tests (RUN_DB_TESTS=1) create and drop partitions of the shared `txs` table; run files one at a time
    // so that DDL from two files never contends for the lock on the parent table.
    fileParallelism: false,
  },
});
