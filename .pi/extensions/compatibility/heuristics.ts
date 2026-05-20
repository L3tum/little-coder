export interface CompatRewriteStats {
  renamedKeys: Array<{ from: string; to: string }>;
  arrayWrappedKeys: string[];
}

interface JsonSchemaLike {
  type?: string;
  properties?: Record<string, JsonSchemaLike>;
  items?: JsonSchemaLike;
}

function tokenize(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[^A-Za-z0-9]+/g, " ")
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
}

function canonicalToken(token: string): string {
  if (["text", "string", "str"].includes(token)) return "text";
  if (["filepath", "filename", "pathname", "directory", "dir"].includes(token)) return "path";
  if (token.endsWith("ies") && token.length > 3) return token.slice(0, -3) + "y";
  if (token.endsWith("s") && token.length > 3 && !token.endsWith("ss")) return token.slice(0, -1);
  return token;
}

function canonicalTokens(name: string): string[] {
  return tokenize(name).map(canonicalToken);
}

function normalizedName(name: string): string {
  return canonicalTokens(name).join("");
}

function editDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

function keyScore(source: string, target: string): number {
  if (source === target) return 1;
  const sourceNorm = normalizedName(source);
  const targetNorm = normalizedName(target);
  if (!sourceNorm || !targetNorm) return 0;
  if (sourceNorm === targetNorm) return 0.98;

  const src = canonicalTokens(source);
  const dst = canonicalTokens(target);
  const srcSet = new Set(src);
  const dstSet = new Set(dst);
  let overlap = 0;
  for (const token of dstSet) {
    if (srcSet.has(token)) overlap++;
  }
  let score = overlap / Math.max(srcSet.size, dstSet.size, 1);
  if (src.length > 0 && dst.length > 0 && src[src.length - 1] === dst[dst.length - 1]) {
    score += 0.25;
  }
  if (dst.every((token) => srcSet.has(token)) || src.every((token) => dstSet.has(token))) {
    score += 0.15;
  }
  const dist = editDistance(sourceNorm, targetNorm);
  const maxLen = Math.max(sourceNorm.length, targetNorm.length, 1);
  score = Math.max(score, 1 - dist / maxLen);
  return Math.min(score, 1);
}

function bestKeyMatch(source: string, candidates: string[]): string | undefined {
  let best: { name: string; score: number } | null = null;
  for (const candidate of candidates) {
    const score = keyScore(source, candidate);
    if (!best || score > best.score) best = { name: candidate, score };
  }
  return best && best.score >= 0.72 ? best.name : undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function rewriteValueToSchema(
  value: unknown,
  schema: JsonSchemaLike | undefined,
  stats: CompatRewriteStats = { renamedKeys: [], arrayWrappedKeys: [] },
): { value: unknown; changed: boolean; stats: CompatRewriteStats } {
  if (!schema) return { value, changed: false, stats };

  if (schema.type === "array") {
    if (Array.isArray(value)) {
      let changed = false;
      const next = value.map((item) => {
        const out = rewriteValueToSchema(item, schema.items, stats);
        changed ||= out.changed;
        return out.value;
      });
      return { value: next, changed, stats };
    }
    if (value === undefined) return { value, changed: false, stats };
    const out = rewriteValueToSchema(value, schema.items, stats);
    return { value: [out.value], changed: true, stats };
  }

  if (schema.type === "object" && isObject(value)) {
    const props = schema.properties ?? {};
    const next: Record<string, unknown> = {};
    const unmatched = Object.keys(value);
    let changed = false;

    for (const key of Object.keys(props)) {
      if (key in value) {
        const out = rewriteValueToSchema(value[key], props[key], stats);
        next[key] = out.value;
        changed ||= out.changed;
      }
    }

    for (const key of unmatched) {
      if (key in props) continue;
      const target = bestKeyMatch(key, Object.keys(props).filter((name) => !(name in next)));
      if (!target) {
        next[key] = value[key];
        continue;
      }
      const out = rewriteValueToSchema(value[key], props[target], stats);
      next[target] = out.value;
      stats.renamedKeys.push({ from: key, to: target });
      changed = true;
    }

    for (const [key, propSchema] of Object.entries(props)) {
      if (propSchema?.type === "array" && key in next && !Array.isArray(next[key])) {
        const out = rewriteValueToSchema(next[key], propSchema, stats);
        next[key] = out.value;
        stats.arrayWrappedKeys.push(key);
        changed = true;
      }
    }

    return { value: next, changed, stats };
  }

  return { value, changed: false, stats };
}

export function findCompatibleToolName(toolName: string, knownTools: Iterable<string>): string | undefined {
  const names = [...knownTools];
  if (names.length === 0) return undefined;
  const exactCaseInsensitive = names.find((name) => name.toLowerCase() === toolName.toLowerCase());
  if (exactCaseInsensitive) return exactCaseInsensitive;
  return bestKeyMatch(toolName, names);
}
