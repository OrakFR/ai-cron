#!/usr/bin/env node
// Runs one job from manifest.json through its provider (claude or chatgpt).
// No tool access needed either way - context files are inlined into the
// prompt text itself, so claude's --restricted is safe and chatgpt just gets
// a plain chat-completion call.
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

// Both callers return the same shape spawnSync would: {error, stdout, stderr}.
// stdout is a JSON string with {result, total_cost_usd, usage, is_error} so
// everything below (parsing, logging, the dashboard's log viewer) stays the
// same regardless of provider.
function callClaude(job, prompt) {
  const args = ["-p", "--restricted", "--output-format", "json"];
  if (job.model) args.push("--model", job.model);
  args.push("--", prompt);
  return spawnSync(
    "claude",
    args,
    {
      cwd: job.cwd,
      timeout: job.timeoutMs || 600000,
      maxBuffer: 50 * 1024 * 1024,
      encoding: "utf8",
    }
  );
}

async function callChatGPT(job, prompt) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return { error: new Error("OPENAI_API_KEY is not set in the environment"), stdout: "", stderr: "" };
  }
  const model = job.model || "gpt-4o-mini";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), job.timeoutMs || 600000);
  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, messages: [{ role: "user", content: prompt }] }),
      signal: controller.signal,
    });
    const bodyText = await res.text();
    if (!res.ok) {
      return { error: null, stdout: "", stderr: `OpenAI API returned ${res.status}: ${bodyText}` };
    }
    const data = JSON.parse(bodyText);
    const synthetic = {
      result: data.choices?.[0]?.message?.content || "",
      // OpenAI's response doesn't include a cost figure the way claude's
      // print-mode output does - left null rather than guessed from a
      // hardcoded, easily-stale per-model price table.
      total_cost_usd: null,
      usage: data.usage
        ? {
            input_tokens: data.usage.prompt_tokens,
            output_tokens: data.usage.completion_tokens,
            cache_read_input_tokens: 0,
          }
        : undefined,
      is_error: false,
      openai_response: data,
    };
    return { error: null, stdout: JSON.stringify(synthetic), stderr: "" };
  } catch (err) {
    return { error: err, stdout: "", stderr: "" };
  } finally {
    clearTimeout(timer);
  }
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

const EXECUTORS = { claude: callClaude, chatgpt: callChatGPT };

async function run(jobId) {
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
  const executor = EXECUTORS[job.provider || "claude"];
  if (!executor) {
    console.error(`provider "${job.provider}" is not implemented yet (job ${jobId})`);
    process.exit(1);
  }

  const prompt = buildPrompt(job);
  const startedAt = new Date();

  const proc = await executor(job, prompt);

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
        errorMsg = resultText || "provider reported is_error";
      } else {
        status = "success";
      }
    } catch (err) {
      errorMsg = `could not parse provider output: ${err.message}`;
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
run(jobId).catch((err) => {
  console.error(`job ${jobId} crashed: ${err.stack || err.message}`);
  process.exit(1);
});
