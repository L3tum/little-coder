import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { randomBytes } from "node:crypto";

// Port of local/tools/evidence.py. Per-session in-memory store of evidence
// entries. GAIA requires cite-before-answer, and these entries survive
// compaction (Phase 10's evidence-compact extension preserves them).

const SNIPPET_CAP = 1024;

interface EvidenceEntry {
  id: string;
  source: string;
  note: string;
  snippet: string;
}

// Map<sessionId, entries[]>
const stores = new Map<string, EvidenceEntry[]>();

function sessionKey(): string {
  return process.env.LITTLE_CODER_SESSION_ID || "default";
}

function bucket(): EvidenceEntry[] {
  const key = sessionKey();
  let b = stores.get(key);
  if (!b) {
    b = [];
    stores.set(key, b);
  }
  return b;
}

// Exported so tests and the evidence-compact extension can reach in.
export function resetSessionStore(sessionId?: string): void {
  stores.delete(sessionId ?? sessionKey());
}

export function getSessionStore(sessionId?: string): EvidenceEntry[] {
  return stores.get(sessionId ?? sessionKey()) ?? [];
}

export default function (pi: ExtensionAPI) {
  pi.on("session_shutdown", async () => {
    resetSessionStore();
  });

  pi.registerTool({
    name: "EvidenceAdd",
    label: "EvidenceAdd",
    description:
      "Save a short evidence snippet with its source and a one-line note. " +
      "Use for any fact you will cite in your final answer. Snippet is capped at 1KB.",
    parameters: Type.Object({
      source: Type.String({ description: "URL or identifier of origin" }),
      note: Type.String({ description: "One-line summary for later recall" }),
      snippet: Type.String({ description: "The exact citable span (<=1KB)" }),
    }),
    async execute(_id, { source, note, snippet }) {
      const src = (source ?? "").trim();
      const n = (note ?? "").trim();
      let sn = snippet ?? "";
      if (!src) {
        return {
          content: [
            {
              type: "text",
              text: "Error: source is required (URL or identifier)",
            },
          ],
          details: {},
          isError: true,
        };
      }
      if (!n) {
        return {
          content: [
            {
              type: "text",
              text: "Error: note is required (1-line summary of the snippet)",
            },
          ],
          details: {},
          isError: true,
        };
      }
      if (!sn) {
        return {
          content: [{ type: "text", text: "Error: snippet is required" }],
          details: {},
          isError: true,
        };
      }
      if (sn.length > SNIPPET_CAP) {
        sn =
          sn.slice(0, SNIPPET_CAP) +
          `\n[... snippet truncated, kept ${SNIPPET_CAP} chars ...]`;
      }
      const id = "e" + randomBytes(3).toString("hex");
      bucket().push({ id, source: src, note: n, snippet: sn });
      return {
        content: [{ type: "text", text: `stored ${id}: ${n}` }],
        details: {},
      };
    },
  });

  pi.registerTool({
    name: "EvidenceGet",
    label: "EvidenceGet",
    description: "Retrieve a previously-saved evidence entry by its id.",
    parameters: Type.Object({
      id: Type.String({ description: "Evidence id from EvidenceAdd/List" }),
    }),
    async execute(_id, { id }) {
      const eid = (id ?? "").trim();
      if (!eid) {
        return {
          content: [{ type: "text", text: "Error: id is required" }],
          details: {},
          isError: true,
        };
      }
      const e = bucket().find((x) => x.id === eid);
      if (!e) {
        return {
          content: [
            { type: "text", text: `Error: evidence id '${eid}' not found` },
          ],
          details: {},
          isError: true,
        };
      }
      return {
        content: [
          {
            type: "text",
            text: `[${e.id}] source: ${e.source}\nnote: ${e.note}\nsnippet:\n${e.snippet}`,
          },
        ],
        details: {},
      };
    },
  });

  pi.registerTool({
    name: "EvidenceList",
    label: "EvidenceList",
    description:
      "List all evidence entries in this session: id, source, one-line note.",
    parameters: Type.Object({}),
    async execute() {
      const b = bucket();
      if (b.length === 0) {
        return {
          content: [{ type: "text", text: "(no evidence stored yet)" }],
          details: {},
        };
      }
      const lines = b.map((e) => `${e.id}\t${e.source}\t${e.note}`);
      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: {},
      };
    },
  });
}
