import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

/* Standalone from vite.config.ts: that one goes through the Lovable wrapper, which
   pulls in nitro and the TanStack Start plugin — none of which a unit test needs, and
   which make the run far slower to start. */
export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
