import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/* The live-environment harness. Deliberately NOT part of `npm test`: it talks
   to the real Supabase project and the real PayMongo TEST API, creates
   throwaway users and payouts, and needs .env. Run it on purpose:

     npx vitest run --config scripts/vitest.integration.config.ts
*/
/* The tsconfig `include` does not cover scripts/, so vite-tsconfig-paths would
   not map `@/` for this file; the alias is spelled out instead. */
const src = fileURLToPath(new URL("../src", import.meta.url));

export default defineConfig({
  resolve: { alias: { "@": src } },
  test: {
    environment: "node",
    include: ["scripts/**/*.integration.test.ts"],
    testTimeout: 240_000,
    hookTimeout: 120_000,
    fileParallelism: false,
    sequence: { concurrent: false },
  },
});
