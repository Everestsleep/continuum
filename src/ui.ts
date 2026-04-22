import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { dirname } from "node:path";
import { displayCwd, displayName, formatAge, formatSize, scan, type ScannedSession } from "./scan.js";
import { loadAliases } from "./aliases.js";
import { loadWatchlist, replaceWatchlist } from "./watchlist.js";
import { scheduleAt, shQuote, formatTarget, formatDelay } from "./schedule.js";

interface SessionDTO {
  sessionId: string;
  displayName: string;
  cwd: string;
  size: string;
  age: string;
  mtimeMs: number;
  isActive: boolean;
  isWatched: boolean;
  isAliased: boolean;
}

function toDTO(s: ScannedSession, aliases: Record<string, string>, watchedSet: Set<string>): SessionDTO {
  return {
    sessionId: s.sessionId,
    displayName: displayName(s, aliases),
    cwd: displayCwd(s),
    size: formatSize(s.size),
    age: formatAge(s.mtime),
    mtimeMs: s.mtime.getTime(),
    isActive: Date.now() - s.mtime.getTime() < 5 * 60_000,
    isWatched: watchedSet.has(s.sessionId),
    isAliased: Boolean(aliases[s.sessionId]),
  };
}

function listSessions(): SessionDTO[] {
  const sessions = scan({ withinHours: 24, minSize: 50 * 1024, includeCleanlyEnded: false, minAgeSeconds: 0 });
  const aliases = loadAliases();
  const watched = new Set(loadWatchlist().map((e) => e.sessionId));
  return sessions.map((s) => toDTO(s, aliases, watched));
}

function continuumBin(): string {
  try {
    return realpathSync(process.argv[1] ?? "");
  } catch {
    return process.argv[1] ?? "";
  }
}

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) });
  res.end(body);
}

async function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

function resumeNow(sessionIds: string[]): { pids: number[] } {
  const bin = continuumBin();
  const pids: number[] = [];
  for (const id of sessionIds) {
    const child = spawn("node", [bin, id], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
    if (child.pid) pids.push(child.pid);
  }
  return { pids };
}

function scheduleResume(sessionIds: string[], at: string): { pid: number; targetEpochMs: number; delaySec: number; logFile: string } {
  const bin = continuumBin();
  const args = ["resume-all", "--yes", "--no-cluster", "--all", "--within", "48h"];
  for (const id of sessionIds) args.push("--id", id);
  const cmd = `node ${shQuote(bin)} ${args.map((a) => shQuote(a)).join(" ")}`;
  return scheduleAt(at, cmd);
}

const HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>continuum</title>
<style>
  :root {
    --bg: #0b0d10;
    --panel: #14181e;
    --panel-2: #1b2028;
    --border: #262c36;
    --text: #e6e9ef;
    --muted: #8a93a3;
    --accent: #6aa7ff;
    --accent-strong: #3b82f6;
    --good: #3fd179;
    --warn: #f2b54b;
    --danger: #ef6461;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: var(--bg);
    color: var(--text);
    font: 14px/1.5 -apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif;
  }
  header {
    padding: 24px 32px 8px;
    border-bottom: 1px solid var(--border);
  }
  h1 { margin: 0; font-size: 22px; font-weight: 600; letter-spacing: -0.01em; }
  .sub { color: var(--muted); margin-top: 4px; font-size: 13px; }
  main { padding: 20px 32px 120px; max-width: 1000px; }
  .toolbar {
    display: flex; gap: 8px; align-items: center; flex-wrap: wrap;
    padding: 12px 32px;
    background: var(--panel);
    border-bottom: 1px solid var(--border);
    position: sticky; top: 0; z-index: 10;
  }
  .toolbar .spacer { flex: 1; min-width: 8px; }
  @media (max-width: 600px) {
    header, main, .toolbar, .footer-actions { padding-left: 16px; padding-right: 16px; }
    button { padding: 6px 10px; font-size: 13px; }
  }
  button, input[type="time"], input[type="text"] {
    background: var(--panel-2);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 8px 14px;
    font: inherit;
    cursor: pointer;
    transition: background .15s, border-color .15s;
  }
  button:hover { background: #222834; border-color: #364050; }
  button.primary { background: var(--accent-strong); border-color: var(--accent-strong); color: white; }
  button.primary:hover { background: #4691ff; }
  button.ghost { background: transparent; }
  button[disabled] { opacity: 0.4; cursor: not-allowed; }
  .list { display: flex; flex-direction: column; gap: 8px; margin-top: 0; padding-top: 16px; }
  .row {
    display: grid; grid-template-columns: 32px 1fr auto; gap: 14px;
    align-items: center;
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 14px 16px;
    transition: background .15s, border-color .15s;
  }
  .row:hover { background: var(--panel-2); }
  .row.checked { border-color: var(--accent-strong); background: #162136; }
  .row .name { font-weight: 500; }
  .row .meta { color: var(--muted); font-size: 12px; margin-top: 2px; }
  .row input[type="checkbox"] {
    width: 18px; height: 18px; accent-color: var(--accent-strong); cursor: pointer;
  }
  .pill {
    display: inline-block; font-size: 11px; padding: 2px 8px; border-radius: 999px;
    margin-left: 8px; vertical-align: middle;
  }
  .pill.active { background: rgba(63,209,121,.15); color: var(--good); }
  .pill.watched { background: rgba(106,167,255,.15); color: var(--accent); }
  .pill.aliased { background: rgba(242,181,75,.15); color: var(--warn); }
  .footer-actions {
    position: fixed; bottom: 0; left: 0; right: 0;
    padding: 14px 32px;
    background: var(--panel);
    border-top: 1px solid var(--border);
    display: flex; gap: 8px; align-items: center;
  }
  .footer-actions .count { color: var(--muted); }
  /* removed empty #status div — list now starts immediately under the toolbar */
  .toast {
    position: fixed; right: 20px; top: 20px; z-index: 100;
    background: var(--panel-2); border: 1px solid var(--border); border-radius: 8px;
    padding: 12px 16px; max-width: 380px; font-size: 13px;
    box-shadow: 0 8px 24px rgba(0,0,0,.4);
    opacity: 0; transform: translateY(-8px); transition: opacity .2s, transform .2s;
  }
  .toast.show { opacity: 1; transform: translateY(0); }
  .toast.ok { border-color: var(--good); }
  .toast.err { border-color: var(--danger); }
  .empty { color: var(--muted); padding: 40px; text-align: center; }
  input[type="time"] { padding: 8px 10px; font-family: ui-monospace, Menlo, monospace; }
</style>
</head>
<body>
<header>
  <h1>continuum</h1>
  <div class="sub" id="subtitle">Loading…</div>
</header>

<div class="toolbar">
  <button id="refresh">Refresh</button>
  <button id="select-all" class="ghost">Select all</button>
  <button id="select-none" class="ghost">Select none</button>
  <button id="select-watched" class="ghost">Select watched ★</button>
  <button id="select-active" class="ghost">Select active ●</button>
  <div class="spacer"></div>
  <button id="save-watchlist">Save as watchlist</button>
</div>

<main id="root">
  <div class="list" id="list"></div>
</main>

<div class="footer-actions">
  <span class="count" id="count">0 selected</span>
  <div class="spacer" style="flex:1"></div>
  <input type="time" id="at-time" value="04:10" />
  <button id="schedule">Schedule for this time</button>
  <button id="resume-now" class="primary">Resume selected now</button>
</div>

<div class="toast" id="toast"></div>

<script>
  let sessions = [];

  function el(tag, attrs, ...children) {
    const e = document.createElement(tag);
    if (attrs) for (const [k, v] of Object.entries(attrs)) {
      if (k === "className") e.className = v;
      else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
      else if (v !== undefined && v !== null && v !== false) e.setAttribute(k, v);
    }
    for (const c of children) {
      if (c == null) continue;
      e.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    }
    return e;
  }

  async function fetchSessions() {
    const res = await fetch("/api/sessions");
    sessions = await res.json();
    render();
  }

  function render() {
    const list = document.getElementById("list");
    list.innerHTML = "";

    document.getElementById("subtitle").textContent =
      \`\${sessions.length} recent session(s) — \${sessions.filter(s => s.isActive).length} active, \${sessions.filter(s => s.isWatched).length} on watchlist\`;

    if (sessions.length === 0) {
      list.appendChild(el("div", { className: "empty" }, "No recent sessions in the last 24h."));
      updateCount();
      return;
    }

    for (const s of sessions) {
      const chk = el("input", {
        type: "checkbox",
        checked: s.isWatched || false,
        "data-id": s.sessionId,
        onchange: updateCount,
      });
      chk.checked = Boolean(s.isWatched);

      const nameLine = el("div", { className: "name" },
        s.displayName,
        s.isActive ? el("span", { className: "pill active" }, "active") : null,
        s.isWatched ? el("span", { className: "pill watched" }, "★ watched") : null,
        s.isAliased ? el("span", { className: "pill aliased" }, "aliased") : null,
      );
      const metaLine = el("div", { className: "meta" }, \`\${s.cwd} · \${s.size} · \${s.age} · \${s.sessionId.slice(0,8)}\`);

      const row = el("div", { className: "row" + (chk.checked ? " checked" : "") }, chk, el("div", null, nameLine, metaLine));
      chk.addEventListener("change", () => row.classList.toggle("checked", chk.checked));
      list.appendChild(row);
    }
    updateCount();
  }

  function getSelectedIds() {
    return Array.from(document.querySelectorAll("input[type=checkbox][data-id]"))
      .filter(c => c.checked)
      .map(c => c.getAttribute("data-id"));
  }

  function updateCount() {
    const n = getSelectedIds().length;
    document.getElementById("count").textContent = \`\${n} selected\`;
    const disabled = n === 0;
    for (const id of ["resume-now", "schedule", "save-watchlist"]) {
      document.getElementById(id).disabled = disabled;
    }
  }

  function toast(msg, kind = "ok") {
    const t = document.getElementById("toast");
    t.textContent = msg;
    t.className = "toast show " + kind;
    setTimeout(() => t.className = "toast " + kind, 4000);
  }

  async function post(path, body) {
    const res = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  }

  document.getElementById("refresh").addEventListener("click", fetchSessions);
  document.getElementById("select-all").addEventListener("click", () => {
    for (const c of document.querySelectorAll("input[type=checkbox][data-id]")) { c.checked = true; c.dispatchEvent(new Event("change")); }
  });
  document.getElementById("select-none").addEventListener("click", () => {
    for (const c of document.querySelectorAll("input[type=checkbox][data-id]")) { c.checked = false; c.dispatchEvent(new Event("change")); }
  });
  document.getElementById("select-watched").addEventListener("click", () => {
    for (const c of document.querySelectorAll("input[type=checkbox][data-id]")) {
      const id = c.getAttribute("data-id");
      const s = sessions.find(x => x.sessionId === id);
      c.checked = Boolean(s?.isWatched);
      c.dispatchEvent(new Event("change"));
    }
  });
  document.getElementById("select-active").addEventListener("click", () => {
    for (const c of document.querySelectorAll("input[type=checkbox][data-id]")) {
      const id = c.getAttribute("data-id");
      const s = sessions.find(x => x.sessionId === id);
      c.checked = Boolean(s?.isActive);
      c.dispatchEvent(new Event("change"));
    }
  });

  document.getElementById("save-watchlist").addEventListener("click", async () => {
    const ids = getSelectedIds();
    try {
      const r = await post("/api/watchlist", { sessionIds: ids });
      toast(\`Watchlist saved: \${r.count} session(s)\`);
      fetchSessions();
    } catch (e) { toast("Save failed: " + e.message, "err"); }
  });

  document.getElementById("resume-now").addEventListener("click", async () => {
    const ids = getSelectedIds();
    if (!confirm(\`Resume \${ids.length} session(s) now?\`)) return;
    try {
      const r = await post("/api/resume-now", { sessionIds: ids });
      toast(\`Fired \${r.pids.length} resume loop(s) — PIDs: \${r.pids.join(", ")}\`);
    } catch (e) { toast("Failed: " + e.message, "err"); }
  });

  document.getElementById("schedule").addEventListener("click", async () => {
    const ids = getSelectedIds();
    const time = document.getElementById("at-time").value;
    if (!time) { toast("Pick a time first", "err"); return; }
    const [h, m] = time.split(":");
    const hh = Number(h);
    const ampm = hh < 12 ? "am" : "pm";
    const hh12 = hh % 12 || 12;
    const spec = \`\${hh12}:\${m}\${ampm}\`;
    try {
      const r = await post("/api/schedule", { sessionIds: ids, at: spec });
      toast(\`Scheduled for \${r.targetHuman} (PID \${r.pid}). Log: \${r.logFile}\`);
    } catch (e) { toast("Schedule failed: " + e.message, "err"); }
  });

  fetchSessions();
</script>
</body>
</html>`;

export async function startUi(options: { port?: number; openBrowser?: boolean } = {}): Promise<void> {
  const preferredPort = options.port ?? 7500;
  const open = options.openBrowser ?? true;

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    try {
      if (req.method === "GET" && url.pathname === "/") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(HTML);
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/sessions") {
        sendJson(res, 200, listSessions());
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/watchlist") {
        const body = JSON.parse(await readBody(req)) as { sessionIds: string[] };
        replaceWatchlist(body.sessionIds);
        sendJson(res, 200, { count: body.sessionIds.length });
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/resume-now") {
        const body = JSON.parse(await readBody(req)) as { sessionIds: string[] };
        const result = resumeNow(body.sessionIds);
        sendJson(res, 200, result);
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/schedule") {
        const body = JSON.parse(await readBody(req)) as { sessionIds: string[]; at: string };
        const r = scheduleResume(body.sessionIds, body.at);
        sendJson(res, 200, {
          pid: r.pid,
          logFile: r.logFile,
          targetEpochMs: r.targetEpochMs,
          targetHuman: formatTarget(r.targetEpochMs),
          delayHuman: formatDelay(r.delaySec),
        });
        return;
      }
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("404");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      sendJson(res, 500, { error: msg });
    }
  });

  const port = await new Promise<number>((resolve, reject) => {
    server.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        server.listen(0, "127.0.0.1", () => {
          const addr = server.address();
          if (addr && typeof addr === "object") resolve(addr.port);
          else reject(new Error("No address after fallback bind"));
        });
      } else {
        reject(err);
      }
    });
    server.listen(preferredPort, "127.0.0.1", () => resolve(preferredPort));
  });

  const url = `http://127.0.0.1:${port}`;
  process.stdout.write(`\ncontinuum UI: ${url}\nPress Ctrl+C to stop.\n\n`);

  if (open && process.platform === "darwin") {
    spawn("open", [url], { stdio: "ignore" }).unref();
  } else if (open && process.platform === "win32") {
    spawn("cmd", ["/c", "start", "", url], { stdio: "ignore" }).unref();
  }

  // Keep process alive until SIGINT
  await new Promise<void>((resolve) => {
    process.on("SIGINT", () => {
      server.close();
      resolve();
    });
  });
}
