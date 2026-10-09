import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "path";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./vitest.setup.ts"],
    exclude: ["node_modules/**", "e2e/**", "cypress/**", ".next/**"],
    // Forked worker processes (the default "forks" pool) time out on startup
    // in this environment — worker_threads is more portable here.
    pool: "threads",
  },
  resolve: {
    alias: {
      // Must mirror tsconfig.json's "paths" — Next.js resolves these via its
      // own webpack config, which Vitest never sees.
      "@app": path.resolve(process.cwd(), "./app"),
      "@components": path.resolve(process.cwd(), "./components"),
      "@hooks": path.resolve(process.cwd(), "./hooks"),
      "@lib": path.resolve(process.cwd(), "./lib"),
      "@types": path.resolve(process.cwd(), "./types"),
    },
  },
});
