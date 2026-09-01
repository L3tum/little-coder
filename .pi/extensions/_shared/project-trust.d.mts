// Type declarations for project-trust.mjs (shared pi-faithful, fail-closed
// project-trust resolution). Sibling `.d.mts` next to the `.mjs`: under the
// repo's `moduleResolution: "bundler"`, a `./project-trust.mjs` import from
// TS resolves to this declaration (TS maps `.mjs` → `.d.mts`). Same caveat as
// settings-write.d.mts: no `.d.ts` fallback for a `.mjs` source.
//
// PI-VERSION PIN: the on-disk trust model (trust.json boolean-or-null map +
// defaultProjectTrust) is pi ~0.80.x — see the module header in project-trust.mjs.

/**
 * Canonical key for "the current repo": the real, absolute launch
 * directory (realpath, matching how pi's trust.json canonicalizes cwd
 * paths; falls back to resolve() if realpath fails).
 */
export function canonicalRepoKey(cwd: string): string;

/**
 * Read the nearest stored trust decision for `cwd` from
 * `<agentDir>/trust.json` (pi's trust store: a flat map of canonical
 * directory path -> true | false | null). Nearest strictly-true/false
 * entry wins; `null`/absent entries keep the ancestor walk going; any
 * other value is a corrupt store (null). Never throws.
 */
export function readTrustDecision(
  agentDir: string,
  cwd: string,
): boolean | null;

/**
 * Drop the module-level trust-map memo (test isolation). Consistent with the
 * codebase's `_ForTests` seam pattern.
 */
export function _clearTrustCacheForTests(): void;

/**
 * Trust matrix for honoring project-scope (untrusted repo) little-coder
 * settings — stored trust.json decision first (pi-exact precedence), then
 * defaultProjectTrust ("always" → trusted; everything else fail-closed),
 * any read/parse failure fails closed.
 */
export function isProjectTrustedFailClosed(
  cwd: string,
  defaultProjectTrust: string | null | undefined,
): boolean;
