import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { listSubprocesses, stopSubprocess } from "../_shared/subprocess.js";

function formatAge(ms: number): string {
	const seconds = Math.max(0, Math.floor(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
	const hours = Math.floor(minutes / 60);
	return `${hours}h ${minutes % 60}m`;
}

export default function subprocessExtension(pi: ExtensionAPI) {
	pi.registerCommand("subprocesses", {
		description: "List managed background subprocesses, or stop one with /subprocesses stop <id>",
		handler: async (args, ctx) => {
			const text = String(args ?? "").trim();
			const parts = text.split(/\s+/).filter(Boolean);
			if (parts[0] === "stop") {
				const id = Number(parts[1]);
				if (!Number.isInteger(id) || id <= 0) {
					ctx.ui.notify("Usage: /subprocesses stop <id>", "error");
					return;
				}
				const ok = stopSubprocess(id);
				ctx.ui.notify(ok ? `Stopping subprocess ${id}` : `No subprocess with id ${id}`, ok ? "info" : "error");
				return;
			}

			const entries = listSubprocesses();
			if (entries.length === 0) {
				ctx.ui.notify("No managed subprocesses are running.");
				return;
			}
			const now = Date.now();
			ctx.ui.notify([
				"Managed subprocesses:",
				...entries.map((p) => `  ${p.id}  ${p.name}  pid=${p.pid ?? "?"}  ${p.status}  ${formatAge(now - p.startedAt)}  ${p.command} ${p.args.join(" ")}`),
				"",
				"Stop one with /subprocesses stop <id>",
			].join("\n"));
		},
	});

	pi.registerCommand("subprocess", {
		description: "Alias for /subprocesses",
		handler: async (args, ctx) => {
			const text = String(args ?? "").trim();
			if (!text) {
				const entries = listSubprocesses();
				ctx.ui.notify(entries.length ? entries.map((p) => `${p.id}: ${p.name} pid=${p.pid ?? "?"} ${p.status}`).join("\n") : "No managed subprocesses are running.");
				return;
			}
			const m = text.match(/^stop\s+(\d+)$/);
			if (!m) {
				ctx.ui.notify("Usage: /subprocess stop <id>", "error");
				return;
			}
			const id = Number(m[1]);
			const ok = stopSubprocess(id);
			ctx.ui.notify(ok ? `Stopping subprocess ${id}` : `No subprocess with id ${id}`, ok ? "info" : "error");
		},
	});
}
