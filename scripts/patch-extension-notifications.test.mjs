import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PATCHES, applyTextPatch, isPatchApplied } from "./patch-extension-notifications.mjs";

const root = process.cwd();

describe("postinstall node_modules patches", () => {
  it("does not patch vendored pi-insights through node_modules", () => {
    expect(PATCHES.some((patch) => patch.name.includes("pi-insights") || patch.path.includes("@observal"))).toBe(false);
  });

  it("all patch targets either match upstream text or are already applied", () => {
    for (const patch of PATCHES) {
      const file = join(root, ...patch.path);
      const current = readFileSync(file, "utf8");
      const canApply = current.includes(patch.oldText);
      const alreadyApplied = isPatchApplied(current, patch);
      expect(
        canApply || alreadyApplied,
        `${patch.name} target should contain oldText or patched text`,
      ).toBe(true);
      expect(applyTextPatch(current, patch), patch.name).toContain(patch.newText);
    }
  });

  it("all patches still transform their upstream text", () => {
    for (const patch of PATCHES) {
      expect(applyTextPatch(patch.oldText, patch), patch.name).toBe(patch.newText);
    }
  });
});
