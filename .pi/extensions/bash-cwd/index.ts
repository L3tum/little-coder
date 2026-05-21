import {
  createBashToolDefinition,
  createLocalBashOperations,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateTail,
} from "@earendil-works/pi-coding-agent";
import { randomBytes } from "node:crypto";
import { createWriteStream, type WriteStream } from "node:fs";
import { tmpdir } from "node:os";
import { Type } from "@sinclair/typebox";
import { isAbsolute, join, relative, resolve } from "node:path";

const BASH_MAX_BYTES = 1024;
const BASH_UPDATE_THROTTLE_MS = 100;

function defaultTempFilePath(prefix: string): string {
  const id = randomBytes(8).toString("hex");
  return join(tmpdir(), `${prefix}-${id}.log`);
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf-8");
}

class OutputAccumulator {
  private readonly maxLines: number;
  private readonly maxBytes: number;
  private readonly maxRollingBytes: number;
  private readonly tempFilePrefix: string;
  private readonly decoder = new TextDecoder();
  private rawChunks: Buffer[] = [];
  private tailText = "";
  private tailBytes = 0;
  private tailStartsAtLineBoundary = true;
  private totalRawBytes = 0;
  private totalDecodedBytes = 0;
  private totalLines = 1;
  private currentLineBytes = 0;
  private finished = false;
  private tempFilePath: string | undefined;
  private tempFileStream: WriteStream | undefined;

  constructor(options: { maxLines: number; maxBytes: number; tempFilePrefix: string }) {
    this.maxLines = options.maxLines;
    this.maxBytes = options.maxBytes;
    this.maxRollingBytes = Math.max(this.maxBytes * 2, 1);
    this.tempFilePrefix = options.tempFilePrefix;
  }

  append(data: Buffer): void {
    if (this.finished) throw new Error("Cannot append to a finished output accumulator");
    this.totalRawBytes += data.length;
    this.appendDecodedText(this.decoder.decode(data, { stream: true }));
    if (this.tempFileStream || this.shouldUseTempFile()) {
      this.ensureTempFile();
      this.tempFileStream?.write(data);
    } else if (data.length > 0) {
      this.rawChunks.push(data);
    }
  }

  finish(): void {
    if (this.finished) return;
    this.finished = true;
    this.appendDecodedText(this.decoder.decode());
    if (this.shouldUseTempFile()) this.ensureTempFile();
  }

  snapshot(options: { persistIfTruncated?: boolean } = {}) {
    const tailTruncation = truncateTail(this.getSnapshotText(), {
      maxLines: this.maxLines,
      maxBytes: this.maxBytes,
    });
    const truncated = this.totalLines > this.maxLines || this.totalDecodedBytes > this.maxBytes;
    const truncation = {
      ...tailTruncation,
      truncated,
      truncatedBy: truncated
        ? (tailTruncation.truncatedBy ?? (this.totalDecodedBytes > this.maxBytes ? "bytes" : "lines"))
        : null,
      totalLines: this.totalLines,
      totalBytes: this.totalDecodedBytes,
      maxLines: this.maxLines,
      maxBytes: this.maxBytes,
    };
    if (options.persistIfTruncated && truncation.truncated) this.ensureTempFile();
    return {
      content: truncation.content,
      truncation,
      fullOutputPath: this.tempFilePath,
    };
  }

  async closeTempFile(): Promise<void> {
    if (!this.tempFileStream) return;
    const stream = this.tempFileStream;
    this.tempFileStream = undefined;
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        stream.off("finish", onFinish);
        reject(error);
      };
      const onFinish = () => {
        stream.off("error", onError);
        resolve();
      };
      stream.once("error", onError);
      stream.once("finish", onFinish);
      stream.end();
    });
  }

  getLastLineBytes(): number {
    return this.currentLineBytes;
  }

  private appendDecodedText(text: string): void {
    if (text.length === 0) return;
    const bytes = byteLength(text);
    this.totalDecodedBytes += bytes;
    this.tailText += text;
    this.tailBytes += bytes;
    if (this.tailBytes > this.maxRollingBytes * 2) this.trimTail();
    let newlines = 0;
    let lastNewline = -1;
    for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) {
      newlines++;
      lastNewline = i;
    }
    if (newlines === 0) {
      this.currentLineBytes += bytes;
    } else {
      this.totalLines += newlines;
      this.currentLineBytes = byteLength(text.slice(lastNewline + 1));
    }
  }

  private trimTail(): void {
    const buffer = Buffer.from(this.tailText, "utf-8");
    if (buffer.length <= this.maxRollingBytes) {
      this.tailBytes = buffer.length;
      return;
    }
    let start = buffer.length - this.maxRollingBytes;
    while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) start++;
    this.tailStartsAtLineBoundary = start === 0 ? this.tailStartsAtLineBoundary : buffer[start - 1] === 0x0a;
    this.tailText = buffer.subarray(start).toString("utf-8");
    this.tailBytes = byteLength(this.tailText);
  }

  private getSnapshotText(): string {
    if (this.tailStartsAtLineBoundary) return this.tailText;
    const firstNewline = this.tailText.indexOf("\n");
    return firstNewline === -1 ? this.tailText : this.tailText.slice(firstNewline + 1);
  }

  private shouldUseTempFile(): boolean {
    return this.totalRawBytes > this.maxBytes || this.totalDecodedBytes > this.maxBytes || this.totalLines > this.maxLines;
  }

  private ensureTempFile(): void {
    if (this.tempFilePath) return;
    this.tempFilePath = defaultTempFilePath(this.tempFilePrefix);
    this.tempFileStream = createWriteStream(this.tempFilePath);
    for (const chunk of this.rawChunks) {
      this.tempFileStream.write(chunk);
    }
    this.rawChunks = [];
  }
}

export function isWithinDirectory(root: string, target: string): boolean {
  const rel = relative(resolve(root), resolve(target));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export function resolveWorkspaceCwd(requested: string, cwd: string): { ok: true; path: string } | { ok: false; reason: string } {
  const trimmed = requested.trim();
  if (!trimmed) return { ok: true, path: cwd };
  const resolved = resolve(cwd, trimmed);
  if (!isWithinDirectory(cwd, resolved)) {
    return {
      ok: false,
      reason: `Error: bash.cwd must be the current working directory or one of its subdirectories. Rejected: ${resolved}`,
    };
  }
  return { ok: true, path: resolved };
}

export default function (pi: any) {
  const base = createBashToolDefinition(process.cwd());
  const ops = createLocalBashOperations();

  pi.registerTool({
    ...base,
    name: "bash",
    label: "bash",
    description:
      "Execute a bash command in the current working directory. Returns stdout and stderr. " +
      "Output is truncated to last 2000 lines or 1KB (whichever is hit first). If truncated, full output is saved to a temp file. " +
      "Optionally provide a timeout in seconds. Optionally provide cwd to run from the current working directory or one of its subdirectories.",
    parameters: Type.Object({
      command: Type.String({ description: "Bash command to execute" }),
      timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (optional, no default timeout)" })),
      cwd: Type.Optional(Type.String({ description: "Working directory. Must be current working directory or its subdirectory." })),
    }),
    prepareArguments(args: any) {
      if (!args || typeof args !== "object") return args;
      return {
        command: typeof args.command === "string" ? args.command : "",
        timeout: typeof args.timeout === "number" ? args.timeout : undefined,
        cwd: typeof args.cwd === "string"
          ? args.cwd
          : typeof args.workingDirectory === "string"
            ? args.workingDirectory
            : typeof args.working_directory === "string"
              ? args.working_directory
              : undefined,
      };
    },
    async execute(_toolCallId: string, input: any, signal: AbortSignal, onUpdate: any, ctx: any) {
      const chosenCwd = typeof input?.cwd === "string" ? input.cwd : "";
      const resolved = resolveWorkspaceCwd(chosenCwd, ctx.cwd);
      if (!resolved.ok) {
        return {
          content: [{ type: "text", text: resolved.reason }],
          details: {},
          isError: true,
        };
      }

      const output = new OutputAccumulator({
        maxLines: DEFAULT_MAX_LINES,
        maxBytes: BASH_MAX_BYTES,
        tempFilePrefix: "pi-bash",
      });
      let updateTimer: ReturnType<typeof setTimeout> | undefined;
      let updateDirty = false;
      let lastUpdateAt = 0;

      const emitOutputUpdate = () => {
        if (!onUpdate || !updateDirty) return;
        updateDirty = false;
        lastUpdateAt = Date.now();
        const snapshot = output.snapshot({ persistIfTruncated: true });
        onUpdate({
          content: [{ type: "text", text: snapshot.content || "" }],
          details: {
            truncation: snapshot.truncation.truncated ? snapshot.truncation : undefined,
            fullOutputPath: snapshot.fullOutputPath,
          },
        });
      };

      const clearUpdateTimer = () => {
        if (!updateTimer) return;
        clearTimeout(updateTimer);
        updateTimer = undefined;
      };

      const scheduleOutputUpdate = () => {
        if (!onUpdate) return;
        updateDirty = true;
        const delay = BASH_UPDATE_THROTTLE_MS - (Date.now() - lastUpdateAt);
        if (delay <= 0) {
          clearUpdateTimer();
          emitOutputUpdate();
          return;
        }
        updateTimer ??= setTimeout(() => {
          updateTimer = undefined;
          emitOutputUpdate();
        }, delay);
      };

      if (onUpdate) onUpdate({ content: [], details: undefined });

      const handleData = (data: Buffer) => {
        output.append(data);
        scheduleOutputUpdate();
      };

      const finishOutput = async () => {
        output.finish();
        clearUpdateTimer();
        emitOutputUpdate();
        const snapshot = output.snapshot({ persistIfTruncated: true });
        await output.closeTempFile();
        return snapshot;
      };

      const formatOutput = (snapshot: any, emptyText = "(no output)") => {
        const truncation = snapshot.truncation;
        let text = snapshot.content || emptyText;
        let details;
        if (truncation.truncated) {
          details = { truncation, fullOutputPath: snapshot.fullOutputPath };
          const startLine = truncation.totalLines - truncation.outputLines + 1;
          const endLine = truncation.totalLines;
          if (truncation.lastLinePartial) {
            const lastLineSize = formatSize(output.getLastLineBytes());
            text += `\n\n[Showing last ${formatSize(truncation.outputBytes)} of line ${endLine} (line is ${lastLineSize}). Full output: ${snapshot.fullOutputPath}]`;
          } else if (truncation.truncatedBy === "lines") {
            text += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines}. Full output: ${snapshot.fullOutputPath}]`;
          } else {
            text += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines} (${formatSize(BASH_MAX_BYTES)} limit). Full output: ${snapshot.fullOutputPath}]`;
          }
        }
        return { text, details };
      };

      const appendStatus = (text: string, status: string) => `${text ? `${text}\n\n` : ""}${status}`;

      try {
        let exitCode;
        try {
          const result = await ops.exec(input.command, resolved.path, {
            onData: handleData,
            signal,
            timeout: input.timeout,
          });
          exitCode = result.exitCode;
        } catch (err) {
          const snapshot = await finishOutput();
          const { text } = formatOutput(snapshot, "");
          if (err instanceof Error && err.message === "aborted") {
            throw new Error(appendStatus(text, "Command aborted"));
          }
          if (err instanceof Error && err.message.startsWith("timeout:")) {
            const timeoutSecs = err.message.split(":")[1];
            throw new Error(appendStatus(text, `Command timed out after ${timeoutSecs} seconds`));
          }
          throw err;
        }

        const snapshot = await finishOutput();
        const { text: outputText, details } = formatOutput(snapshot);
        if (exitCode !== 0 && exitCode !== null) {
          throw new Error(appendStatus(outputText, `Command exited with code ${exitCode}`));
        }
        return { content: [{ type: "text", text: outputText }], details };
      } finally {
        clearUpdateTimer();
      }
    },
  });
}
