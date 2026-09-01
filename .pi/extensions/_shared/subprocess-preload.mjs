import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { registerChildProcess } from "./subprocess.ts";

// LITTLE_CODER_TIMING=1: report this preload's own evaluation cost (the
// --import critical path before pi's entry starts). Gated so normal runs
// stay silent; never throws.
try {
  if (process.env.LITTLE_CODER_TIMING === "1") {
    const t0 = performance.now();
    process.nextTick(() => {
      try {
        process.stderr.write(
          `little-coder launch timing: preload=${Math.max(0, Math.round(performance.now() - t0))}ms\n`,
        );
      } catch {
        // ignore
      }
    });
  }
} catch {
  // observability must never break startup
}

if (!globalThis.__littleCoderSubprocessPreloadInstalled) {
  globalThis.__littleCoderSubprocessPreloadInstalled = true;
  const originalSpawn = childProcess.spawn;
  childProcess.spawn = function littleCoderTrackedSpawn(
    command,
    args,
    options,
  ) {
    const normalizedArgs = Array.isArray(args) ? args : [];
    const normalizedOptions = Array.isArray(args) ? options : args;
    const child = originalSpawn.apply(this, arguments);
    try {
      registerChildProcess(child, String(command), normalizedArgs.map(String), {
        cwd:
          normalizedOptions && typeof normalizedOptions === "object"
            ? normalizedOptions.cwd
            : undefined,
      });
    } catch {
      // Never let observability break process startup.
    }
    return child;
  };
  syncBuiltinESMExports();
}
