#!/usr/bin/env node
// Runs one job from manifest.json through `claude -p`, no tool access needed -
// context files are inlined into the prompt, so --restricted is safe.
"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const MANIFEST_PATH = path.join(__dirname, "manifest.json");
const LOGS_DIR = path.join(__dirname, "logs");

function loadManifest() {
  return JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
}

function saveManifest(manifest) {
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + "\n");
}

function buildPrompt(job) {
  const blocks = (job.context_files || []).map((rel) => {
    const abs = path.join(job.cwd, rel);
    let content;
    try {
      content = fs.readFileSync(abs, "utf8");
    } catch (err) {
      content = `[could not read ${rel}: ${err.message}]`;
    }
    return `--- context file: ${rel} ---\n${content}`;
  });
  return [...blocks, "--- task ---", job.prompt].join("\n\n");
}

function writeOutput(job, resultText) {
  const out = job.output || { mode: "none" };
  if (out.mode === "none" || !out.path) return;
  const abs = path.join(job.cwd, out.path);
  if (out.mode === "overwrite_file") {
    if (fs.existsSync(abs)) {
      fs.copyFileSync(abs, abs + ".bak");
    }
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, resultText);
  } else if (out.mode === "append_log") {
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    const stamp = new Date().toISOString();
    const entry = `\n## ${stamp} - ${job.name}\n\n${resultText}\n`;
    fs.appendFileSync(abs, entry);
  }
}

function run(jobId) {
  const manifest = loadManifest();
  const job = manifest.jobs.find((j) => j.id === jobId);
  if (!job) {
    console.error(`unknown job id: ${jobId}`);
    process.exit(1);
  }
  if (!job.enabled) {
    console.error(`job ${jobId} is disabled, skipping`);
    process.exit(0);
  }
  if (job.provider && job.provider !== "claude") {
    console.error(`provider "${job.provider}" is not implemented yet (job ${jobId})`);
    process.exit(1);
  }

  const prompt = buildPrompt(job);
  const startedAt = new Date();

  const proc = spawnSync(
    "claude",
    ["-p", "--restricted", "--output-format", "json", "--", prompt],
    {
      cwd: job.cwd,
      timeout: job.timeoutMs || 600000,
      maxBuffer: 50 * 1024 * 1024,
      encoding: "utf8",
    }
  );

  const durationMs = Date.now() - startedAt.getTime();
  fs.mkdirSync(LOGS_DIR, { recursive: true });
  const logPath = path.join(
    LOGS_DIR,
    `${jobId}-${startedAt.toISOString().replace(/[:.]/g, "-")}.log`
  );

  let parsed = null;
  let status = "failed";
  let errorMsg = null;
  let resultText = "";
  let costUsd = null;

  if (proc.error) {
    errorMsg = proc.error.message;
  } else {
    try {
      parsed = JSON.parse(proc.stdout);
      resultText = parsed.result || "";
      costUsd = parsed.total_cost_usd ?? null;
      if (parsed.is_error) {
        errorMsg = resultText || "claude reported is_error";
      } else {
        status = "success";
      }
    } catch (err) {
      errorMsg = `could not parse claude output: ${err.message}`;
    }
  }

  fs.writeFileSync(
    logPath,
    JSON.stringify(
      {
        jobId,
        startedAt: startedAt.toISOString(),
        durationMs,
        status,
        errorMsg,
        stdout: proc.stdout,
        stderr: proc.stderr,
      },
      null,
      2
    )
  );

  if (status === "success") {
    try {
      writeOutput(job, resultText);
    } catch (err) {
      status = "failed";
      errorMsg = `run succeeded but writeOutput failed: ${err.message}`;
    }
  }

  const fresh = loadManifest();
  const freshJob = fresh.jobs.find((j) => j.id === jobId);
  if (freshJob) {
    freshJob.lastRun = {
      timestamp: startedAt.toISOString(),
      status,
      durationMs,
      costUsd,
      error: errorMsg,
      log: path.basename(logPath),
    };
    saveManifest(fresh);
  }

  if (status !== "success") {
    console.error(`job ${jobId} failed: ${errorMsg}`);
    process.exit(1);
  }
  console.log(`job ${jobId} succeeded in ${durationMs}ms`);
}

const jobId = process.argv[2];
if (!jobId) {
  console.error("usage: node runner.js <job-id>");
  process.exit(1);
}
run(jobId);
