// Internal helper functions extracted from little-coder.mjs for testability.
// The launcher runs top-level code on import (preflight, FS access, await),
// so we isolate these pure helpers into their own module.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

// Package root resolved from the launcher's own position.
// Importers from tests will override this; the real launcher sets it before importing.
let _pkgRoot = null;

/** @param {string} root - Override the package root (used by the launcher) */
export function setPkgRoot(root) {
  _pkgRoot = root;
}

export function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
}

export function resolveExtensionEntry(resourcePath) {
  if (!existsSync(resourcePath)) return null;
  try {
    if (!statSync(resourcePath).isDirectory()) return resourcePath;
    for (const name of ["index.ts", "index.js", "index.mjs", "index.cjs"]) {
      const candidate = join(resourcePath, name);
      if (existsSync(candidate)) return candidate;
    }
    const pkg = readJson(join(resourcePath, "package.json"));
    if (typeof pkg?.main === "string") {
      const mainPath = resolve(resourcePath, pkg.main);
      if (existsSync(mainPath)) return mainPath;
    }
    const codeFiles = readdirSync(resourcePath)
      .filter((name) => /\.(?:[cm]?js|ts)$/.test(name))
      .filter((name) => !name.endsWith(".d.ts"))
      .sort();
    if (codeFiles.length === 1) return join(resourcePath, codeFiles[0]);
  } catch {
    return null;
  }
  return resourcePath;
}

export function addPiResources(args, flag, baseDir, resources) {
  if (!Array.isArray(resources)) return;
  for (const resource of resources) {
    if (typeof resource !== "string" || resource.length === 0) continue;
    const requestedPath = resolve(baseDir, resource);
    const resolvedPath =
      flag === "--extension"
        ? resolveExtensionEntry(requestedPath)
        : requestedPath;
    if (!resolvedPath || !existsSync(resolvedPath)) {
      console.warn(
        `little-coder: skipping missing ${flag.slice(2)} resource ${requestedPath}`,
      );
      continue;
    }
    args.push(flag, resolvedPath);
  }
}

export function bundledPackageArgs(pkgJson, opts = {}) {
  const { subagentMode = false } = opts;
  const args = [];
  const packageNames = Array.isArray(pkgJson?.littleCoder?.packages)
    ? pkgJson.littleCoder.packages
    : [];

  const pkgRoot = _pkgRoot;
  if (!pkgRoot) {
    throw new Error(
      "bundledPackageArgs requires setPkgRoot() to be called first",
    );
  }

  for (const packageName of packageNames) {
    if (typeof packageName !== "string" || packageName.length === 0) continue;
    if (subagentMode && packageName === "pi-ask-user") continue;
    const pkgJsonPath = join(
      pkgRoot,
      "node_modules",
      ...packageName.split("/"),
      "package.json",
    );
    const depPkgJson = readJson(pkgJsonPath);
    const manifest = depPkgJson?.pi;
    if (!manifest || typeof manifest !== "object") continue;
    const depRoot = dirname(pkgJsonPath);
    addPiResources(args, "--extension", depRoot, manifest.extensions);
    addPiResources(args, "--prompt-template", depRoot, manifest.prompts);
    addPiResources(args, "--theme", depRoot, manifest.themes);
  }

  return args;
}
