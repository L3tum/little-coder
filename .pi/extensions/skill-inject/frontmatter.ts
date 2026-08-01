// Minimal YAML frontmatter parser — enough for the fields little-coder uses.
// Mirrors skill/loader.py::_parse_skill_file's behavior, no external deps.

export interface Frontmatter {
  [key: string]: string | string[] | number | boolean | undefined;
}

export interface ParsedSkill {
  frontmatter: Frontmatter;
  body: string;
}

export function parseSkillFile(text: string): ParsedSkill | null {
  const parts = text.split("---");
  if (parts.length < 3) return null;
  const fmText = parts[1].trim();
  const body = parts.slice(2).join("---").trim();
  const fm: Frontmatter = {};
  const lines = fmText.split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const m = line.match(/^(\w[\w_-]*)\s*:\s*(.*)$/);
    if (!m) {
      i++;
      continue;
    }
    const key = m[1].trim();
    let val = m[2].trim();
    let multiLine = false;
    // Handle multi-line flow arrays: value starts with "[" but doesn't end with "]"
    // OR value is empty and next lines contain a flow array
    if (val === "" || (val.startsWith("[") && !val.endsWith("]"))) {
      let collected = val;
      i++;
      while (i < lines.length && !collected.endsWith("]")) {
        const nextLine = lines[i].trim();
        // Stop if we hit another key: value line
        if (
          nextLine &&
          !nextLine.startsWith("[") &&
          nextLine.includes(":") &&
          !nextLine.startsWith("-")
        ) {
          break;
        }
        collected += " " + nextLine;
        i++;
      }
      collected = collected.trim();
      if (collected.startsWith("[") && collected.endsWith("]")) {
        val = collected;
        multiLine = true;
      } else if (val === "") {
        // Couldn't find array, val stays empty
      } else {
        val = collected;
      }
    }
    if (val.startsWith("[") && val.endsWith("]")) {
      fm[key] = val
        .slice(1, -1)
        .split(",")
        .map((s) => s.trim().replace(/^["']|["']$/g, ""))
        .filter((s) => s.length > 0);
    } else if (/^-?\d+$/.test(val)) {
      fm[key] = parseInt(val, 10);
    } else if (val === "true" || val === "false") {
      fm[key] = val === "true";
    } else {
      fm[key] = val;
    }
    // Only increment if multi-line didn't already advance i past the next key
    if (!multiLine) {
      i++;
    }
  }
  return { frontmatter: fm, body };
}
