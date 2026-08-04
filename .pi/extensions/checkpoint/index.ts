import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

interface ToolCallEvent {
  toolName?: string;
  input?: Record<string, unknown>;
  args?: Record<string, unknown>;
}

// Port of checkpoint/hooks.py. Snapshots a file's contents before a Write
// or Edit tool modifies it. First-write-wins per session (don't re-backup
// a file already tracked this session). Backups land in
// ~/.little-coder/checkpoints/<session>/.

const tracked = new Map<string, Set<string>>(); // sessionId -> absolute paths

function checkpointDir(sessionId: string): string {
  const dir = join(homedir(), ".little-coder", "checkpoints", sessionId);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

function safeName(filePath: string): string {
  return filePath.replace(/[^A-Za-z0-9._-]/g, "_").slice(-200);
}

function backupIfNeeded(sessionId: string, filePath: string): void {
  if (!sessionId || !filePath) return;
  let session = tracked.get(sessionId);
  if (!session) {
    session = new Set();
    tracked.set(sessionId, session);
  }
  if (session.has(filePath)) return;
  session.add(filePath);
  try {
    if (existsSync(filePath)) {
      const content = readFileSync(filePath);
      writeFileSync(
        join(checkpointDir(sessionId), safeName(filePath)),
        content,
      );
    } else {
      // Sentinel: file didn't exist before modification
      writeFileSync(
        join(checkpointDir(sessionId), safeName(filePath) + ".absent"),
        "",
      );
    }
  } catch {
    // Silent — checkpointing is best-effort
  }
}

export default function (pi: ExtensionAPI) {
  let currentSessionId = "default";

  pi.on("session_start", async (_event, ctx) => {
    currentSessionId =
      ctx.sessionManager.getSessionFile()?.split("/").pop() ?? "default";
  });

  pi.on("tool_call", async (event) => {
    const name = (event as ToolCallEvent).toolName;
    if (
      name !== "write" &&
      name !== "Write" &&
      name !== "edit" &&
      name !== "Edit"
    ) {
      return;
    }
    const input =
      (event as ToolCallEvent).input ?? (event as ToolCallEvent).args;
    const filePath = input?.file_path;
    if (typeof filePath === "string") {
      backupIfNeeded(currentSessionId, filePath);
    }
  });
}
