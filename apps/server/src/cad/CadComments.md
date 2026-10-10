# CAD comments

Agent findings belong to the originating chat and the exact downloaded CAD they describe. Missing screws are an example; deciding whether an empty hole requires a screw is outside this feature.

## Agent workflow

`CadReviewInstructions.ts` supplies shared review guidance to Codex and Claude sessions with CAD tools. `cadReviewInstructions({ learnings, designBrief })` appends the [project design brief](CadDesignBrief.md) when the workspace has one, then the project's review learnings under one heading, one line per learning; empty sections are omitted, so with neither the shared text is delivered alone. Codex reads the brief and learnings at every turn start; Claude reads them when its session starts because the SDK system prompt is fixed per session. `CadProviderTools.ts` reinforces the guidance with a publication check in `cad_comments_publish`. When changing that guidance, use [the review evaluation](CadReviewEvaluation.md) to assess comment wording, evidence, and placement with ordinary user prompts.

1. `cad_comments_list` reads existing findings, including reviewed findings, and returns the creation catalog version. Walk `nextCursor` before deciding an issue is new. A changed creation catalog invalidates a cursor; review changes do not advance that catalog.
2. Capture the private view with the existing `cad_capture` tool. `cad_comment_locate` takes that capture ID and explicit intended occurrence IDs with original 1280 ? 960 image coordinates (top-left origin, continuous pixels). The nearest visible surface wins. An intervening part returns `occurrence-mismatch`; the ray never searches through it for the intended part. When the exact pixel misses, locate tries nearby pixels (see below).
3. `cad_comment_inspect` returns numbered candidate markers from a different camera angle. Yellow candidates are visible; red candidates cannot be confirmed. The agent must verify the actual surface/depth, then cite the inspection and explain its confirmation when publishing. A same-part inner wall can still be the wrong location. If the exact location is uncertain, publish a whole-part target with `preciseLocationLimitation`.
4. `cad_comments_publish` takes `expectedCatalogVersion` and up to 20 complete items. New items contain `publicationKey`, `inspectedSnapshotId`, title, body, `severity`, `category`, and 1?20 targets. Severity (`blocker`, `concern`, `question`, `nit`) rates the consequence to the mechanism; category (`interference`, `access`, `assembly`, `wiring`, `structure`, `manufacturing`, `other`) names the lifecycle stage. Both are required; a missing or misspelled value rejects that item with `invalid-input` details naming the field. Point targets cite candidate/inspection IDs; whole-part targets cite explicit occurrence IDs. Every target must pass before its comment appears. Valid items and their receipts commit together; invalid items return individual errors.
5. Reuse a prior finding with `kind: "reuse"`, a new publication key, the inspected snapshot, and `reuseCommentId`. Reuse preserves review state, severity, and category. Material new evidence can be a new finding linked with `correction` or `follow-up`, an existing same-chat/root comment ID, and an explanation. Neither link closes the original.
6. On a later review, `cad_comments_list` shows `outdated` on open comments whose targets changed in the current model. Propose resolution with `kind: "propose-resolve"`, a publication key, the inspected snapshot, `commentId`, and an `explanation` citing the new geometry. The proposal is stored on the comment and shown to the user beside Resolve; review state does not change. Proposals are rejected with `comment-unavailable` (another chat or unknown), `comment-not-open`, or `snapshot-not-newer` (inspected snapshot not created after the comment's snapshot, or another root).

Each publish call that creates comments, proposes resolutions, or rejects items appends a `cad.comments.published` thread activity with the new comments' numbers, titles, severity, category, and first locations, proposed comments, plus any rejected items. Chat merges a turn's activities into one comments row that stays visible when the turn folds. Replays add nothing.

Retry identical publications with the same keys. Receipts are checked before transient candidate handles, so a lost response can be retried after activation ends. Changing a successful key's payload conflicts. Responses include the current review state, placement, original event sequence, and current creation catalog version.

Malformed input returns `invalid-input` with `details` identifying invalid or missing fields. Publication items and location picks also include a compact expected shape so resumed provider sessions can recover without guessing field names. A successful tool transport response can contain rejected items: agents must check each result, correct rejected inputs, and retry. Rejected items create no comments or receipts.

## Helping smaller models place points

Smaller models rarely place point targets. GPT-6-Luna called `cad_comment_locate` in 5 of 64
evaluated reviews; its pixel picks missed (`transparent-hit` on a translucent game piece,
`no-hit` beside a thin belt, `occurrence-mismatch` on the neighboring gear) and it gave up after
one to three tries. Three mechanisms lower that cost. Each can fail in the ways listed under it.

**Nearby snapping.** When a pick misses, `locateCadCommentPoints` looks outward up to 64 pixels
for the nearest pixel whose first visible surface is the intended part and is opaque, and returns
that candidate with the `pixel` it used. It never searches through a nearer part.

- A miss with the intended part visible nearby is not recovered.
- It snaps to a pixel where the intended part is behind another part or a translucent surface.
- It snaps beyond the radius, or onto a part other than the intended one.
- It moves a pick that already hit the intended part.
- It does not report the pixel it used, so the agent cannot tell its pick moved.
- It raycasts the whole assembly at every pixel in the search and stalls a large model.

**Check-placed points.** For defects whose position the checks prove (a rotating part running into
another part, gears set too close, the bare end of a belt), `cad_checks` computes a surface point:
for overlapping parts, a point on the seam where one surface enters the other, nearest the
overlap's middle. `CadProviderTools` registers it as a candidate through the comment activation's
internal `cad_comment_place` operation (agents cannot call it), inspects it in a view that shows only
the parts involved, and offers the draft with a point target and the inspection image attached to
the `cad_checks` result. The agent still looks at the image before publishing; the turn-end backstop
publishes the whole-part version, so no point reaches the student unless an agent saw it.

- The seam point lies inside one of the solids, so the inspection reports it hidden.
- The point is stored in world coordinates instead of the part's own, so the marker lands elsewhere.
- A collision draft is made for an intended fit: a gear on its shaft, a shaft in its bearing or spacer, a belt on its pulley, two meshing gears, a game piece, a fastener, or two parts inside one vendor subassembly.
- A point that the inspection shows occluded is still offered as a point target.
- Placement or its render fails, and `cad_checks` fails instead of keeping whole-part targets.
- Each `cad_checks` call in a turn renders every marker again; agents such as Opus call it several times. A turn reuses its placements by draft key, which names the snapshot, so a newer model is placed again.
- A struggling renderer makes every placement wait out its render, so `cad_checks` takes minutes. After the first render failure no more placements are tried; a failure about one draft, such as a missing part, does not stop the rest.
- The backstop publishes a check-placed point.
- A published check-placed point stops counting as covering its draft.
- An image is attached to the wrong draft.
- Two spinning parts running into the same part become two comments, which read as one problem twice.
- A merged draft keeps only one of its markers.
- A merged draft with more than 20 markers cannot be published.

**Short publishing.** `cad_comments_publish` accepts `publishDrafts: [publicationKey]` to publish
drafts as offered, and fills `expectedCatalogVersion` when only drafts are published. While drafts
remain unpublished and undeclined, every other CAD tool result carries `pendingDrafts`.

- An unknown key is ignored instead of reported.
- A declined draft is published by key.
- A draft named in `publishDrafts` and also sent as an item is published twice.
- Reading a later page of `cad_checks` findings, which carries no drafts, forgets the offered drafts, so
  every key comes back `unknown-draft`.
- `pendingDrafts` still appears after every draft is covered or declined.
- `pendingDrafts` appears for a child agent that never ran `cad_checks`.

## Persistence and ownership

`cadComments.ts` defines the schemas. Comments and chat cards stored before severity and category existed decode both as `null`; migration 054 writes explicit nulls into those records so every stored comment has the same shape. The comments service validates ownership, candidates, images, geometry, and model equivalence. Internal orchestration commands serialize publication and review; the existing CAD projection transaction writes comments and receipts. Only the user-facing review RPC can resolve, dismiss, or reopen a published finding, using an expected review version and idempotent command ID. Published text and targets are immutable. `outdated` and `proposal` are projection state beside review state: a review clears the proposal, and records written before these fields decode as null.

A review may carry a trimmed reason of up to 500 characters. The reason is part of the review payload hash, is stored on the comment as `reviewReason`, and the next review replaces or clears it. A dismissal with a reason also emits a project-level `project.cad-review-learning-added` event whose learning ID is the review command ID, so a replayed command cannot teach the project twice. Resolve accepts a reason without creating a learning. Learnings live in `projection_cad_review_learnings`; each project keeps its newest 50 and drops older ones. The project settings page watches `cad.reviewLearnings.watch` and removes entries through `cad.reviewLearning.remove`, which the decider rejects for unknown learnings or inactive projects. Learnings outlive their source chat.

## Outdated findings

When a snapshot becomes current for a root (`project.cad-state-set`), the comments service compares every open comment on that root between the comment's snapshot and the current one (`CadCommentOutdated.ts`). The comparison uses `cad_diff`'s rules (`CadDiff.md`), so a comment is outdated exactly when `cad_diff` between those snapshots reports a change to its target, and the service computes one diff per snapshot pair for all comments on it. Each target's occurrence is matched by occurrence path, so repeated instances are checked individually. A missing, suppressed, or geometry-less instance is `removed`. A target `cad_diff` reports as `geometry-changed` is `geometry-changed`; a resync that rekeys an untouched part exports the same bytes and is not a change. A target is `moved` when `cad_diff` reports it or any ancestor subassembly moved relative to its parent by more than the diff's epsilon, so reimport noise is not a move and a comment on a part inside a moved subassembly is outdated. The most severe reason across targets wins, and unchanged targets leave the comment current, including after a rollback restores the original placement. A comment published against an older snapshot while a newer one is current is checked when it commits.

The service dispatches `thread.cad.comments.outdate` per chat with the recomputed reasons; the decider requires the snapshot to be current for the comment's root and emits `thread.cad-comments-outdated` only for annotations that change. Startup repeats the comparison for every root so a restart between sync and annotation loses nothing. Reviewed findings are not re-checked. The card shows an "Outdated" line with the reason; the agent instructions ask for re-verification of outdated comments before proposing resolution or a follow-up.

Points are stored in source-part local meters after inverting the full captured occurrence transform, including explosion. `comment-model-v1` compares canonical source microversion/configuration, dependencies, nodes/transforms, part references, and asset hashes. Import UUIDs and timestamps do not determine equivalence. The same verified model can reuse comments after reimport.

Each activation pins inspected geometry through validation and an uninterruptible publication dispatch. The production snapshot store rechecks live SQL comment references under its deletion mutex. Thus an obsolete deletion list cannot remove a snapshot after its first comment commits. Deletion does not hold that mutex while waiting on the command queue; the pure decider never accesses the store. Current/rollback retention continues independently. Reviewed findings retain their CAD too; deleted chats/projects release their ownership.

Successful precise comments retain numbered PNG evidence and reconstruction metadata under `cad/comment-evidence/<hashed-chat-id>`. Activation cleanup removes unused inspection artifacts after checking durable references. Deleted-chat/project events remove that chat's evidence directory. Candidates expire with their activation; restart requires a new locate/inspect sequence unless replaying a successful publication receipt.

After projection recovery, startup cleanup removes orphaned evidence while preserving durable references and active inspections. Deletion cancels outstanding inspection deliveries; activation ownership includes the chat creation event so a recreated chat cannot use an earlier activation. Recreating a chat clears its previous comment catalog and receipts. Archived chats retain access.

Inspection searches nearby alternate directions (5, 10, and 20 degrees around the captured viewing direction) before broad assembly angles. Narrow bores may be visible from nearby directions while every broad angle is blocked by their walls. The captured direction itself is excluded; the agent must still visually verify the numbered alternate image. Camera up remains independent of the viewing direction, and generated poses are validated before rendering.

Inspection preserves the captured effective scene, including other visible components, when checking occlusion. Re-inspecting a candidate does not revoke previously verified evidence. Whole-part publication rejects suppressed or geometry-less occurrences.

## Viewer behavior

The Comments button immediately counts open findings on the displayed model, with one count per comment, and its label names how many are blockers. The themed floating card stays closed until opened. It offers a compact title list sorted by severity then number, one expanded finding showing its severity and category, named locations, Previous/Next controls, and shared review state across a finding's targets. Each title carries its severity as plain text, with blockers in the primary text color and nits dimmed; comments without a severity show no label. The chat row for a turn's published comments prefixes titles the same way. Numbered point markers remain visible while the card is closed. Whole-part findings have an explicit location limitation.

The icon-only control and expanded header share a yellow count badge. The control expands into the card from the same top-right corner, including narrow panels. In PiP, opening comments docks CAD and opens the card there. Dismiss first reveals an inline reason input (Enter confirms, Escape cancels, an empty reason is omitted), and dismissed findings show the kept reason. Resolving or dismissing clears the selected marker immediately; closing clears the selection ring. Discuss seeds the finding's chat composer with `About CAD comment #<number> "<title>" (<first location>): ` at the cursor, or on its own line after a draft, and closes the PiP card so the composer is visible; the agent then looks the number up through `cad_comments_list`. Markers have smooth outlines, with occlusion explained in the open card instead of a dashed outline.

Selecting a finding focuses its first location outside the card. Selecting the location again refocuses. A point target replays the agent capture it was located in: the watched catalog carries each cited capture's view (`captureViews`), and the viewer shows that capture's visibility, isolation, explosion, highlight, ghost, and section planes from the capture's eye, aimed at the point and scaled to fit beside the card. Locating rejects a pick with anything in front of it, so the point is visible in that view. Whole-part targets, and captures naming occurrences the displayed model lacks, reveal a hidden/isolated target from the current angle and ghost every part in front of rays aimed across the target's bounds. A point without a capture view tries alternate angles first, and self-occlusion is reported instead of hiding the target itself. Manual orbit input cancels animation. The review view is layered over the user's view, so orbiting and saving keep it; while it shows, markers on parts it hides are hidden. Closing restores the user's view while keeping the camera.

Historical selection opens retained original geometry without rolling back project CAD. Back to current restores the saved current camera, framing, visibility, isolation, and explosion when its model still matches. If CAD changed during review, it opens the newest current view and explains the change.

History saves the effective local view, including edits made while agent control is active. Focus tracks panel/card resizing, and pole-facing comment cameras keep a valid up direction for later restoration. Closing review intentionally preserves visual framing with the camera, avoiding a jump when the card disappears. History remains accessible when there is no current scene.

Comment subscriptions query only the owning chat and refresh only on comment events (commit, review, outdated annotation) or ownership events. Model descriptors are shared once per model in a catalog update and memoized in the card. Review retries return the original state/version; conflicts include the current record. Unrelated command receipts cannot acknowledge a review, and commit races return per-item repair codes.

## Verification

- Real SQLite/orchestration tests cover partial publication, receipt replay, review conflicts, cross-chat rejection, required inspection, publication against an older inspected snapshot, evidence retention, stale deletion requests, required severity and category with their persistence roundtrip, the migration of pre-existing comment records, outdated annotation and clearing through the sync lifecycle, a watched card refreshing when a comment goes outdated, and resolution proposals with each rejection. Review reasons are covered end to end: whitespace-only reasons are dropped, dismissals create one learning even when replayed, resolve keeps the reason without a learning, reopen clears it, and removal fails for unknown learnings. Projection tests check the per-project cap in both the in-memory read model and SQLite. Instruction tests check the assembled guidance with zero and several learnings, including the Codex turn request.
- Outdated comparison tests cover removed, suppressed, geometry-less, moved, and reshaped instances, a part inside a moved subassembly, reimport noise below the diff epsilon, restoration clearing the reason, repeated instances, rekeyed but unchanged parts, whole-part targets, and severity across several targets.
- Geometry tests exercise source/GLTF/explosion transforms, repeated instances, opening misses, nearest occluders, image bounds, orthographic visibility, and model identity.
- Provider transport tests enumerate the twelve CAD tools and preserve native image delivery. [CadChecks.md](CadChecks.md) covers the deterministic `cad_checks` pass that feeds interference leads into this workflow.
- Local browser checks cover selecting locations, resolving/reopening, history/back, and reload. A real imported spacer verifies rim picking and the numbered alternate view.
- Kraken acceptance check (2026-09-07): two fresh chats using GPT-5.6-Luna / Low and the exact prompt `Add comments where I am missing screws` each produced five distinct precise comments, with no whole-part targets. All five marker selections focused visible locations and the comments survived reload. A replay of the earlier five-occluded-candidate failure now returns five visible candidates; a narrow-bore geometry regression checks the nearby-angle search.
- Independent Sol and Opus adversarial reviews: regressions cover concurrent commit conflicts, unrelated/replayed review receipts, archived/recreated chats, deletion during inspection, evidence recovery, suppressed targets, repeated inspection, cross-part occlusion, and pole-facing camera restoration. The Kraken replay still verifies all five points with surrounding components preserved.

These checks establish mechanics, not autonomous accuracy in deciding whether a screw is missing. Inspection relies on the agent's explicit visual confirmation and conservative whole-part fallback.
