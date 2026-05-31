import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { parseSkillFile } from "../skill-inject/frontmatter.ts";

export interface SkillCatalogEntry {
  name: string;
  type: string;
  origin: "repo" | "user";
  sourceDir: string;
  path: string;
  tokenCost: number;
  targetTool?: string;
  description?: string;
  keywords: string[];
}

function repoSkillsRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "skills");
}

function userSkillsRoot(): string {
  return process.env.LITTLE_CODER_USER_SKILLS_DIR || join(homedir(), ".pi", "skills");
}

function walkMarkdown(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    try {
      if (statSync(path).isDirectory()) out.push(...walkMarkdown(path));
      else if (name.endsWith(".md")) out.push(path);
    } catch {}
  }
  return out;
}

function firstBodyLine(body: string): string | undefined {
  return body.split("\n").map((line) => line.replace(/^#+\s*/, "").trim()).find(Boolean)?.slice(0, 140);
}

function inferType(sourceDir: string, fmType: unknown): string {
  if (typeof fmType === "string" && fmType) return fmType;
  if (sourceDir === "tools") return "tool";
  if (sourceDir === "knowledge") return "knowledge";
  if (sourceDir === "protocols") return "protocol";
  return sourceDir || "skill";
}

export function listSkillCatalog(): SkillCatalogEntry[] {
  const roots = [
    { root: repoSkillsRoot(), origin: "repo" as const },
    { root: userSkillsRoot(), origin: "user" as const },
  ];
  const entries: SkillCatalogEntry[] = [];
  for (const { root, origin } of roots) {
    for (const path of walkMarkdown(root)) {
      const parsed = parseSkillFile(readFileSync(path, "utf-8"));
      if (!parsed?.body) continue;
      const fm = parsed.frontmatter;
      const rel = relative(root, path).split(/[\\/]/);
      const sourceDir = origin === "user" ? "user" : (rel[0] || basename(dirname(path)));
      const targetTool = typeof fm.target_tool === "string" && fm.target_tool ? fm.target_tool : undefined;
      const name = (typeof fm.name === "string" && fm.name) || (typeof fm.topic === "string" && fm.topic) || targetTool || basename(path, ".md");
      entries.push({
        name,
        type: inferType(sourceDir, fm.type),
        origin,
        sourceDir,
        path,
        tokenCost: typeof fm.token_cost === "number" ? fm.token_cost : 150,
        targetTool,
        description: typeof fm.description === "string" && fm.description ? fm.description : firstBodyLine(parsed.body),
        keywords: Array.isArray(fm.keywords) ? (fm.keywords as string[]).map((k) => k.toLowerCase()) : [],
      });
    }
  }
  return entries.sort((a, b) => a.origin.localeCompare(b.origin) || a.sourceDir.localeCompare(b.sourceDir) || a.name.localeCompare(b.name));
}
