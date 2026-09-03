#!/usr/bin/env node
// Always-on sentinel, independent of pm2 - this is the one thing that must
// still answer when the pm2 daemon (and everything it manages, including the
// ai-cron dashboard) is down. Runs under its own launchd agent with real
// KeepAlive, not pm2. Serves a status/start page on a separate port and can
// `pm2 resurrect` on request.
"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const { spawn, spawnSync } = require("child_process");

const PORT = process.env.AI_CRON_WATCHDOG_PORT || 47891;
const DASHBOARD_URL = "http://localhost:47890";
// launchd gives this agent a minimal PATH (/usr/bin:/bin:/usr/sbin:/sbin) -
// pm2's own shebang (#!/usr/bin/env node) can't resolve `node` in it, so it
// must be invoked as `node <pm2-bin>`, both by absolute path, never bare.
const NODE_BIN =
  "/Users/bruno/Library/Application Support/Herd/config/nvm/versions/node/v24.18.0/bin/node";
const PM2_BIN =
  "/Users/bruno/Library/Application Support/Herd/config/nvm/versions/node/v24.18.0/bin/pm2";
const PM2_PID_PATH = path.join(process.env.HOME, ".pm2", "pm2.pid");
const START_HTML = path.join(__dirname, "public", "start.html");

function send(res, status, body, contentType) {
  const payload = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": contentType || (typeof body === "string" ? "text/plain" : "application/json"),
    // The dashboard (different origin/port) calls /stop directly - it's the
    // one thing that can reliably outlive `pm2 kill`, see /stop below.
    "Access-Control-Allow-Origin": DASHBOARD_URL,
  });
  res.end(payload);
}

function readDaemonPid() {
  try {
    return parseInt(fs.readFileSync(PM2_PID_PATH, "utf8").trim(), 10) || null;
  } catch {
    return null;
  }
}

function pidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (req.method === "GET" && url.pathname === "/") {
    const html = fs.readFileSync(START_HTML, "utf8");
    return send(res, 200, html, "text/html");
  }

  if (req.method === "GET" && url.pathname === "/ping") {
    return send(res, 200, { ok: true });
  }

  if (req.method === "POST" && url.pathname === "/start") {
    const proc = spawnSync(NODE_BIN, [PM2_BIN, "resurrect"], {
      encoding: "utf8",
      timeout: 20000,
      env: { ...process.env, PATH: `${path.dirname(NODE_BIN)}:${process.env.PATH || ""}` },
    });
    if (proc.error) {
      return send(res, 500, { error: proc.error.message });
    }
    if (proc.status !== 0) {
      return send(res, 500, {
        error: `pm2 resurrect exited ${proc.status}`,
        stdout: proc.stdout,
        stderr: proc.stderr,
      });
    }
    return send(res, 200, { started: true, output: proc.stdout });
  }

  if (req.method === "POST" && url.pathname === "/stop") {
    // `pm2 kill` has a real bug: it sets an internal "being killed" flag,
    // then waits on an async socket-close callback that never fires if any
    // client is still connected to the daemon's RPC socket at that moment -
    // and the CLI reports success anyway after a blind 3s timeout regardless
    // of whether the daemon actually died. This endpoint lives outside pm2
    // (unlike the dashboard, which dies with the daemon), so it can verify
    // the daemon's pid is actually gone and SIGKILL it directly if not.
    const pidBefore = readDaemonPid();
    const env = { ...process.env, PATH: `${path.dirname(NODE_BIN)}:${process.env.PATH || ""}` };
    spawnSync(NODE_BIN, [PM2_BIN, "kill"], { encoding: "utf8", timeout: 8000, env });

    if (!pidBefore) {
      return send(res, 200, { stopped: true, method: "no-daemon-pid-found" });
    }
    if (!pidAlive(pidBefore)) {
      return send(res, 200, { stopped: true, method: "pm2-kill" });
    }
    try {
      process.kill(pidBefore, "SIGKILL");
    } catch {}
    return send(res, 200, { stopped: true, method: "force-sigkill", pid: pidBefore });
  }

  send(res, 404, { error: "not found" });
});

server.listen(PORT, () => {
  console.log(`ai-cron watchdog on http://localhost:${PORT}`);
});
