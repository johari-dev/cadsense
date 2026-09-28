# Review on Onshape version creation

A named Onshape version is the designer's checkpoint, the CAD equivalent of
pushing a commit. `OnshapeVersionReviews.ts` checks opted-in projects for new
versions when asked and starts a review thread for each one.

## Setting

`OnshapeProjectSource.autoReviewVersions` (default off) is toggled from the
project settings page under "Review new Onshape versions". The client sends
`project.meta.update` with `onshapeAutoReviewVersions`; the decider rejects it
for projects without an Onshape binding.

## When checks happen

CADsense is a desktop app without a public endpoint, so it cannot receive
webhooks. It also does not poll: Onshape's annual API limit is 2,500 calls per
user on Free and Standard plans (5,000 Professional, 10,000 Enterprise; 402
once exceeded), and a 5 minute poll would spend about 105,000 per project per
year. A check only runs when a user signal asks for one:

- Turning the setting on checks right away to record the baseline.
- Opening the project. The web client's `ChatView` calls
  `useOnshapeVersionCheckOnOpen` with its active project, so showing any
  thread or draft of an enabled project, or reconnecting its environment,
  sends `onshape.projects.checkVersions` with reason `"opened"`. The hook is
  keyed on ids, so re-renders and thread switches inside the project do not
  send again.
- "Check now" on the project settings page sends reason `"manual"`.

`OnshapeVersionReviews.check` answers `skipped` with reason `disabled` when the
setting is off or the managed workspace is not ready, and makes no request.
`"opened"` checks run at most once per project per 15 minutes
(`OPENED_CHECK_INTERVAL_MS`, measured from the last check of any reason, kept
in memory). `"manual"` ignores that throttle but still answers `in-progress`
while another check or review for the project runs, and `backing-off` with the
retry time while the project is backing off. Nothing checks at server startup,
and `cadsense mcp` runs the same backend headless, so with no client opening
projects it makes no version list requests at all.

## API cost

A check is one `GET /documents/d/{did}/versions` through
`OnshapeConnections.readJson`, so it shares the connection's credentials, host
allow list, and 429 cooldown. When there are new versions, each one adds the
CAD sync described below for every synced root, the same requests the
settings page's sync makes. A check with nothing new costs exactly one call.

## Cursor

The newest version seen per project is stored in
`onshape_version_review_cursors` (migration 056). The first check after
enabling only records this baseline; pre-existing versions are not reviewed.
Turning the setting off deletes the cursor, so re-enabling baselines again
instead of reviewing the gap.

Versions newer than the cursor are handled oldest first. The check answers
`reviewing` with their ordinals and names as soon as the list is read, and the
reviews start in the background. The cursor advances after each review starts,
so a failure stops at that version and the next check retries it.

## Trigger

For each new version the check first refreshes the project's CAD snapshot,
then dispatches the same commands the client sends for a bootstrap turn:
`thread.create`, then `thread.turn.start`.

The refresh is the same `CadUserOperations.start({ kind: "sync" })` call the
settings page makes, run for each root the user has already synced. Snapshots
are bound to the project's Onshape source and cannot be pinned to a version, so
the sync targets the bound workspace. The review waits for the operation's
`project.cad-state-set` outcome event (up to 30 minutes) before starting the
turn. The prompt then states what the CAD panel shows: the fresh snapshot's
microversion, a note when the workspace has moved past the version's
microversion, a failure reason when the download failed or was refused, or that
no root has been synced yet. A review always starts; a failed sync never blocks
it.

The CAD lifecycle refuses a sync while any agent run is active in the project,
including an earlier version review that is still running. Those reviews start
with the older snapshot and say so.

The thread id is derived from the project and version ids, so a retry reuses the thread
instead of creating a second one. The title is `Review v<ordinal>: <name>`,
where the ordinal is the version's position in the document history (the
initial "Start" version is v0). The prompt names the version, its creation time,
creator, note, and link, and asks the agent to review that version and leave CAD
comments. The turn uses the project's default model, falling back to the server
default.

## Failure handling

Onshape errors, decode failures, and rejected commands are logged and never
crash the server. A failed project backs off in memory: `Retry-After` from a
rate limit when present, otherwise 5 minutes doubling up to an hour. The check
that failed answers `failed` with the retry time. Restarting clears the backoff
and the throttle and keeps the durable cursor. Overlapping checks for one
project are skipped.

## Limitations

The snapshot is the bound workspace at check time, not the version itself. If
the workspace was edited after the version was created, the review sees the
newer geometry; the prompt flags this when the microversions differ. Projects
without a synced root get a review thread but no CAD panel content until a
root is synced in project settings.
