# Cadsense MCP

`cadsense mcp` lets an agent that Cadsense did not launch review Onshape CAD. It is a stdio MCP
server that needs no window: Claude Code, Codex, or any other MCP client can open an Onshape tab,
inspect it, and leave the same verified comments the desktop app shows.

## Set up

You need Node 24, a checkout with dependencies installed, the web app built
(`pnpm --filter @cadsense/web build`), and an Onshape API key from
<https://dev-portal.onshape.com/keys> that can read documents. The first capture downloads Playwright's
headless Chromium (about 110 MB) unless `CADSENSE_CHROMIUM_PATH` points at a Chromium binary.

Claude Code:

```sh
claude mcp add cadsense \
  -e ONSHAPE_ACCESS_KEY=... -e ONSHAPE_SECRET_KEY=... \
  -- node /path/to/cadsense/apps/server/src/bin.ts mcp
```

Codex, in `~/.codex/config.toml`. `default_tools_approval_mode` matters for `codex exec`, which
otherwise rejects every tool not marked read-only:

```toml
[mcp_servers.cadsense]
command = "node"
args = ["/path/to/cadsense/apps/server/src/bin.ts", "mcp"]
env = { ONSHAPE_ACCESS_KEY = "...", ONSHAPE_SECRET_KEY = "..." }
default_tools_approval_mode = "approve"
```

Then ask for a review with the Onshape tab URL. Unattended runs work the same way:
`claude -p "Review my intake: <url>" --allowedTools mcp__cadsense` or `codex exec "..."`.

## How it works

- The process is the MCP session. It runs the regular backend on a random loopback port, locked with
  a per-process credential, with its own data directory: `~/.cadsense-mcp`, `CADSENSE_MCP_HOME`, or
  `--base-dir`. Do not point it at the desktop app's directory while the app is running.
- `initialize` and `tools/list` are answered before the backend module graph loads, so a slow machine
  does not trip Codex's 10 second startup limit. Tool calls wait for the backend.
- `cad_open` verifies the key once per host and process as the connection `Cadsense MCP`, reuses the
  project for that Onshape source, and runs discover and sync. An unchanged sync costs one Onshape
  request. It returns `importing` after 45 seconds so clients with a 60 second tool limit can call
  again. Each opened review is a new chat with a synthetic turn ID (`mcp-<uuid>`), which scopes the CAD
  activation, captures, and comments like a provider turn.
- A microversion URL (`/m/`) names CAD that cannot change. When the data directory already holds that
  microversion of the element, `cad_open` opens it with no Onshape requests at all: no key
  verification and no sync.
- The other tools are the provider CAD tools, unchanged, with the same schemas and descriptions.
  The review guidance comes back in the `cad_open` result because clients handle MCP `instructions`
  differently.
- Headless Chromium loads the web build's `render-host.html`. This process reads the render broker's
  stream and passes each event into the page, which fetches jobs and uploads PNGs over the ticketed
  `/api/cad-render` routes. It starts on the first `cad_open` and restarts after a crash.
- After each publication the review is written to `reports/<chat id>/` in the data directory:
  `index.html`, `comments.json`, and the numbered inspection image for each verified location.

## Limits

- One review is open at a time. Opening another URL ends the previous activation; its comments and
  report stay on disk.
- Subagents in one client share the review's view, so parallel view changes can hit revision
  conflicts.
- Without a GPU, Chromium renders with SwiftShader. On a 577-part assembly that took about 1.6 s per
  capture.
- Connection verification lists documents, so a key that can only open specific documents is
  rejected.
- The `cad_checks` draft backstop runs when a review closes, which over MCP means when the client
  ends the session. Codex and Claude Code usually kill the server right after closing its stdin, so
  the backstop may not finish publishing. In the app it runs at every turn end.
- It is not published to npm yet. Run it from a checkout.

## Verify

`apps/server/scripts/cad-mcp-review-e2e.ts` runs Claude Code or Codex against a fresh data directory
and keeps the transcript, the final message, the MCP log, the report, and a summary of tool calls.
The script starts the MCP server itself and gives the agent a relay to it, so the server still
closes the review in order after the agent exits, as an app turn would. `--seed-home <dir>` starts
from a copy of an earlier run's data directory; with a microversion URL it holds, runs make no
Onshape requests. `--follow-up` resumes the agent once if it exits with `cad_checks` drafts still
pending (the server logs `CAD drafts pending`). The app sends that follow-up itself, inside the
turn (see "The follow-up" in [CadChecks.md](../cad/CadChecks.md)); over MCP the server cannot start
a turn, so only the harness does.

`apps/server/scripts/cad-app-review-e2e.ts` runs a review through the app's own turn handling
instead: the orchestration engine, the Codex or Claude adapter, and their CAD tools, on a copy of a
data directory that holds a synced project, with headless Chromium rendering. Use it for behavior
only the app has, such as the follow-up. It keeps the server log, the chat's messages and
activities, the report, and a summary with follow-ups and backstop comments.

`apps/server/scripts/cad-mcp-replay.ts` replays a recorded run's tool calls against the current
server with no model, mapping capture, candidate, and snapshot IDs, and reports how every
`cad_comment_locate` and `cad_comment_inspect` call turns out now. Use it to check a locate or
inspection change on the exact views and pixels an agent used.

```sh
ONSHAPE_CREDENTIAL_FILE=key.json node apps/server/scripts/cad-mcp-review-e2e.ts \
  --agent claude --url <onshape tab url> --prompt-file prompt.md --out .cadsense/mcp-e2e/run
```

Use the prompts in [the review evaluation](../cad/CadReviewEvaluation.md) and judge the results the
same way. A finished run proves the tools work end to end, not that the review is good.

## Recorded check: September 27, 2026

First prompt from the review evaluation plus the URL of Assembly 1 (577 components, document
`e5fd6dd412a8653a52ad3252`), a fresh data directory per run, and no follow-up. The machine was a WSL
host with no GPU access, so Chromium used SwiftShader, and other work kept its load average above
200 on 32 cores.

| Agent               | Model                | Time   | Tool calls                                          | Comments               |
| ------------------- | -------------------- | ------ | --------------------------------------------------- | ---------------------- |
| Claude Code 2.1.283 | claude-opus-5-5      | 42 min | 53. Two captures timed out and were retried.        | 3, all verified points |
| Codex 0.157.1       | gpt-5.6-luna, medium | 2 min  | 12. One invalid view update, one rejected new item. | 1, whole part          |

Both found that the printed motor support touches only the motor cans. Claude asked for the arm's
rotation range and the pivot plate load case instead of proposing cutouts. Codex's summary read more
like a generic checklist. The Claude run's time reflects the machine: the same captures took about
1.6 s each before the load rose, and two hit the broker's 90 second limit.
