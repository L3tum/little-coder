import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PATCHES, applyTextPatch } from "./patch-extension-notifications.mjs";

const root = process.cwd();

describe("postinstall node_modules patches", () => {
  it("all patch targets are present and applied", () => {
    for (const patch of PATCHES) {
      const file = join(root, ...patch.path);
      const current = readFileSync(file, "utf8");
      expect(current, `${patch.name} target should contain patched text`).toContain(patch.newText);
    }
  });

  it("all patches still match their upstream text", () => {
    for (const patch of PATCHES) {
      expect(applyTextPatch(patch.oldText, patch), patch.name).toBe(patch.newText);
    }
  });
});
