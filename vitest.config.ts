import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [".pi/extensions/**/*.test.ts", "bin/**/*.test.mjs"],
    exclude: [
      ".pi/extensions/pi-mcp-adapter/**/*.test.ts",
      ".pi/extensions/pi-mcp-adapter/__tests__/**",
    ],
  },
});
