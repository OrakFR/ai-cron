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

// Preferred path for a ChatGPT job: the Codex CLI's own `codex login` (OAuth,
// browser-based) bills against the user's ChatGPT Plus/Team/Enterprise plan
// entitlement, not a separate API key - the only option for someone on a
// company seat with API-key issuance locked down. Credentials live in
// ~/.codex/auth.json and Codex refreshes them itself; nothing here touches
// that file. `codex exec --json` streams JSON Lines events; the pieces used
// here: `item.completed` / item.type "agent_message" for the reply text,
// `turn.completed` for token usage, `turn.failed` for errors.
// https://learn.chatgpt.com/docs/auth?surface=app / https://learn.chatgpt.com/codex/non-interactive-mode
function callChatGPTViaCodex(job, prompt) {
  const args = ["exec", "--json", "--sandbox", "read-only", "--skip-git-repo-check"];
  if (job.model) args.push("--model", job.model);
  args.push("--", prompt);
  const proc = spawnSync("codex", args, {
    cwd: job.cwd,
    timeout: job.timeoutMs || 600000,
    maxBuffer: 50 * 1024 * 1024,
    encoding: "utf8",
  });
  if (proc.error) return proc; // ENOENT (codex not installed) decides fallback in callChatGPT

  let resultText = "";
  let usage;
  let failMsg = null;
  for (const line of (proc.stdout || "").split("\n")) {
    if (!line.trim()) continue;
    let evt;
    try {
      evt = JSON.parse(line);
    } catch {
      continue;
    }
    if (evt.type === "item.completed" && evt.item?.type === "agent_message" && evt.item.text) {
      resultText = evt.item.text;
    } else if (evt.type === "turn.completed" && evt.usage) {
      usage = {
        input_tokens: evt.usage.input_tokens,
        output_tokens: evt.usage.output_tokens,
        cache_read_input_tokens: evt.usage.cached_input_tokens || 0,
      };
    } else if (evt.type === "turn.failed" || evt.type === "error") {
      failMsg = evt.error || evt.message || JSON.stringify(evt);
    }
  }

  const isError = proc.status !== 0 || !!failMsg || !resultText;
  const synthetic = {
    result: isError ? failMsg || proc.stderr || `codex exec exited with status ${proc.status}` : resultText,
    total_cost_usd: null,
    usage,
    is_error: isError,
  };
  return { error: null, stdout: JSON.stringify(synthetic), stderr: proc.stderr };
}

// Fallback for anyone who does have API key access (or prefers pay-per-token
// billing over their ChatGPT plan). Tried only when the Codex CLI itself
// isn't installed - if it IS installed but errors (not logged in, etc.),
// that error is surfaced directly rather than silently swallowed here.
async function callChatGPTViaApiKey(job, prompt) {
  const apiKey = process.env.OPENAI_API_KEY;
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

async function callChatGPT(job, prompt) {
  const codexResult = callChatGPTViaCodex(job, prompt);
  const codexNotInstalled = codexResult.error && codexResult.error.code === "ENOENT";
  if (!codexNotInstalled) return codexResult;

  if (process.env.OPENAI_API_KEY) {
    return callChatGPTViaApiKey(job, prompt);
  }
  return {
    error: new Error(
      "No ChatGPT auth available: install the Codex CLI and run `codex login` " +
        "(uses your ChatGPT plan, no API key needed - the right option on a " +
        "company seat that can't issue API keys), or set OPENAI_API_KEY."
    ),
    stdout: "",
    stderr: "",
  };
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
