import { defineConfig } from "vitest/config";

// Each fake Neon branch is a separate in-memory Postgres, which takes a few seconds to start.
export default defineConfig({ test: { testTimeout: 30_000, hookTimeout: 30_000 } });
