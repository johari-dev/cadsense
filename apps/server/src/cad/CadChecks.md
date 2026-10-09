# CAD checks

`cad_checks` is the deterministic pass that runs before the agent looks. Like a linter feeding a code review, it scans the pinned snapshot of the selected root and returns candidate findings with occurrence IDs. The agent verifies each lead visually and writes comments with evidence; the tool never proves interference on its own.

## Checks

Every finding carries the check name, the involved occurrence IDs and names, numbers in meters, and a one-line explanation of what it does and does not prove.

- `drivetrain`: gear center distances, belt and chain lengths, shafts without bearings, shafts modeled inside shafts, and the power path from each motor, read from vendor part names and fitted mesh axes. See [the drivetrain analysis](CadDrivetrain.md). Its findings come first, `problem: true` ones before traced facts.
- `mesh-interference`: pairs of unsuppressed part occurrences whose solids actually intersect by more than one cubic millimeter, computed with exact mesh booleans on the stored triangles. Reports the intersection volume, its fraction of the smaller solid, `withinSubassembly`, and a plain-language `reading`. Pairs that share a parent subassembly other than the root (a vendor kit's screw and nut, a motor and its own shaft) are usually the kit author's modeling choice, so they sort after every cross-subassembly pair. Pairs with a game piece (usually an intended squeeze) and then pairs with a fastener (usually modeled threads) sort after those. Each group is ordered by volume, largest first. This is the default overlap check.
- `overlapping-bounds`: pairs of unsuppressed part occurrences whose world-space axis-aligned bounding boxes overlap by more than one cubic millimeter. Reports the overlap box size, volume, the overlap fraction of the smaller box, and whether one box lies fully inside the other. Findings are ordered by overlap volume, largest first. Fasteners in holes and parts in pockets overlap too, so the explanation says the result is a lead, not proof.
- `coincident-instances`: two occurrences of the same source part whose transforms differ by at most one micron per element, which usually means a duplicate insertion.
- `degenerate-geometry`: part occurrences whose bounds are unavailable (`size: null`) or thinner than 0.1 micron on some axis. Surface bodies trigger this on purpose.

Suppressed occurrences and everything under a suppressed assembly are skipped. Explosion is ignored; boxes use the original placement.

## Bounds

The manifest caches no bounds, so `CadChecks.ts` reads them from each stored GLB once per asset hash and keeps them for the activation. It composes the glTF default scene's node matrices (or TRS) onto each `POSITION` accessor's `min`/`max`, so no vertex data is decoded. Assets over the 128 MiB per-part limit, normalized accessors, cyclic node graphs, and unreadable containers produce unknown bounds; those occurrences count in `summary.boundsUnknown` and appear in `degenerate-geometry`. `mesh-interference`, `overlapping-bounds`, and `degenerate-geometry` read bounds; only `mesh-interference` also reads triangles, per call rather than cached, since they are needed only while intersecting. A `coincident-instances`-only call touches no assets. `cad_find_parts` reads the same cache through the same loader to report each returned part's world box, placed with the same `worldCadBounds` and rounded like findings, so a part measured by either tool is never read again in that activation.

## Mesh interference

Bounding boxes overlap for shafts in holes, parts in pockets, and every part near a tilted game piece, so on an 88-part transfer `overlapping-bounds` returns 312 leads and agents skip the real ones. Exact intersection still left 65 pairs there, and a small model dismissed the whole list as noise ("including intended assemblies and the modeled game piece"). The `reading` and the game-piece and fastener ranks exist for that: the duplicate plate, the doubled roller shafts, and the gear and shafts running into the tube and motor controller now lead the page in words, with the game piece and fastener pairs at the end. `mesh-interference` uses the bounding-box sweep only as the broad phase, then intersects the two solids with `manifold-3d` (WASM, Apache-2.0). Intended fits touch at zero volume, so on the same transfer 70 pairs remain and the overlapping duplicate plate and the duplicated roller shafts lead the list.

`CadChecks.ts` reads each stored GLB's indexed triangles once per call, composes the glTF node transforms, then applies each occurrence transform, so repeated instances of one asset are placed separately. A part whose triangles do not form a closed, consistently oriented solid after merging coincident vertices cannot be intersected exactly; it counts in `summary.meshUnknown`, its pairs are never reported as clear, and the agent can request `overlapping-bounds` for leads on those parts. The coarse tessellation limits accuracy to roughly the chord error of the export, so a contact of a few thousandths of an inch can read as a tiny intersection or as none.

`manifold-3d` loads `manifold.wasm` from its package directory, so it is a server runtime external (`scripts/lib/server-bundle-externals.ts`) rather than bundled.

Ways this can fail, each covered by `CadChecks.test.ts`:

- Two solids that intersect are missed, or their volume is wrong.
- Solids that only touch at a face are reported.
- Solids whose boxes overlap but whose volumes do not (a part in the gap of another) are reported. This is the noise the check exists to remove.
- glTF node transforms or occurrence rotations are ignored, placing a solid in the wrong spot.
- Repeated instances of one asset collapse into one placement.
- An open or unreadable mesh is reported as clear instead of unknown, or throws.
- Non-triangle primitives or unsupported index types are silently misread.
- Suppressed occurrences are checked.
- A pair inside one subassembly outranks a cross-subassembly pair, or the flag is wrong for parts two levels apart.
- Default selection still returns bounding-box leads, or an explicit `overlapping-bounds` request no longer works.

## Budget and paging

The overlap check sorts boxes by minimum X and sweeps, so a 577-part assembly evaluates a few thousand candidate pairs instead of 166k. Candidate evaluations stop at `summary.pairBudget` (250k) and `summary.budgetExhausted` tells the agent the pass was partial. Findings are deterministic for a given snapshot and check selection, so cursors are plain offsets bound to `snapshotId` and the selected checks, the same scheme as `cad_hierarchy`. Pages default to 50 findings and cap at 100. `expectedRevision` must match the private view revision.

Every page must come back inline. Claude saves an MCP result over its output limit to a file, and reading that file takes a shell command that waits on a permission prompt; a 100-finding `overlapping-bounds` page was 68 KB and stalled a review for 57 minutes that way. So each page states each selected check's explanation once in `explanations` instead of on every finding (that alone was 20 KB), rounds its numbers to four significant digits, and stops adding findings before its JSON passes `CAD_CHECK_LIMITS.pageBytes` (32 KiB). A capped page holds fewer findings than `limit` and its `nextCursor` continues from the first one left out.

Ways paging can fail, each covered by `CadChecks.test.ts`:

- A page, even at `limit: 100` with long part names, serializes past `pageBytes`.
- Explanation text repeats on every finding.
- Numbers carry float noise such as `0.00012500001117587118`.
- The byte cap drops or repeats a finding across pages, or returns an empty page when one finding alone is large.

## Drafts, reminders, and the backstop

The first page returns `drafts`: one ready `cad_comments_publish` item for each defect the checks
prove outright (drivetrain problems and near-total duplicates). Smaller models found these
defects but published one or two of six, citing "WIP" for the rest, so `CadProviderTools.ts`
follows the drafts through the turn:

- A draft is written for the student, since agents publish many as offered and the backstop publishes the rest as drafted. Its body names parts the way a student would ("the 40T gear", "the 13 in. Hex Shaft", "Part 20"), states the problem once even when it covers several parts ("in 3 places"), and ends with a next step. The finding's `summary` keeps exact CAD names for the agent. Drivetrain problems drafted one per finding carry their wording from `CadDrivetrain.ts` (`comment`), where the numbers are; `draftCadComments` words merged drafts (shafts without bearings, doubled shafts, collisions into one part) and duplicates from part names.
- A draft's `publicationKey` is a digest of its kind, parts, and snapshot, so every `cad_checks` call on a snapshot gives a defect the same key whichever other checks ran, and the turn's ledger merges later calls' drafts into earlier ones by key. A new snapshot gives new keys, so a later review in the chat never reuses a published key.
- Drafts whose spot the checks prove (collisions, gears set too close, bare belt ends) arrive with an inspected point target and its image; see "Check-placed points" in [CadComments.md](CadComments.md).
- After each publication it lists the drafts no comment in this chat covers yet as `remainingDrafts`, and other CAD tool results carry `pendingDrafts` until they are covered or declined. `publishDrafts` publishes drafts as offered.
- An agent can decline a draft with `declinedDrafts: [{publicationKey, explanation}]` in `cad_comments_publish` when the user said that part is a placeholder or not modeled yet, the user asked for no CAD comments, one of its published comments already covers it, it asked the user about that part in its reply, or it inspected the parts and the draft is wrong for this model. A plan to rework, move, or merge parts later is not a reason, and neither is calling the design a work in progress: the defect is in the model as drawn. `CAD_DRAFT_DECLINE_RULE` in `CadChecks.ts` states the rule once for every agent-facing text.
- When the main agent's turn completes, it publishes every draft that is neither covered nor declined, worded as drafted, with a note that Cadsense's checks found it, and always with whole-part targets: no agent looked at a check-placed point the backstop would publish. A turn the user stopped, a turn that failed before any follow-up, a turn that ends while child agents or background agents are still working, a child agent's turn, and an app session that shuts down publish nothing, since nobody finished reviewing those drafts. A turn whose follow-up failed does publish them: the review had finished. Over `cadsense mcp` the session is the review, so closing it publishes the leftovers, even when the client quits mid-review: the server cannot tell a quit from a finished review. The backstop is a finalizer on the turn's activation scope, added after the activation starts and armed by `end` (see `CadTurnOutcome`) or, over MCP, from the start, so it runs while the activation is still alive.

A comment covers a draft when it targets any part the draft targets. That errs toward skipping
a draft: a comment about the 40T gear hitting a tube also covers the gear-spacing draft. A
model that comments on everything, as Opus does, gets no backstop comments.

Ways this can fail, each covered by `CadCheckBackstop.test.ts`, `CadViewing.test.ts`, `CadChecks.test.ts`, `CadCheckPlacement.test.ts`, or `CodexFollowUpRuntime.integration.test.ts`:

- A draft states a defect without a next step, so a backstop comment tells the student what is wrong but not what to do.
- A draft whose parts already have a comment in this chat is published again.
- A draft the agent declined is published anyway, including in a later turn that drafts it again.
- A decline cannot be taken back, so when the user later asks for the comments, `publishDrafts` refuses them.
- A draft published by key is offered again with different targets (a render that failed, then worked), so publishing it again conflicts instead of replaying.
- The main agent's turn ends while its child agents or background agents are still working, and the backstop publishes before their work is in.
- A draft nobody commented on is not published when the turn ends.
- The turn end runs twice (end, then close at shutdown) and publishes twice.
- The owner's scope closes without `end` or `close` (MCP shutdown), the activation stops first, and the backstop cannot read the chat's comments.
- Drafts from an earlier snapshot are published after a later `cad_checks` call.
- A later `cad_checks` call that runs fewer checks forgets the drafts it did not reproduce, so neither the follow-up nor the backstop publishes them.
- A model with dozens of duplicates puts so many drafts on the first page that it passes the byte cap; drafts get at most half the page, drivetrain problems first, and the findings still list every problem.
- Two `cad_checks` calls at once place the same draft twice, so a key published from one result conflicts with the other's offer.
- A draft's key depends on which checks ran, so one defect gets two keys, or a later review in the chat reuses a key already published for another comment and gets `idempotency-conflict`.
- A failed backstop publication fails the turn or the shutdown instead of being logged.
- More than 20 leftover drafts, the most one publication takes, and the rest are never published.
- A draft reads like tool output: raw CAD names with instance tags (`<1>`) or specs in parentheses, a lowercase first word, or one sentence repeated for each part it covers. GPT-6-Sol published such drafts word for word in four of five reviews.
- A merged draft leaves out one of its parts or the gear a bare shaft carries, or cuts its next step to fit 4000 characters.
- A draft calls two different parts copies because their short names match ("Side Plate (0.25 in)" and "Side Plate (0.50 in)"), or counts three copies of one shaft in one spot as three places.
- A body near 4000 characters pushes the backstop's note off the end, so an automatic comment reads as the agent's own.
- A stack of copies of one part is drafted once per overlapping pair, so seven copies become 21 comments; or parts that are not copies (a spacer inside two bearings, two parts inside one plate) are called one stack and the student is told to delete all but one. Only same-named parts that all overlap one another stack.
- A merged draft lists one part name several times, so the student cannot tell its targets apart.
- `remainingDrafts` lists a draft that is covered or declined.
- One child agent's turn end publishes drafts from another child's `cad_checks` call.
- Stopping a turn, a failed turn, or closing the app publishes drafts no agent reviewed.
- A child agent's turn end publishes drafts for the whole model before the main agent publishes its own comments.

### The follow-up

Smaller models often stop with drafts still pending even after reading `pendingDrafts` on several
results. When the main agent tries to end its turn with drafts that no comment covers and it did
not decline, the app sends it back once with a message naming them, inside the same turn, and the
backstop runs only when that turn really ends. `CadProviderTools.followUp` decides: it returns the
message at most once per activation and null otherwise, and it never ends the activation. The
adapters only deliver it:

- Claude: a `Stop` hook answers `{decision: "block", reason}`, so the SDK continues the same turn with the message as hook feedback.
- Codex: the app-server cannot reopen a finished turn, so `CodexSessionRuntime.ts` holds back the native turn's `turn/completed`, starts a second native turn with the message and the first turn's settings, and reports that turn's events and completion under the first turn's id. Its `turn/start` holds a lock `sendTurn` also takes, so no turn the user sends can interleave, and waits up to 30 seconds; a turn Codex starts while it waits is the follow-up. If Codex starts it only after the deadline, with no start before, it runs as a separate turn.

Child agents get no follow-up and no backstop. While Claude background agents or Codex child agents
are still working, the main agent gets no follow-up either, and its turn's leftovers are not
published, since that work may cover the drafts. Monitors, inert plan-mode tasks, housekeeping
hidden from the transcript, and Codex memory upkeep do not count as such work.
Over plain MCP the server cannot start a turn, so outside the app only the e2e harness
(`--follow-up`) sends one.

Ways this can fail, each covered by `CadViewing.test.ts` or `CodexFollowUpRuntime.integration.test.ts` unless noted:

- The agent ends its turn with uncovered, undeclined drafts and is never asked to finish them.
- The follow-up is sent when every draft is covered or declined, or twice in one turn, so a model that will not publish loops.
- Asking for the follow-up ends the activation, so the backstop publishes before the agent's own comments and duplicates them.
- Asking for a follow-up on a turn with no CAD activity, an ended turn, or a child agent's turn starts an activation or reads the wrong drafts.
- A failed chat read fails the turn end instead of skipping the follow-up.
- Codex: the first native turn's completion reaches the app, so the app ends the turn before the follow-up.
- Codex: the follow-up appears as a second turn, its events carry a turn id the app never saw, or its completion never completes the app's turn.
- Codex: CAD calls in the follow-up open a new activation with an empty ledger.
- Codex: Stop during the follow-up interrupts the finished first turn, so the agent keeps running.
- Codex: Stop arrives as the first native turn finishes, and the follow-up starts anyway.
- Codex: a follow-up is sent after an interrupted or failed turn, or while another turn the user sent is already queued.
- Codex: a follow-up that fails to start leaves the app's turn running forever.
- Codex: Stop with no turn id, or a turn the user sends, arrives while the follow-up is being decided, and the follow-up starts anyway.
- The follow-up fails, and the review it continues loses its backstop. The failure is still reported on both adapters.
- Codex: the deferred interrupt of a follow-up never answers and holds up every later notification.
- Claude: a running monitor skips the follow-up but still lets the backstop publish, or the reverse. No test drives the Claude adapter here; the Stop hook and the turn end call the one predicate `reviewWorkRunning`, and the SDK's Stop contract (block, continue in the same query, `stop_hook_active` on the next stop) was checked against the real SDK and model.
- Codex: `turn/start` for the follow-up answers late or never, and a turn the user sent meanwhile is taken for the follow-up, or the follow-up's turn shows up as a separate turn.
- Codex: Stop lands between deciding the follow-up and naming its native turn, and is lost.

## Registration

`CAD_TOOL_INPUTS` in `packages/contracts/src/cadTools.ts` declares the input; `CadProviderTools.ts` describes it, lists it as read-only, and routes it to `CadAgentTools.checks`, which `CadViewing.ts` implements inside the activation. Codex and Claude receive it with the other CAD tools; `CAD_REVIEW_INSTRUCTIONS` tells agents to run it early, explain each exact interference finding, and never publish an interference comment from bounds overlap alone. Without `checks`, a call runs `drivetrain`, `mesh-interference`, `coincident-instances`, and `degenerate-geometry`; `overlapping-bounds` runs only on request.

## Verification

- `CadChecks.test.ts` covers the mesh interference failure list above against real triangle GLBs and the WASM kernel, plus glTF matrix and TRS composition, unreadable containers, overlap size and volume, touching faces, containment, occurrence rotation, suppressed subtrees, duplicate and near-miss placements, flat and unknown bounds, the sweep against brute force on 300 random boxes, the budget cutoff and its determinism, bounds caching, cursor binding, revision conflicts, and malformed input.
- `CadViewing.test.ts` runs `cad_checks` through the real activation and provider tool path with a stored GLB, checking the default exact finding, that bounds are read once per activation while triangles are read per call, and that stale revisions conflict.
- `cadHttp.test.ts` and `CodexCadTools.test.ts` enumerate the twelve registered tools and the read-only set.
