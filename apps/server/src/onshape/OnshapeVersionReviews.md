# Review on Onshape version creation

A named Onshape version is the designer's checkpoint, the CAD equivalent of
pushing a commit. `OnshapeVersionReviews.ts` watches for new versions on
opted-in projects and starts a review thread for each one.

## Setting

`OnshapeProjectSource.autoReviewVersions` (default off) is toggled from the
project settings page under "Review new Onshape versions". The client sends
`project.meta.update` with `onshapeAutoReviewVersions`; the decider rejects it
for projects without an Onshape binding.

## Polling

CADsense is a desktop app without a public endpoint, so the server polls
instead of receiving webhooks.

- Every enabled project with a ready managed workspace is polled at startup and
  then every 5 minutes with jitter. Turning the setting on polls that project
  right away.
- Each poll is one `GET /documents/d/{did}/versions` through
  `OnshapeConnections.readJson`, so it shares the connection's credentials,
  host allow list, and 429 cooldown.
- The newest version seen per project is stored in
  `onshape_version_review_cursors` (migration 054). The first poll after
  enabling only records this baseline; pre-existing versions are not reviewed.
  Turning the setting off deletes the cursor, so re-enabling baselines again
  instead of reviewing the gap.
- Versions newer than the cursor are handled oldest first. The cursor advances
  after each review starts, so a failure stops at that version and the next
  poll retries it.

## Trigger

For each new version the poller first refreshes the project's CAD snapshot,
then dispatches the same commands the client sends for a bootstrap turn:
`thread.create`, then `thread.turn.start`.

The refresh is the same `CadUserOperations.start({ kind: "sync" })` call the
settings page makes, run for each root the user has already synced. Snapshots
are bound to the project's Onshape source and cannot be pinned to a version, so
the sync targets the bound workspace. The poller waits for the operation's
`project.cad-state-set` outcome event (up to 30 minutes) before starting the
turn. The prompt then states what the CAD panel shows: the fresh snapshot's
microversion, a note when the workspace has moved past the version's
microversion, a failure reason when the download failed or was refused, or that
no root has been synced yet. A review always starts; a failed sync never blocks
it.

The CAD lifecycle refuses a sync while any agent run is active in the project,
including an earlier version review that is still running. Those reviews start
with the older snapshot and say so.

The thread id
is derived from the project and version ids, so a retry reuses the thread
instead of creating a second one. The title is `Review v<ordinal>: <name>`,
where the ordinal is the version's position in the document history (the
initial "Start" version is v0). The prompt names the version, its creation time,
creator, note, and link, and asks the agent to review that version and leave CAD
comments. The turn uses the project's default model, falling back to the server
default.

## Failure handling

Onshape errors, decode failures, and rejected commands are logged and never
crash the server. A failed project backs off in memory: `Retry-After` from a
rate limit when present, otherwise 5 minutes doubling up to an hour. Restarting
clears the backoff and keeps the durable cursor. Overlapping polls for one
project are skipped.

## Limitations

The snapshot is the bound workspace at poll time, not the version itself. If
the workspace was edited after the version was created, the review sees the
newer geometry; the prompt flags this when the microversions differ. Projects
without a synced root get a review thread but no CAD panel content until a
root is synced in project settings.
