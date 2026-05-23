import { glob as fsGlob } from "node:fs/promises";

// Bounded file globbing. The naive `for await (…glob…) { if (len>=500) break }`
// only caps MATCHES — it does nothing about the WALK. Run from a huge root
// (e.g. a home directory with macOS Library / caches / node_modules), fs.glob
// recursively descends everything, and its internal traversal state grows until
// the Node process OOMs (heap, not the model's context) — long before 500
// matches are found if matches are sparse. fs.glob exposes no signal/abort and
// no depth/scan cap, so we bound it through the one hook it does call for every
// entry: `exclude`. We use it to (a) prune heavy/irrelevant directories so they
// are never descended, and (b) meter total entries scanned — once the budget is
// hit, exclude everything, which winds the walk down.

/** Directories never worth descending for a file search — pruned at the dir
 *  level (returning true from `exclude` on a directory stops descent), which is
 *  what keeps a home-directory glob from exhausting memory. */
export const DEFAULT_HEAVY_DIRS: ReadonlySet<string> = new Set([
  // version control
  ".git", ".hg", ".svn",
  // dependencies / language caches
  "node_modules", ".venv", "venv", "__pycache__", ".tox", ".mypy_cache",
  ".pytest_cache", ".gradle", ".cargo", "vendor", "Pods",
  // build output
  "dist", "build", "out", "target", ".next", ".nuxt", ".output", ".svelte-kit",
  // tool caches
  ".cache", ".npm", ".pnpm-store", ".yarn", ".turbo",
  // macOS / system heavies that blow up a home-dir walk
  "Library", "Applications", ".Trash", "Photos Library.photoslibrary",
]);

export interface GlobOptions {
  base: string;
  maxScan?: number;
  maxMatches?: number;
  heavyDirs?: ReadonlySet<string>;
}

export interface GlobOutcome {
  matches: string[];
  scanned: number;
  /** the walk was cut short at maxScan entries (results may be incomplete) */
  scanTruncated: boolean;
  /** matches were capped at maxMatches */
  matchTruncated: boolean;
}

export const DEFAULT_MAX_SCAN = 200_000;
export const DEFAULT_MAX_MATCHES = 500;

export async function globFiles(pattern: string, opts: GlobOptions): Promise<GlobOutcome> {
  const maxScan = opts.maxScan ?? DEFAULT_MAX_SCAN;
  const maxMatches = opts.maxMatches ?? DEFAULT_MAX_MATCHES;
  const heavy = opts.heavyDirs ?? DEFAULT_HEAVY_DIRS;

  const matches: string[] = [];
  let scanned = 0;
  let scanTruncated = false;
  let matchTruncated = false;

  // Called for every entry the walk visits (files AND directories). Pruning a
  // directory here stops descent into it. Also our scan meter: once the budget
  // is spent, exclude everything so fs.glob stops adding work and ends.
  const exclude = (entry: unknown): boolean => {
    scanned++;
    if (scanned > maxScan) {
      scanTruncated = true;
      return true;
    }
    const name = typeof entry === "string" ? entry : String((entry as { name?: string })?.name ?? entry);
    return name.split(/[\\/]/).some((seg) => heavy.has(seg));
  };

  // `exclude` as a predicate isn't in every @types/node version's fs.glob
  // signature, but it's supported at runtime (Node 22+); cast to pass it through.
  for await (const m of fsGlob(pattern, { cwd: opts.base, exclude } as Parameters<typeof fsGlob>[1])) {
    matches.push(`${opts.base}/${m}`);
    if (matches.length >= maxMatches) {
      matchTruncated = true;
      break;
    }
  }

  matches.sort();
  return { matches, scanned, scanTruncated, matchTruncated };
}

/** Render a globFiles outcome as the tool's text output, with a one-line note
 *  when results were cut short so the model knows to narrow its search. */
export function renderGlobOutcome(o: GlobOutcome, maxScan = DEFAULT_MAX_SCAN, maxMatches = DEFAULT_MAX_MATCHES): string {
  if (o.matches.length === 0) {
    return o.scanTruncated
      ? `No files matched (search stopped after scanning ${maxScan} entries — narrow the base path; build/dependency/cache dirs are skipped automatically).`
      : "No files matched";
  }
  let text = o.matches.join("\n");
  if (o.matchTruncated) {
    text += `\n… (stopped at ${maxMatches} matches — narrow the pattern for the rest)`;
  } else if (o.scanTruncated) {
    text += `\n… (search stopped after scanning ${maxScan} entries — results may be incomplete; narrow the base path)`;
  }
  return text;
}
