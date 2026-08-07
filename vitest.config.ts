import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Never collect from dist/. `npm run build` emits JS next to the .ts
    // sources' compiled output; if tests ever land there, vitest would run
    // each one twice and the reported count would silently double.
    exclude: ["**/node_modules/**", "dist/**"],
  },
});
