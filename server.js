#!/usr/bin/env node
// Minimal dashboard for the ai-cron jobs: view status, run now, add/edit/delete.
// No dependencies - built-in http only. Jobs are scheduled via pm2 cron-restart,
// kept in sync with manifest.json on every mutation and on server start.
"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const { spawn, spawnSync } = require("child_process");

const PORT = process.env.AI_CRON_PORT || 47890;
const MANIFEST_PATH = path.join(__dirname, "manifest.json");
const RUNNER_PATH = path.join(__dirname, "runner.js");
const LOGS_DIR = path.join(__dirname, "logs");
const INDEX_HTML = path.join(__dirname, "public", "index.html");

// One page per AI, sharing the same template. runner.js's EXECUTORS map
// decides what's actually runnable - keep this in sync with that.
const PROVIDERS = {
  claude: { name: "Claude", ready: true },
  chatgpt: { name: "ChatGPT", ready: true },
};
const DEFAULT_PROVIDER = "claude";

function loadManifest() {
  return JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
}

function saveManifest(manifest) {
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + "\n");
}

function pm2Name(id) {
  return `ai-cron-${id}`;
}

// pm2 launches an app immediately on `pm2 start`, even one only meant to be
// cron-scheduled - so delete+recreate must be skipped whenever the existing
// registration already matches, or every dashboard restart (reconcile() on
// boot) would silently re-run every enabled job and burn real API cost.
function syncPm2(job, force = false) {
  const existing = pm2Status().find((p) => p.name === pm2Name(job.id));
  if (!job.enabled) {
    if (existing) removePm2(job.id);
    return;
  }
  const currentCron = existing?.pm2_env?.cron_restart || null;
  const needsWork =
    force || !existing || existing.pm2_env.status === "errored" || currentCron !== job.schedule;
  if (!needsWork) return;
  spawnSync("pm2", ["delete", pm2Name(job.id)], { encoding: "utf8" });
  spawnSync(
    "pm2",
    [
      "start",
      RUNNER_PATH,
      "--name",
      pm2Name(job.id),
      "--cron-restart",
      job.schedule,
      "--no-autorestart",
      "--",
      job.id,
    ],
    { encoding: "utf8" }
  );
}

function removePm2(id) {
  spawnSync("pm2", ["delete", pm2Name(id)], { encoding: "utf8" });
}

function pm2Status() {
  const proc = spawnSync("pm2", ["jlist"], {
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });
  try {
    return JSON.parse(proc.stdout || "[]");
  } catch {
    return [];
  }
}

// Minimal 5-field cron next-fire calculator (min hour dom month dow), no deps.
// Supports *, */step, a-b, a-b/step, comma lists. Day matches OR between
// dom/dow when both are restricted, per standard cron semantics.
function parseCronField(field, min, max) {
  const out = new Set();
  for (const part of field.split(",")) {
    const stepMatch = part.match(/^(\*|\d+-\d+|\d+)(?:\/(\d+))?$/);
    if (!stepMatch) continue;
    const [, range, stepStr] = stepMatch;
    const step = stepStr ? parseInt(stepStr, 10) : 1;
    let lo = min, hi = max;
    if (range !== "*") {
      if (range.includes("-")) {
        [lo, hi] = range.split("-").map(Number);
      } else {
        lo = hi = Number(range);
      }
    }
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
}

function nextCronFire(cronExpr, from = new Date()) {
  const fields = cronExpr.trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const [minF, hourF, domF, monF, dowF] = fields;
  const minutes = parseCronField(minF, 0, 59);
  const hours = parseCronField(hourF, 0, 23);
  const doms = parseCronField(domF, 1, 31);
  const months = parseCronField(monF, 1, 12);
  const dows = parseCronField(dowF, 0, 7);
  if (dows.has(7)) dows.add(0);

  const domRestricted = domF !== "*";
  const dowRestricted = dowF !== "*";
  const sortedHours = [...hours].sort((a, b) => a - b);
  const sortedMinutes = [...minutes].sort((a, b) => a - b);
  if (!sortedHours.length || !sortedMinutes.length) return null;

  const cursor = new Date(from.getTime());
  cursor.setSeconds(0, 0);
  cursor.setMinutes(cursor.getMinutes() + 1);

  for (let dayGuard = 0; dayGuard < 366 * 2; dayGuard++) {
    const month = cursor.getMonth() + 1;
    const dom = cursor.getDate();
    const dow = cursor.getDay();
    const dayMatches =
      months.has(month) &&
      (domRestricted && dowRestricted
        ? doms.has(dom) || dows.has(dow)
        : domRestricted
        ? doms.has(dom)
        : dowRestricted
        ? dows.has(dow)
        : true);

    if (dayMatches) {
      for (const h of sortedHours) {
        for (const m of sortedMinutes) {
          const candidate = new Date(
            cursor.getFullYear(), cursor.getMonth(), cursor.getDate(), h, m, 0, 0
          );
          if (candidate >= from) return candidate;
        }
      }
    }
    cursor.setDate(cursor.getDate() + 1);
    cursor.setHours(0, 0, 0, 0);
  }
  return null;
}

function pm2DaemonInfo() {
  const ping = spawnSync("pm2", ["ping"], { encoding: "utf8", timeout: 5000 });
  const reachable = !ping.error && ping.status === 0;
  if (!reachable) return { reachable: false, version: null, pid: null };

  const ver = spawnSync("pm2", ["--version"], { encoding: "utf8", timeout: 5000 });
  let pid = null;
  try {
    pid = parseInt(
      fs.readFileSync(path.join(process.env.HOME, ".pm2", "pm2.pid"), "utf8").trim(),
      10
    );
  } catch {}
  return { reachable: true, version: (ver.stdout || "").trim() || null, pid };
}

function claudeAuthStatus() {
  const proc = spawnSync("claude", ["auth", "status"], {
    encoding: "utf8",
    timeout: 10000,
  });
  try {
    return JSON.parse(proc.stdout || "{}");
  } catch {
    return { loggedIn: false, authMethod: "unknown" };
  }
}

function slugify(name) {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "job"
  );
}

function uniqueId(manifest, base) {
  let id = base;
  let n = 2;
  while (manifest.jobs.some((j) => j.id === id)) {
    id = `${base}-${n}`;
    n += 1;
  }
  return id;
}

function isValidCron(expr) {
  return typeof expr === "string" && expr.trim().split(/\s+/).length === 5;
}

function send(res, status, body, headers) {
  const payload = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type":
      typeof body === "string" ? "text/plain" : "application/json",
    // The watchdog page (a different origin/port) polls /api/health to
    // detect when this server is back up - needs a real (non-opaque) fetch.
    "Access-Control-Allow-Origin": "http://localhost:47891",
    ...headers,
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

function withPm2Info(manifest) {
  const statuses = pm2Status();
  const byName = new Map(statuses.map((p) => [p.name, p]));
  return manifest.jobs.map((j) => {
    const p = byName.get(pm2Name(j.id));
    const registered = !!p && p.pm2_env.status !== "errored";
    let nextFireAt = null;
    if (registered) {
      try {
        nextFireAt = nextCronFire(j.schedule)?.toISOString() || null;
      } catch {
        nextFireAt = null;
      }
    }
    return {
      ...j,
      pm2: p
        ? {
            status: p.pm2_env.status,
            nextRestart: p.pm2_env.cron_restart || null,
          }
        : null,
      nextFireAt,
    };
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  try {
    if (req.method === "GET" && url.pathname === "/") {
      res.writeHead(302, { Location: `/${DEFAULT_PROVIDER}` });
      return res.end();
    }

    const providerPage = url.pathname.match(/^\/([^/]+)$/)?.[1];
    if (req.method === "GET" && providerPage && PROVIDERS[providerPage]) {
      const html = fs.readFileSync(INDEX_HTML, "utf8");
      return send(res, 200, html, { "Content-Type": "text/html" });
    }

    if (req.method === "GET" && url.pathname === "/api/providers") {
      return send(res, 200, { providers: PROVIDERS, default: DEFAULT_PROVIDER });
    }

    if (req.method === "GET" && url.pathname === "/api/jobs") {
      const manifest = loadManifest();
      return send(res, 200, { jobs: withPm2Info(manifest) });
    }

    if (req.method === "GET" && url.pathname === "/api/health") {
      return send(res, 200, {
        claudeAuth: claudeAuthStatus(),
        pm2: pm2DaemonInfo(),
      });
    }

    if (req.method === "POST" && url.pathname === "/api/auth/connect") {
      const script = 'tell application "Terminal" to do script "claude auth login"';
      const proc = spawnSync("osascript", ["-e", script], { encoding: "utf8" });
      if (proc.error || proc.status !== 0) {
        return send(res, 500, {
          error: "could not open Terminal: " + (proc.error?.message || proc.stderr),
        });
      }
      return send(res, 200, { opened: true });
    }

    const pm2SyncMatch = url.pathname.match(/^\/api\/jobs\/([^/]+)\/pm2-sync$/);
    if (pm2SyncMatch && req.method === "POST") {
      const id = decodeURIComponent(pm2SyncMatch[1]);
      const manifest = loadManifest();
      const job = manifest.jobs.find((j) => j.id === id);
      if (!job) return send(res, 404, { error: "not found" });
      syncPm2(job, true);
      return send(res, 200, { synced: true });
    }

    if (req.method === "POST" && url.pathname === "/api/jobs") {
      const body = await readBody(req);
      if (!body.name || !body.schedule || !body.cwd || !body.prompt) {
        return send(res, 400, {
          error: "name, schedule, cwd and prompt are required",
        });
      }
      if (!isValidCron(body.schedule)) {
        return send(res, 400, { error: "schedule must be a 5-field cron expression" });
      }
      const provider = PROVIDERS[body.provider] ? body.provider : DEFAULT_PROVIDER;
      const manifest = loadManifest();
      const id = uniqueId(manifest, slugify(body.name));
      const job = {
        id,
        name: body.name,
        provider,
        model: body.model || "",
        description: body.description || "",
        schedule: body.schedule,
        cwd: body.cwd,
        prompt: body.prompt,
        context_files: Array.isArray(body.context_files)
          ? body.context_files
          : [],
        output: body.output && body.output.mode
          ? { mode: body.output.mode, path: body.output.path || "" }
          : { mode: "none" },
        timeoutMs: Number(body.timeoutMs) || 600000,
        enabled: body.enabled !== false,
        lastRun: null,
      };
      manifest.jobs.push(job);
      saveManifest(manifest);
      syncPm2(job);
      return send(res, 201, { job });
    }

    const jobMatch = url.pathname.match(/^\/api\/jobs\/([^/]+)$/);
    if (jobMatch) {
      const id = decodeURIComponent(jobMatch[1]);
      const manifest = loadManifest();
      const idx = manifest.jobs.findIndex((j) => j.id === id);

      if (req.method === "PUT") {
        if (idx === -1) return send(res, 404, { error: "not found" });
        const body = await readBody(req);
        if (body.schedule && !isValidCron(body.schedule)) {
          return send(res, 400, { error: "schedule must be a 5-field cron expression" });
        }
        const job = manifest.jobs[idx];
        Object.assign(job, {
          name: body.name ?? job.name,
          model: body.model ?? job.model,
          description: body.description ?? job.description,
          schedule: body.schedule ?? job.schedule,
          cwd: body.cwd ?? job.cwd,
          prompt: body.prompt ?? job.prompt,
          context_files: Array.isArray(body.context_files)
            ? body.context_files
            : job.context_files,
          output: body.output ?? job.output,
          timeoutMs: body.timeoutMs ? Number(body.timeoutMs) : job.timeoutMs,
          enabled: body.enabled ?? job.enabled,
        });
        saveManifest(manifest);
        syncPm2(job);
        return send(res, 200, { job });
      }

      if (req.method === "DELETE") {
        if (idx === -1) return send(res, 404, { error: "not found" });
        manifest.jobs.splice(idx, 1);
        saveManifest(manifest);
        removePm2(id);
        return send(res, 204, "");
      }
    }

    const runMatch = url.pathname.match(/^\/api\/jobs\/([^/]+)\/run$/);
    if (runMatch && req.method === "POST") {
      const id = decodeURIComponent(runMatch[1]);
      const manifest = loadManifest();
      const job = manifest.jobs.find((j) => j.id === id);
      if (!job) return send(res, 404, { error: "not found" });
      const child = spawn(process.execPath, [RUNNER_PATH, id], {
        detached: true,
        stdio: "ignore",
      });
      child.unref();
      return send(res, 202, { started: true });
    }

    const logMatch = url.pathname.match(/^\/api\/jobs\/([^/]+)\/log$/);
    if (logMatch && req.method === "GET") {
      const id = decodeURIComponent(logMatch[1]);
      const manifest = loadManifest();
      const job = manifest.jobs.find((j) => j.id === id);
      if (!job || !job.lastRun || !job.lastRun.log) {
        return send(res, 200, { log: null });
      }
      const logPath = path.join(LOGS_DIR, job.lastRun.log);
      try {
        const content = fs.readFileSync(logPath, "utf8");
        return send(res, 200, { log: JSON.parse(content) });
      } catch (err) {
        return send(res, 200, { log: null, error: err.message });
      }
    }

    send(res, 404, { error: "not found" });
  } catch (err) {
    send(res, 500, { error: err.message });
  }
});

// Reconcile pm2 with manifest.json on boot, in case the file was hand-edited
// or pm2 lost state (a full pm2 kill / machine restart).
function reconcile() {
  const manifest = loadManifest();
  manifest.jobs.forEach((job) => syncPm2(job));
}

reconcile();
server.listen(PORT, () => {
  console.log(`ai-cron dashboard on http://localhost:${PORT}`);
});
