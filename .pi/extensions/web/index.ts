import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createServer, type Server } from "node:http";
import { summarizeCosts } from "../_shared/cost-history.ts";
import { discoverSessions, parseSessionFile, searchSessionsWithMode } from "../_shared/session-history.ts";
import { listSkillCatalog } from "../_shared/skill-catalog.ts";
import { readHistory, reflectionQueue } from "../reflect-skills/index.ts";

let server: Server | undefined;
let port = 0;

function url(): string { return `http://127.0.0.1:${port}`; }

const page = `<!doctype html><meta charset="utf-8"><title>little-coder web</title>
<style>body{font:14px system-ui;margin:0;background:#f7f3ea;color:#1a1410}.wrap{max-width:1200px;margin:auto;padding:24px}section{background:white;border:1px solid #e4d8c6;border-radius:12px;padding:16px;margin:14px 0}button,input{font:inherit}button{background:#e15a1f;color:white;border:0;border-radius:8px;padding:7px 10px}input{padding:7px;border:1px solid #cdbfae;border-radius:8px}pre{white-space:pre-wrap;background:#1a1410;color:#f2ebdc;padding:12px;border-radius:8px;max-height:420px;overflow:auto}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:12px}.card{border:1px solid #eee;border-radius:8px;padding:10px}.muted{color:#766}.bar{background:#e15a1f;height:12px;border-radius:8px}</style>
<div class="wrap"><h1>little-coder web</h1><p class="muted">Local dashboard bound to 127.0.0.1. Chat/abort/new-session and permission prompt controls are placeholders until Pi exposes a stable web control API.</p>
<section><h2>Command palette</h2><div id="commands" class="grid"></div></section>
<section><h2>Cost dashboard</h2><div id="costs"></div></section>
<section><h2>Breadcrumbs</h2><input id="bq" placeholder="search prior sessions"><button onclick="searchBreadcrumbs()">Search</button><pre id="breadcrumbs"></pre></section>
<section><h2>Reflection review</h2><div id="reflection"></div></section>
<section><h2>Skills</h2><div id="skills"></div></section>
<section><h2>Tools</h2><div id="tools"></div></section>
<section><h2>Transcript / tool blocks</h2><pre id="transcript">Use breadcrumbs search/read to inspect bounded transcript chunks. Tool outputs are hidden by default.</pre></section>
</div>
<script>
const commands=['/plan','/plan-prompt','/execute','/review','/autoresearch','/breadcrumbs','/reflect','/reflect-review','/reflect-accept','/reflect-deny','/reflect-history','/skills','/promote-user-skill','/usage','/insights','/inspect','/web'];
const esc=s=>String(s??'').replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
async function get(p){return fetch(p).then(r=>r.json())}
function entries(obj){return Object.entries(obj||{}).sort((a,b)=>(b[1].cost||b[1].messages||b[1].calls||0)-(a[1].cost||a[1].messages||a[1].calls||0)).map(([k,v])=>'<div class="card"><b>'+esc(k)+'</b><br>'+esc(JSON.stringify(v))+'</div>').join('')}
async function load(){
 document.getElementById('commands').innerHTML=commands.map(c=>'<div class="card"><b>'+c+'</b><br><span class="muted">Run in the TUI command palette.</span></div>').join('');
 const costs=await get('/api/costs'); const max=Math.max(...(costs.daily||[]).map(d=>d.cost),1);
 document.getElementById('costs').innerHTML='<p>Total cost $'+costs.totalCost.toFixed(4)+' · sessions '+costs.sessions+' · messages '+costs.messages+'</p><h3>Daily spend</h3>'+((costs.daily||[]).map(d=>'<div>'+esc(d.date)+' $'+d.cost.toFixed(4)+'<div class="bar" style="width:'+(100*d.cost/max)+'%"></div></div>').join('')||'<p>No cost data.</p>')+'<h3>Models</h3><div class="grid">'+entries(costs.models)+'</div><h3>Tools</h3><div class="grid">'+entries(costs.tools)+'</div><h3>Projects</h3><div class="grid">'+entries(costs.projects)+'</div><h3>Top sessions</h3><pre>'+esc(JSON.stringify(costs.topSessions,null,2))+'</pre>';
 const reflection=await get('/api/reflection'); document.getElementById('reflection').innerHTML='<h3>Queue</h3><pre>'+esc(JSON.stringify(reflection.queue,null,2))+'</pre><h3>History</h3><pre>'+esc(reflection.history)+'</pre><p class="muted">Approve/deny/edit from TUI: /reflect-review accept|deny|edit [n].</p>';
 const skills=await get('/api/skills'); document.getElementById('skills').innerHTML='<div class="grid">'+skills.slice(0,80).map(s=>'<div class="card"><b>'+esc(s.name)+'</b> <span class="muted">'+s.origin+'</span><br>'+esc(s.description||'')+'</div>').join('')+'</div>';
 const tools=await get('/api/tools'); document.getElementById('tools').innerHTML='<div class="grid">'+tools.map(t=>'<div class="card"><b>'+esc(t.name)+'</b><br>'+esc(t.description||'')+'</div>').join('')+'</div>';
}
async function searchBreadcrumbs(){const q=document.getElementById('bq').value; document.getElementById('breadcrumbs').textContent=JSON.stringify(await get('/api/breadcrumbs?q='+encodeURIComponent(q)+'&mode=semantic'),null,2)}
load();
</script>`;

function json(res: any, data: unknown): void { res.writeHead(200, { "content-type": "application/json; charset=utf-8" }); res.end(JSON.stringify(data, null, 2)); }
function notFound(res: any): void { res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }); res.end("Not found"); }

async function route(req: any, res: any, pi: ExtensionAPI, preferred: number): Promise<void> {
  const u = new URL(req.url ?? "/", `http://127.0.0.1:${port || preferred}`);
  if (u.pathname === "/api/status") return json(res, { running: true, url: `http://127.0.0.1:${port || preferred}`, chat: "placeholder", permissionPrompts: "TUI-only" });
  if (u.pathname === "/api/costs") return json(res, summarizeCosts());
  if (u.pathname === "/api/skills") return json(res, listSkillCatalog());
  if (u.pathname === "/api/reflection") return json(res, { queue: reflectionQueue(), history: readHistory() });
  if (u.pathname === "/api/breadcrumbs") return json(res, await searchSessionsWithMode(u.searchParams.get("q") ?? "", u.searchParams.get("mode") ?? "lexical", discoverSessions(), process.cwd(), Math.min(Number(u.searchParams.get("limit") ?? 5), 20)));
  if (u.pathname.startsWith("/api/session/")) {
    const id = decodeURIComponent(u.pathname.slice("/api/session/".length));
    const found = discoverSessions().find((s) => s.id === id || s.path === id || s.id.endsWith(id));
    if (!found) return notFound(res);
    const parsed = parseSessionFile(found.path) ?? found;
    return json(res, { ...parsed, turns: parsed.turns.filter((t) => !t.toolName && t.role !== "tool" && t.role !== "tool_result").slice(0, 40) });
  }
  if (u.pathname === "/api/tools") {
    const tools = typeof (pi as any).getAllTools === "function" ? (pi as any).getAllTools() : [];
    return json(res, tools.map((t: any) => ({ name: t.name, description: t.description ?? "" })));
  }
  if (u.pathname === "/") { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end(page); return; }
  return notFound(res);
}

function start(pi: ExtensionAPI, preferred = 3877): Promise<string> {
  if (server) return Promise.resolve(`web already running at http://127.0.0.1:${port}`);
  return new Promise((resolve, reject) => {
    const s = createServer((req, res) => { route(req, res, pi, preferred).catch((e) => json(res, { error: String(e?.message ?? e) })); });
    s.once("error", reject);
    s.listen(preferred, "127.0.0.1", () => { server = s; port = (s.address() as any).port; resolve(`web running at http://127.0.0.1:${port}\nRemote SSH: ssh -L ${port}:127.0.0.1:${port} <host>`); });
  });
}
function stop(): string { if (!server) return "web is not running"; server.close(); server = undefined; const old = port; port = 0; return `stopped web on ${old}`; }
async function openWeb(pi: ExtensionAPI): Promise<string> { if (!server) await start(pi); try { const open = (await import("open")).default; await open(url()); return `opened ${url()}`; } catch { return `open manually: ${url()}`; } }

export default function (pi: ExtensionAPI) {
  pi.registerCommand("web", {
    description: "Start/stop/status/open the local little-coder web dashboard",
    handler: async (args, ctx) => {
      const action = String(args ?? "start").trim() || "start";
      try {
        if (action === "stop") ctx.ui?.notify?.(stop(), "info");
        else if (action === "status") ctx.ui?.notify?.(server ? `web running at ${url()}` : "web is stopped", "info");
        else if (action === "restart") { stop(); ctx.ui?.notify?.(await start(pi), "info"); }
        else if (action === "open") ctx.ui?.notify?.(await openWeb(pi), "info");
        else ctx.ui?.notify?.(await start(pi), "info");
      } catch (e) { ctx.ui?.notify?.(`web error: ${(e as Error).message}`, "error"); }
    },
  });
}
