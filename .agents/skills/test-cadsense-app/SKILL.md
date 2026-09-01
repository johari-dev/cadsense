---
name: test-cadsense-app
description: Launch, retain, and test the cadsense desktop renderer against an isolated local development backend, with worktree-safe state, controlled browser verification, optional SQLite fixtures, and safe process lifecycle handling.
---

# Test cadsense App

Use this skill for an integrated check of the desktop app's React renderer and local server.

## Start an isolated environment

1. Run commands from the repository root.
2. Choose a base directory that belongs only to the current worktree or test:
   - use the repository's ignored `.cadsense` directory for reusable worktree-local state;
   - use a newly created temporary directory for disposable verification and retain its absolute path.
3. Start the full local stack with `vp run dev`. Pass `--home-dir <base-dir>` when using a
   dedicated state directory.
4. Start it as a tracked background process, retain its PID, and redirect stdout and stderr to files
   owned by this test. On Windows, use `Start-Process -WindowStyle Hidden`.
5. Read the selected server port, renderer port, and base directory from the current
   `[dev-runner]` output before navigating.

Never start a test server against the shared `~/.cadsense/userdata` directory. Treat a directory as
disposable only when it was created or deliberately selected for this test.

The worktree-local default deliberately outranks an ambient `CADSENSE_HOME`; do not pass shared state
through to a worktree dev server. Ports derive from the worktree path but can move when occupied, so
never assume the defaults.

Development is single-origin: Vite proxies `/api` and `/ws`. Never set `VITE_HTTP_URL` or
`VITE_WS_URL`, and do not ask a system browser to open automatically during automated testing.

## Verify with the controlled browser

Use the cadsense in-app browser automation surface. Open the renderer URL printed by the current dev
runner, wait for the initial synchronization to finish, and keep using that browser context for the
whole verification loop.

Prefer semantic snapshots and locators. Verify observable behavior rather than component internals.
For UI reductions, check both that the retained action works and that removed navigation, settings,
and commands are absent.

## Preserve the environment while iterating

Treat the complete testing or implementation loop as the environment lifecycle boundary.

- Reuse a healthy dev process, state directory, ports, and browser tab across verification passes.
- Do not start a second environment when the current one still serves the task.
- On a later turn, verify the tracked process is alive before reusing it.
- Keep the environment only when the user may inspect it or request a follow-up; otherwise tear it
  down after the task is genuinely complete.

## Inspect or seed SQLite state

Read [references/sqlite-fixtures.md](references/sqlite-fixtures.md) before changing the database.

- Use `node apps/server/scripts/cadsense-sqlite-state.ts query` for schema discovery and read-only checks.
- Stop the tracked dev process before using `node apps/server/scripts/cadsense-sqlite-state.ts exec`, then
  restart it with the same base directory.
- Seed projection tables only for disposable UI fixtures. Use application commands and APIs when
  testing business behavior or projection correctness.

The helper refuses to write to shared user state by default and creates a database backup before
each mutation.

## Tear down safely

When the verification loop is finished:

1. Stop only the PID captured when this test process was started.
2. Confirm the process exited.
3. Preserve the isolated state directory when it contains useful reproduction evidence.
4. Otherwise remove only a directory created for this test, after resolving its absolute path and
   verifying that it is the intended test directory inside the workspace or system temporary root.

Never kill by process-name, command-line pattern, or workspace-path match.

## Troubleshoot predictably

- If the renderer cannot synchronize, inspect the current server and renderer logs before retrying.
- If the UI shows unexpected data, confirm every command uses the same explicit base directory.
- If ports move because another instance is running, trust the current dev-runner output.
- If a provider is unavailable, verify provider-independent navigation and settings first; provider
  sessions require the corresponding CLI to be installed and authenticated.
