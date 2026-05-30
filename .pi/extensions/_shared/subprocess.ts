import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";

export type ManagedSubprocessStatus = "running" | "exited" | "error" | "stopping";

export interface ManagedSubprocess {
	id: number;
	name: string;
	command: string;
	args: string[];
	cwd?: string;
	pid?: number;
	startedAt: number;
	stoppedAt?: number;
	status: ManagedSubprocessStatus;
	exitCode?: number | null;
	signal?: NodeJS.Signals | null;
	error?: string;
	child: ChildProcess;
}

export interface StartSubprocessOptions extends SpawnOptions {
	name?: string;
}

export interface RegisterSubprocessOptions {
	name?: string;
	cwd?: SpawnOptions["cwd"];
}

let nextId = 1;
const processes = new Map<number, ManagedSubprocess>();
const childIds = new WeakMap<ChildProcess, number>();

function unregisterWhenDone(entry: ManagedSubprocess): void {
	entry.child.once("error", (err) => {
		entry.status = "error";
		entry.error = err.message;
		entry.stoppedAt = Date.now();
		processes.delete(entry.id);
	});
	entry.child.once("close", (code, signal) => {
		entry.status = code === 0 ? "exited" : "error";
		entry.exitCode = code;
		entry.signal = signal;
		entry.stoppedAt = Date.now();
		processes.delete(entry.id);
	});
}

export function registerChildProcess(
	child: ChildProcess,
	command: string,
	args: readonly string[] = [],
	options: RegisterSubprocessOptions = {},
): ManagedSubprocess {
	const existingId = childIds.get(child);
	if (existingId !== undefined) {
		const existing = processes.get(existingId);
		if (existing) {
			existing.name = options.name || existing.name;
			existing.command = command || existing.command;
			existing.args = [...args];
			if (typeof options.cwd === "string") existing.cwd = options.cwd;
			return existing;
		}
	}

	const entry: ManagedSubprocess = {
		id: nextId++,
		name: options.name || command,
		command,
		args: [...args],
		cwd: typeof options.cwd === "string" ? options.cwd : undefined,
		pid: child.pid,
		startedAt: Date.now(),
		status: "running",
		child,
	};
	processes.set(entry.id, entry);
	childIds.set(child, entry.id);
	unregisterWhenDone(entry);
	return entry;
}

export function startSubprocess(command: string, args: readonly string[] = [], options: StartSubprocessOptions = {}): ManagedSubprocess {
	const { name, ...spawnOptions } = options;
	const child = spawn(command, [...args], spawnOptions);
	return registerChildProcess(child, command, args, { name, cwd: spawnOptions.cwd });
}

export const StartSubprocess = startSubprocess;

export function listSubprocesses(): ManagedSubprocess[] {
	return [...processes.values()].sort((a, b) => a.id - b.id);
}

export function stopSubprocess(id: number, signal: NodeJS.Signals = "SIGTERM"): boolean {
	const entry = processes.get(id);
	if (!entry) return false;
	entry.status = "stopping";
	try {
		entry.child.kill(signal);
		return true;
	} catch (err) {
		entry.status = "error";
		entry.error = err instanceof Error ? err.message : String(err);
		entry.stoppedAt = Date.now();
		processes.delete(id);
		return false;
	}
}

export function stopAllSubprocesses(): void {
	for (const entry of listSubprocesses()) stopSubprocess(entry.id);
}
