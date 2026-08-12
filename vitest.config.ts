import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// Separate from vite.config.ts rather than merged into it: that file is tuned
// for `tauri dev` (fixed port, HMR host, ignoring src-tauri/) and none of
// that is meaningful to a test run, or worth teaching to ignore under `vitest`.
export default defineConfig({
  plugins: [react()],
  test: {
    // No DOM: everything under test is pure logic (src/lib) or a function
    // that builds plain React-element objects (highlightSql) without ever
    // rendering them. Add `environment: "jsdom"` (and the jsdom dependency)
    // if a future test needs to render into a document.
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
  },
});
