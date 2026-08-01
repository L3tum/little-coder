import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      ".pi/extensions/**/*.test.ts",
      ".pi/extensions/**/*.test.mjs",
      "bin/**/*.test.mjs",
      "scripts/**/*.test.mjs",
    ],
  },
});
