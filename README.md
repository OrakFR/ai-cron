# ai-cron

Scheduled `claude -p` jobs, run via [pm2](https://pm2.keymetrics.io/), with a dashboard
and a small watchdog that survives the pm2 daemon going down.

Built after a cron-automation tool dropped support for shelling out to an AI CLI on a
schedule (a deliberate, reasonable security call on their part - a "no API calls" tool
quietly calling out to one was a real trust gap). This replaces that one narrow feature
with something small, dependency-free, and easy to reason about.

## How it's laid out

- **`manifest.json`** - the list of jobs: schedule (5-field cron), prompt, context files
  to inline, where to write the output. Not committed (see Setup) - copy
  `manifest.example.json` to get started.
- **`runner.js`** - executes one job: inlines `context_files` into the prompt, calls
  `claude -p --restricted --output-format json`, writes the result per the job's
  `output.mode` (`none` / `append_log` / `overwrite_file`, the latter keeping a `.bak`),
  logs the full run to `logs/`.
- **`server.js`** - the dashboard (`:47890`, configurable via `AI_CRON_PORT`). View jobs,
  toggle enabled, run on demand, view logs, add/edit/delete. Keeps pm2 in sync with
  `manifest.json` (jobs are scheduled as `pm2 start ... --cron-restart "<schedule>"
  --no-autorestart` processes).
- **`watchdog.js`** - a second, always-on process (`:47891`, `AI_CRON_WATCHDOG_PORT`)
  that runs *outside* pm2 entirely. The dashboard is itself pm2-managed, so it can't be
  the thing that rescues itself when pm2 is down - the watchdog can. Serves a
  status/start page (`public/start.html`) and can `pm2 resurrect` on request, with a
  verified hard-kill fallback for stopping (pm2's own `pm2 kill` has a real bug where it
  can report success while the daemon silently hangs alive - see the comments in
  `watchdog.js` for the full trace through pm2's source).
- **`public/index.html`** - the dashboard UI. One page per AI provider (`/claude`,
  `/chatgpt`) sharing the same template, filtered by a `provider` field on each job.
  Only `claude` has an executor today; `runner.js` refuses any other provider with a
  clear error rather than silently trying to run it.
- **`public/start.html`** - served by the watchdog. Checks whether the dashboard is up;
  if not, shows a Start button; once it's back, redirects there automatically.

No external dependencies - everything runs on Node's built-in `http`/`fs`/`child_process`.

## Setup

1. **Copy the manifest**: `cp manifest.example.json manifest.json`, edit it to your
   actual jobs (or use the dashboard's Add Job form once it's running).

2. **Point the machine-specific paths at your own install.** `watchdog.js` hardcodes
   absolute paths to `node` and `pm2` (`NODE_BIN`, `PM2_BIN` near the top) because
   launchd gives its agent a minimal `PATH` that can't resolve them otherwise - edit
   those two constants for your machine. `server.js` and `runner.js` just use `pm2` /
   `claude` from `PATH` and don't need this.

3. **Run the dashboard under pm2**:
   ```bash
   pm2 start server.js --name ai-cron-dashboard
   pm2 save
   ```

4. **Run the watchdog independently of pm2**, via its own launchd agent (macOS) so it
   has real `KeepAlive` and survives a `pm2 kill`:
   ```bash
   cp com.ai-cron.watchdog.plist.example ~/Library/LaunchAgents/com.ai-cron.watchdog.plist
   # edit the paths and UserName inside it for your machine/user, then:
   launchctl load ~/Library/LaunchAgents/com.ai-cron.watchdog.plist
   ```
   On Linux, run `watchdog.js` under systemd (`Restart=always`) instead.

5. Open `http://localhost:47890` (redirects to `/claude`). Bookmark
   `http://localhost:47891` too - that one works even when the dashboard is down.

## Adding a provider's executor

`runner.js` currently only knows how to run `claude -p`. To wire up another provider:
add its key to `PROVIDERS` in `server.js` (`ready: true`), and branch on `job.provider`
in `runner.js`'s `run()` function to call that provider's CLI instead.

## License

MIT - see [LICENSE](LICENSE).
