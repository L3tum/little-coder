import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { registerChildProcess } from "./subprocess.ts";

if (!globalThis.__littleCoderSubprocessPreloadInstalled) {
	globalThis.__littleCoderSubprocessPreloadInstalled = true;
	const originalSpawn = childProcess.spawn;
	childProcess.spawn = function littleCoderTrackedSpawn(command, args, options) {
		const normalizedArgs = Array.isArray(args) ? args : [];
		const normalizedOptions = Array.isArray(args) ? options : args;
		const child = originalSpawn.apply(this, arguments);
		try {
			registerChildProcess(child, String(command), normalizedArgs.map(String), {
				cwd: normalizedOptions && typeof normalizedOptions === "object" ? normalizedOptions.cwd : undefined,
			});
		} catch {
			// Never let observability break process startup.
		}
		return child;
	};
	syncBuiltinESMExports();
}
