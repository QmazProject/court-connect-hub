// Plugin order below is load-bearing — see the note above `plugins`.
import { defineConfig, loadEnv } from "vite";
import { devtools } from "@tanstack/devtools-vite";
import tailwindcss from "@tailwindcss/vite";
import tsConfigPaths from "vite-tsconfig-paths";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import { nitro } from "nitro/vite";
import viteReact from "@vitejs/plugin-react";

export default defineConfig(({ mode, command }) => ({
  css: { transformer: "lightningcss" },

  // Inline VITE_* into every environment, client and SSR alike. Vite covers the
  // client natively; this also pins the values into the server bundle.
  define: Object.fromEntries(
    Object.entries(loadEnv(mode, process.cwd(), "VITE_")).map(([key, value]) => [
      `import.meta.env.${key}`,
      JSON.stringify(value),
    ]),
  ),

  resolve: {
    alias: { "@": `${process.cwd()}/src` },
    // Two copies of React (or of the query client) break hooks at runtime.
    dedupe: [
      "react",
      "react-dom",
      "react/jsx-runtime",
      "react/jsx-dev-runtime",
      "@tanstack/react-query",
      "@tanstack/query-core",
    ],
  },
  optimizeDeps: {
    include: [
      "react",
      "react-dom",
      "react-dom/client",
      "react/jsx-runtime",
      "react/jsx-dev-runtime",
    ],
    ignoreOutdatedRequests: true,
  },

  server: {
    host: "::",
    port: 8080,
    // The repo lives on /mnt/c — a Windows drive mounted into WSL2, which does not
    // deliver inotify events. Without polling the watcher never sees an edit, so the
    // dev server keeps serving the module it transformed at startup and the browser
    // shows stale code no matter how many times the page is reloaded.
    watch: {
      usePolling: true,
      interval: 400,
      awaitWriteFinish: { stabilityThreshold: 1000, pollInterval: 100 },
    },
  },

  // Order matters:
  //  1. devtools first — with injectSource it stamps source locations onto JSX
  //     before any other transform rewrites those nodes.
  //  2. tailwindcss + tsConfigPaths before the framework plugin — tsConfigPaths is a
  //     resolveId hook, so `@/…` must resolve before anything loads those modules;
  //     TanStack Start's route scan depends on it.
  //  3. tanstackStart before nitro — Start establishes the server entry and route
  //     manifest that nitro then packages.
  //  4. viteReact LAST — Start must see original JSX to generate the route tree and
  //     extract server functions; hoisting React's transform ahead of it breaks both.
  plugins: [
    ...(mode === "development"
      ? [
          devtools({
            logging: false,
            eventBusConfig: { enabled: false },
            enhancedLogs: { enabled: false },
            consolePiping: { enabled: false },
            removeDevtoolsOnBuild: false,
            injectSource: { enabled: true },
          }),
        ]
      : []),
    tailwindcss(),
    tsConfigPaths({ projects: ["./tsconfig.json"] }),
    tanstackStart({
      // Redirect TanStack Start's bundled server entry to src/server.ts (our SSR
      // error wrapper). nitro/vite builds from this.
      server: { entry: "server" },
      importProtection: {
        behavior: "error",
        client: { files: ["**/server/**"], specifiers: ["server-only"] },
      },
    }),
    ...(command === "build" ? [nitro({ defaultPreset: "cloudflare-module" })] : []),
    viteReact(),
  ],
}));
