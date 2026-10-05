# Check CAD review defaults

Use this check when changing review guidance in `../provider/CadReviewInstructions.ts`.
The guidance reaches Codex through developer instructions and Claude through the
system prompt. `CadProviderTools.ts` adds a shared reminder before publication. Transport tests check delivery, not review quality.

## Run the review

1. Sync an assembly into an isolated Cadsense project using the app-testing skill.
2. Start fresh chats with GPT-5.6-Terra and medium reasoning. Use the prompts below
   without adding instructions about writing style, comment placement, or checklists.
3. Wait for each review to finish. Open every comment and inspect its marked location.
4. Record the model, source revision, prompts, run IDs, comment text, and failures.
   Keep results with the PR so a successful tool call cannot substitute for reading the comments.
5. Run each prompt twice: once with no `DESIGN.md` in the workspace, and once with a
   [design brief](CadDesignBrief.md) that states the intended motion, load cases, and
   known unfinished work. Confirm `cad_context` reports the brief in the second run, and
   record whether the brief removed intent mistakes the first run made.

Use these two prompts on a telescoping arm with a pivot and printed motor supports:

> Can you review my telescoping arm and pivot? It's based on 2910's 2023 arm, without the end effector. I moved the motors and added printed supports with wire passages. Do those look okay? I'm planning to lighten the pivot plates and need a wire route for the moving motor. Most fasteners aren't added yet; the MaxSpline collars are in the CAD.

> I've been working on this telescope arm with pivot only, excluding the end effector, based on the 2023 Jack in the Bot 2910. I'm planning a lightening pattern on the pivot side plates and adding the rest of the fasteners to check for small interferences. I changed the motor placement, so I added printed supports with hollow wiring paths. The elevator motor moves a little and I want a neat wire path instead of wires hanging loose. The MaxSpline collars should all be in the CAD. Any feedback to improve my design?

## Assess the review

Judge decision quality before brevity:

- Does the review understand the mechanism's intended motion and stated design constraints? A motor moving with its stage must not become a loose-mount finding without evidence.
- Does it check that the mechanism works as modeled: power reaches every driven part, each stage meshes or connects, shafts are supported, and no parts overlap or duplicate each other?
- Does it identify the most consequential supported concern and explain its effect on operation? Accept an explicit evidence gap when no main concern is established.
- Does it investigate relevant manufacturing, assembly, wiring, operation, and repair steps on the actual model? A generic lifecycle checklist is not evidence of inspection.
- Do recommendations explain their purpose and relevant tradeoffs, such as support weight or access lost through tighter packaging?
- Does it use the team's stated targets rather than inventing requirements such as five-minute repairs or a mandatory material?
- Does the student have a clearer next design decision after reading the review?

Keep mechanism-wide concerns in the summary and specific obstructions or features
in CAD comments. A review need not cover every lifecycle stage or publish a fixed
number of findings to pass.

## Assess each comment

Require all of the following for each published comment:

- The marker identifies the feature discussed. A whole-part target has a reason that fits the issue.
- The comment addresses one issue and explains a practical change, check, or specific question at that spot.
- The title and body make sense without reading the chat. Usually one or two plain sentences at about an 8th-grade reading level suffice.
- Short comments do not drop verified findings. A small cleanup issue, such as a duplicate part, gets its own short comment rather than disappearing.
- Claims follow from the inspection. A verified marker alone does not prove rubbing, interference, weakness, or a safe cutout size.
- Known unfinished work appears when it blocks a specific decision, with the dependency explained. An empty hole alone does not establish a missing screw.
- The comment adds information instead of repeating another finding or giving advice that could go anywhere on the assembly.

Record failures even when most comments pass. No fixed comment count is required.
Also check that the final reply briefly explains the main concern and next decisions instead of repeating
all comments. These runs are a behavioral spot check, not proof of engineering
correctness or consistent behavior across models and assemblies.

## Recorded check: September 20, 2026

GPT-5.6-Terra, medium reasoning, fresh chats, using the two prompts above without
follow-up coaching. The downloaded Assembly 1 has 577 components. Its Onshape
microversion is `00bc99fc702d682d31e0d064`, document
`e5fd6dd412a8653a52ad3252`, element `e46921a75b1bb6cff79888e0`.

| Prompt               | Run ID                                 | Result                                                                              |
| -------------------- | -------------------------------------- | ----------------------------------------------------------------------------------- |
| Short review request | `d769fcac-1e16-47a0-931f-8c9db370e361` | One two-sentence comment, point on the printed support; three-sentence final reply. |
| Student update       | `0cc60d3d-165a-448c-a5ef-8040e28b8a8f` | One two-sentence comment, point on the printed support; three-sentence final reply. |

The comments, transcribed without editing:

> **Add a protected wire exit here**
>
> This motor cradle has no visible path or clamp for the moving motor cable. Add a rounded pass-through or side exit and a tie-down point, then leave a loose loop between this support and the stationary frame so the pivot can travel without pulling the connector.

> **Add a wire clamp at this support**
>
> The printed support gives the elevator-motor wiring a covered route, but the model does not show a clamp that takes load off the motor lead. Add a tie-down or removable cover near this channel and leave a short service loop so the motor's small motion does not pull on the connector.

Result: partial improvement, not a full quality pass. Neither run used report
labels or raised the known missing bolts as a finding. Both comments were opened
in the viewer: the markers lie on the blue support face, but do not identify an
exact wire exit. The first comment's claim that no path is visible needs further
inspection given the user's stated wire passage. The second retains the unexplained
term "service loop". Both summaries still contain some technical phrasing.

An earlier tool-description-only version produced a long report and dense plate
advice. Moving the guidance into session instructions and explicitly limiting
unsupported strength claims improved brevity, but did not eliminate these misses.
Claude delivery is covered by code checks; this behavioral check ran only Terra.

## Recorded check: September 27, 2026, Ultimate Ascent transfer

A WIP 2013 frisbee transfer: Onshape document `0e6a45fa6581191bfeed4d0a`, Assembly 1
(`ed9df6627855dacf7d96be26`), microversion `437281c10d1a49799e4ed01d`, 146 components.
The student prompt, sent without follow-up coaching:

> Can you review my transfer for Ultimate Ascent (2013)? It's still WIP. I based it on the small robots from that year that had a ground intake and a single wheel shooter. The disc comes in from the intake already at an angle, and the transfer's job is to feed it into the shooter. I'm using 2 inch rollers and a Vortex. I've been having trouble finding a good place to mount the motor, but the middle of the transfer seems like it could have enough space. Right now it's 3 separate plates but I'm planning to consolidate them into one. I haven't run gear ratio calcs yet, but since the frisbee is somewhat compliant I don't think it'll take much torque to move it. Any feedback?

Eight problems, each confirmed with exact OpenCascade booleans on a STEP export of
the same microversion, form the answer key:

1. The drive is not connected: the 40T gear's 1.75" shaft and the 2.39" shaft carrying the 84T belt are 2.30" apart with nothing between them.
2. The 7T/40T centers are 1.152" apart instead of 1.175", and the 40T gear runs into the 1x1 tube.
3. Neither jackshaft has bearings, and both run into the SPARK Flex.
4. Part 17 and Part 20 overlap by 10.99 in³; Part 20 is a stale copy.
5. Each roller carries both a 13" hex shaft and the roller kit's 11.5" rounded hex.
6. The belt ends have no pulleys.
7. The existing stage is 7T:40T, 5.71:1 (a review that assumes 1:1 fails this).
8. The SPARK Flex is mated between the Vortex and its plate, so the motor is not held.

Runs used the CAD tool branches under review at the time (#83, #84, #85, #87, #89,
#102), Opus 5.5 at high effort and GPT-5.6-Terra at medium, two concurrent runs per
machine. Problems found out of eight, per run:

| Guidance                                           | Opus 5.5 | GPT-5.6-Terra |
| -------------------------------------------------- | -------- | ------------- |
| Previous defaults                                  | 3, 5     | 1, 0          |
| These defaults                                     | 7        | 1, 1          |
| Previous defaults, exact `cad_checks` interference | 6.5      | 1, 1.5        |
| These defaults, exact `cad_checks` interference    | 8, 8     | 1.5, 2.25     |

Every Opus run under the previous defaults pinned a comment asking whether the motor
could come out without removing a shaft, echoing the old wording example; no run under
these defaults did. Opus comments measured Flesch-Kincaid grade 3.8 to 6.5 under
both. Terra found the duplicate plate only with exact interference, and under both
defaults it traced the power path but twice called it connected. One or two runs per
cell is a spot check, not a benchmark.

## Recorded check: October 1, 2026, small-model gap

Same transfer, microversion, and student prompt as above, run through `cadsense mcp` with
`cad-mcp-review-e2e.ts`. Codex CLI 0.159.0 ran GPT-6-Luna from an isolated `CODEX_HOME` (no
global `AGENTS.md`) with a fresh data directory per run. A separate agent graded every run
blind against the eight-problem key, with half credit for a hedged or partial problem. Two
runs that Onshape refused ("Could not reach Onshape") were rerun. Each arm adds to the one
above it unless noted.

| Arm                   | Change                                            | Runs | Score per run  | Mean | Pinned | ID errors per run |
| --------------------- | ------------------------------------------------- | ---- | -------------- | ---- | ------ | ----------------- |
| Baseline              | `main` at `bfeb1261a`                             | 3    | 1, 0.5, 1      | 0.83 | 0.3    | 1.0               |
| Short IDs             | [Short IDs](../provider/CadShortIds.ts)           | 3    | 0.5, 1, 1      | 0.83 | 0.3    | 0                 |
| Tools                 | `drivetrain` check, overlap readings and ranks    | 3    | 1.5, 3.5, 3.5  | 2.83 | 0      | 0                 |
| Procedure             | Ordered review procedure in the guidance          | 3    | 5, 4, 1.5      | 3.50 | 1.3    | 0                 |
| Drafts                | `cad_checks` returns publishable drafts           | 3    | 2.5, 2, 2.5    | 2.33 | 1.7    | 0                 |
| Final                 | Specific errors for bad URLs and assembly targets | 3    | 2, 2.5, 0.5    | 1.67 | 1.0    | 0                 |
| Final, high effort    | Same, reasoning effort high                       | 3    | 4.5, 3, 2      | 3.17 | 2.0    | 0                 |
| Baseline, high effort | `main`, reasoning effort high                     | 4    | 2.5, 0, 2, 2.5 | 1.75 | 1.2    | 1.2               |
| Opus 5.5              | Procedure arm, Claude Code                        | 1    | 8              | 8    | 7      | 0                 |

Every medium-effort run with the new tools beat every medium-effort run without them, except
one Final run that declined to review ("I can't give a reliable review of the
intake-to-shooter transfer from this model view") with six drafts in hand. Procedure, Drafts,
and Final are indistinguishable at three runs each. Together the twelve medium-effort tool
runs average 2.58, against 0.83 for the six without.

How often each problem was found, as a fraction of runs:

| Problem                           | No tools (6) | Tools, medium (12) | Tools, high (3) | Opus (1) |
| --------------------------------- | ------------ | ------------------ | --------------- | -------- |
| 1. Drive not connected            | 0.25         | 0.75               | 0.83            | 1        |
| 2. Mesh too tight, gear into tube | 0            | 0.46               | 0.50            | 1        |
| 3. No jackshaft bearings          | 0            | 0.12               | 0.17            | 1        |
| 4. Duplicate plate                | 0.33         | 0.04               | 0.33            | 1        |
| 5. Doubled roller shafts          | 0            | 0.08               | 0               | 1        |
| 6. Belt with no pulleys           | 0.08         | 0.67               | 0.50            | 1        |
| 7. 5.71:1 ratio                   | 0.17         | 0.46               | 0.67            | 1        |
| 8. Motor not held                 | 0            | 0                  | 0.17            | 1        |

What each change did:

- Short IDs removed the copy failures. Baseline runs transposed characters in 64-character occurrence IDs, retried the same bad call, then dropped the part. One high-effort baseline run dropped three characters from the Onshape URL and gave up after the old error suggested `/w/`, which is why `cad_open` now says which ID has the wrong length.
- Tools moved the drivetrain problems from almost never to most runs. Without them Luna ran `cad_checks`, read 65 unranked overlaps, and wrote "I wouldn't treat those results as a list of confirmed problems." With them its replies led with the dead power path, the 0.023 in tight mesh, and the bare belt. Tool runs published nothing, though: "I didn't publish CAD comments because my attempts to pin the belt in the model returned no surface hit."
- Procedure and drafts moved one or two findings per run into comments, mostly the mesh and the belt. Luna dropped the other drafts as unfinished because the student called the design WIP. A rule that only a named part counts as unfinished is the next thing to test; Onshape rate-limited the key before it could run.
- High effort on `main` made Luna inspect more (32 to 49 tool calls against about 15) and pin precise points, but it never found the power path, and two of its four runs implied the drive was connected. With the tools it scored best of the Luna arms.
- Opus found all eight in 12 comments in 6.4 minutes on the Procedure arm, so the new tools and procedure did not cost it findings.

Luna reports three or four problems per review regardless of how many the tools prove, so it
relays only part of the six that `drivetrain` and the overlap readings establish. Problems 3,
4, and 5 are proven in the tool output but appear in few replies. Problem 8 needs mate
analysis that no check has. Three runs per arm is a spot check: arm means within
about one point of each other are noise.

## Recorded check: October 1, 2026, small-model gap, second round

Same transfer, prompt, and harness, with three changes to how runs are made. Every run starts
from a copy of one data directory that already holds the microversion, so `cad_open` makes no
Onshape requests (the first round spent the key's rate limit). The e2e script owns the MCP
server and gives the agent a relay, so the server closes the review in order after the agent
exits, the way an app turn ends. The rubric also records duplicate comments and weak comments
(a target that does not fit, more than one issue, no next step, an unsupported claim, or advice
that fits anywhere). Luna runs went to one blind grader and Opus and GPT-6-Sol runs to another,
so each model's `main` and final runs were scored in one session.

Changes, in the order they were added:

1. A `motor-mount` drivetrain finding for a controller docked in front of its motor (problem 8).
2. Only a part the user names as unfinished excuses a defect; "WIP" alone does not.
3. `cad_comments_publish` results list `remainingDrafts`, and agents can decline a draft with `declinedDrafts` and a reason.
4. When a turn ends, drafts that no comment covers and the agent did not decline are published as drafted. See [the backstop](CadChecks.md#drafts-reminders-and-the-backstop).
5. Bearing drafts target only the shaft, and `cad_open` checks a URL's shape before any network request.
6. After the high-tier check below: a draft's whole-part target is a fallback for problems at a spot, one problem gets one comment, and every draft ends with a next step.

GPT-6-Luna, medium effort unless noted:

| Arm                                               | Runs | Score per run       | Mean | Pinned | Backstop comments |
| ------------------------------------------------- | ---- | ------------------- | ---- | ------ | ----------------- |
| 1 and 2                                           | 4    | 2, 2, 3.5, 3.5      | 2.75 | 2.0    | 0                 |
| 1 to 3                                            | 4    | 3.5, 2.5, 2.5, 1.5  | 2.50 | 2.8    | 0                 |
| 1 to 3, reminder says leftovers will be published | 4    | 4.5, 5.5, 3, 4.5    | 4.38 | 4.2    | 0                 |
| 1 to 4                                            | 5    | 5, 5.5, 6, 5.5, 4.5 | 5.30 | 6.2    | 0.6               |
| 1 to 5                                            | 4    | 5.5, 5.5, 7, 6      | 6.00 | 7.2    | 1.8               |
| 1 to 5, high effort                               | 2    | 5.5, 6              | 5.75 | 7.0    | 0                 |

The third row's backstop failed at shutdown: the activation closed before the backstop could
read the chat's comments, an ordering bug fixed before the next row. That row differs from the
second only by the sentence that leftovers will be published; Luna published its drafts more
often once told. In two of the 1 to 4 and 1 to 5 runs Luna published nothing and
the backstop published every draft; its reply still described the same problems. No Luna run
contradicted the key or duplicated a comment. The grader marked three backstop comments weak for
stating a defect with no next step, which change 6 fixes.

High-tier models, `main` against the same changes:

| Model and arm     | Runs | Score per run | Mean | Comments | Point targets | Duplicate groups | Weak |
| ----------------- | ---- | ------------- | ---- | -------- | ------------- | ---------------- | ---- |
| Opus 5.5, `main`  | 2    | 7, 6          | 6.50 | 6.0      | 4.5           | 0                | 2.0  |
| Opus 5.5, 1 to 3  | 3    | 7.5, 8, 7.5   | 7.67 | 10.7     | 0.7           | 0                | 1.0  |
| Opus 5.5, 1 to 4  | 3    | 7.5, 7, 8     | 7.50 | 9.3      | 0.3           | 0.3              | 1.3  |
| GPT-6-Sol, `main` | 2    | 2.5, 3.5      | 3.00 | 5.0      | 2.0           | 0                | 0.5  |
| GPT-6-Sol, 1 to 3 | 1    | 5             | 5.00 | 9.0      | 0             | 1                | 0    |
| GPT-6-Sol, 1 to 4 | 2    | 7.5, 8        | 7.75 | 17.0     | 0             | 3.5              | 0    |

Recall rose for both, and the backstop never published for either: they covered every draft
themselves. Two quality regressions came with the drafts. Opus stopped placing precise markers,
adopting the drafts' whole-part targets (4.5 points per run on `main`, under 1 after), and Sol
split one problem across the three rollers into three comments. Change 6 targets both. With it:

| Model, changes 1 to 6 | Runs | Score per run | Mean | Comments | Point targets | Duplicate groups | Weak | Backstop comments |
| --------------------- | ---- | ------------- | ---- | -------- | ------------- | ---------------- | ---- | ----------------- |
| Opus 5.5              | 3    | 7.5, 8, 8     | 7.83 | 9.3      | 3.7           | 0                | 1.0  | 0                 |
| GPT-6-Sol             | 2    | 7.5, 7        | 7.25 | 10.0     | 0             | 1.0              | 1.0  | 0                 |
| GPT-6-Luna            | 3    | 5, 7, 7       | 6.33 | 6.7      | 0             | 0                | 0.7  | 4.7               |

Opus's markers came back (3.7 points per run against 4.5 on `main`) with higher recall, no
duplicates, and fewer weak comments than `main`; the one contradiction matched one on `main`.
Sol now merges repeats into one comment with several targets, but one duplicate group per run
remains and it still uses whole-part targets where `main` placed one or two points. In two of
three Luna runs the backstop published every draft. These runs started before drafts gained
next steps, so the backstop comments the grader marked weak predate that fix, which is verified
only by `CadChecks.test.ts`.

Declining works. With "the 84T belt is just a placeholder" added to the prompt, both Opus and
Luna declined the belt draft with that reason and published no belt comment. Opus also declined
drafts its own comments already covered ("Covered by the published question about the missing
link between the 1.75 in and 2.39 in shafts"), so nothing was published twice. One earlier Opus
reply told the student "the 84T belt drafts are declined"; the guidance now keeps tool names out
of replies, and the next run did not repeat it.

Over MCP outside this harness, the backstop is unreliable. Of four runs before the relay, one
needed the backstop, and Codex killed its server before the backstop finished, so it published
nothing. In the app, adapters end each turn explicitly and the backstop runs every time. Six
completed runs were excluded: those four, one whose Codex session never saw the tools, and one in
which Luna copied the URL with a changed character and no `/e/` tab (the error was a network
error then; `cad_open` now names the missing tab first). Runs cut off by a session restart were
discarded.

## Recorded check: October 2, 2026, point placement

Same transfer, prompt, seeded harness, and blind grading, with marker images added to the packets so
the grader checks that each point marker sits on the feature its comment describes. Smaller models
rarely placed point targets: Luna called `cad_comment_locate` in 5 of 64 earlier reviews. The three
mechanisms are described in "Helping smaller models place points" in [CadComments.md](CadComments.md).

**Nearby snapping**, checked with `cad-mcp-replay.ts` on the five recorded reviews in which Luna tried
to place a point, replaying its exact views and pixels with no model:

| Recorded miss                                              | Picks | Now                                                                                                              |
| ---------------------------------------------------------- | ----- | ---------------------------------------------------------------------------------------------------------------- |
| `no-hit` beside the thin 84T belt and a roller belt        | 2     | Both candidates, moved about 5 px                                                                                |
| `occurrence-mismatch`, hit the 40T gear aiming at the tube | 1     | Candidate, moved about 13 px                                                                                     |
| `occurrence-mismatch`, tube not visible within 64 px       | 1     | Still a mismatch                                                                                                 |
| `transparent-hit` on Part 17                               | 3     | Still refused: the plates are tinted polycarbonate (opacity 193/255), and translucent surfaces never take points |

Three of the four placeable misses are recovered.

**Check-placed points and the follow-up turn**, GPT-6-Luna at medium effort, against the previous
round's final runs graded in the same session:

| Arm                                      | Runs | Score per run | Mean | Own comments | Backstop comments | Point markers | Misplaced | Duplicate groups |
| ---------------------------------------- | ---- | ------------- | ---- | ------------ | ----------------- | ------------- | --------- | ---------------- |
| Previous final                           | 3    | 5.5, 7, 7     | 6.50 | 2.0          | 4.7               | 0             | 0         | 0                |
| P1: snapping, check-placed points        | 4    | 5.5, 6, 8, 7  | 6.62 | 3.5          | 4.2               | 0.2           | 0         | 0.8              |
| P2: P1, `publishDrafts`, `pendingDrafts` | 4    | 4.5, 8, 8, 8  | 7.12 | 1.0          | 7.5               | 0.2           | 0         | 0.8              |
| P3: P2, one follow-up turn               | 4    | 8, 8, 8, 7.5  | 7.88 | 9.5          | 0                 | 3.5           | 0         | 0.8              |

`cad_checks` offered four inspected point targets with images on every run (the gear pair, the
bare belt end, and each jackshaft entering the SPARK Flex; the gear-into-tube marker was hidden in
its inspection and kept whole-part targets). In P1 and P2 Luna often published nothing: in four
of eight runs the backstop published every draft, and its comments are whole-part by design, so
points stayed near zero. Luna saw the `pendingDrafts` note on up to four results per run and still
stopped. The follow-up turn changed that: it fired in three of four P3 runs (the fourth published
everything in its first turn), each time Luna pinned every draft itself with `publishDrafts`, and
the backstop published nothing. Scores in P1 and P2 are high because the backstop's drafts now cover
seven or eight of the problems; the measures that matter for placement are own comments and points.

In the drafted runs the grader flagged one duplicate group: the two jackshafts running into the
SPARK Flex were two comments. Collisions into one part now merge into one draft with a marker per
shaft, titled with the parts' names.

**Higher tiers.** Opus 5.5 (high effort, Claude Code) and GPT-6-Sol (medium) ran P3 and then P4
(P3 with merged collision drafts; two of the four Sol P4 runs also had the ledger fix below). P3 went to one blind grader with the previous round's final
runs, which regraded to the same scores; P4 went to a second grader with four Luna runs. The
backstop published nothing for either model, and the follow-up never fired: both published
everything in their first turn.

| Arm                      | Runs | Score per run  | Mean | Own comments | Point markers | Misplaced | Duplicate groups |
| ------------------------ | ---- | -------------- | ---- | ------------ | ------------- | --------- | ---------------- |
| Opus 5.5, previous final | 3    | 7.5, 8, 8      | 7.83 | 9.3          | 3.7           | 0         | 0                |
| Opus 5.5, P3             | 3    | 8, 8, 8        | 8.00 | 9.7          | 3.3           | 0         | 0                |
| Opus 5.5, P4             | 2    | 7.5, 8         | 7.75 | 9.5          | 4.5           | 0         | 0                |
| Sol, previous final      | 2    | 7.5, 7         | 7.25 | 10.0         | 0             | 0         | 1.0              |
| Sol, P3                  | 2    | 8, 7           | 7.50 | 10.0         | 4.0           | 0         | 1.0              |
| Sol, P4                  | 4    | 6, 6.5, 5, 8   | 6.38 | 7.8          | 2.8           | 0         | 0.2              |
| Luna, P4                 | 4    | 8, 7.5, 6.5, 8 | 7.50 | 8.2          | 3.5           | 0         | 0                |

Opus held its scores and now publishes the check-placed points instead of locating its own
("Republished in plainer words as gear-spacing using the same point"). Sol went from no point
markers to four per run in P3. The merge removed the jackshaft duplicate for every model in P4.

Sol's P4 drop came from declines. Its three low runs each declined drafts the student never called
placeholders: the duplicate plate ("The user specifically plans to consolidate the three plates"),
and once the motor mount and the jackshaft collision (the student "has been having trouble finding
a good place to mount the motor"). The run that declined nothing found all eight problems. Earlier
rounds show the same declines (Sol, Luna, and Opus each declined the motor-mount or duplicate draft
at least once), so the rule "decline only those whose part the user named as unfinished" was too
loose for a prompt that describes plans for the plates and motor. The rule now allows declining
only a part the user said is a placeholder or not modeled yet, and says a plan to rework, move, or
merge parts later does not excuse a defect in the model as drawn.

P5 is P4 with that rule and the ledger fix below, graded by a third blind grader:

| Arm          | Runs | Score per run | Mean | Own comments | Point markers | Misplaced | Duplicate groups |
| ------------ | ---- | ------------- | ---- | ------------ | ------------- | --------- | ---------------- |
| Luna, P5     | 4    | 8, 8, 8, 8    | 8.00 | 9.0          | 4.0           | 0         | 0                |
| Sol, P5      | 4    | 7, 7, 8, 8    | 7.50 | 11.0         | 4.2           | 0         | 0                |
| Opus 5.5, P5 | 2    | 7.5, 8        | 7.75 | 10.5         | 4.5           | 0         | 0                |

No Luna or Sol run declined a draft. One Opus run declined all nine, each because its own comment
already covered it ("Published as dup-plate."). Sol's two misses were the 5.71:1 ratio, which no
check reports. The backstop published nothing, and the follow-up fired in one of four Luna runs.
Declining still works: with "The 84T belt is just a placeholder for now" added to the prompt, one
Luna and one Sol run each declined only the belt draft and left the belt's missing pulleys out.

Luna now matches the higher tiers on this transfer, but most of the answer key is what
`cad_checks` proves, so Luna's score mostly measures how faithfully it publishes the drafts. One
Luna reply also told the student some collision comments "may be outside your intended review
scope". A design whose problems the checks cannot see would test Luna's own review.

In one P4 Sol run, reading the second page of `cad_checks` findings erased the drafts as offered,
so all eight `publishDrafts` keys came back `unknown-draft`; Sol recovered by sending the drafts as
items. The draft ledger now keeps offered drafts across pages, covered in `CadViewing.test.ts`. No
other recorded run hit it.

The follow-up turn ran in the e2e harness by resuming the agent's session (`--follow-up`). The app
now sends it itself; see the next check. Over MCP outside the harness, the server cannot start a
turn.

## Recorded check: October 5, 2026, follow-up in the app

The same transfer and prompt, run through the app's own turn handling with
`cad-app-review-e2e.ts`: the orchestration engine, the Codex or Claude adapter, and headless
Chromium rendering, on a copy of the seeded data directory. The follow-up is now part of the turn
(see "The follow-up" in [CadChecks.md](CadChecks.md)). One blind grader scored all eight runs with
the same rubric; packets list every assistant message the student saw, since after a follow-up the
last message is a one-line wrap-up.

| Model                 | Runs | Score per run | Mean | Comments | Point markers | Follow-ups | Backstop comments |
| --------------------- | ---- | ------------- | ---- | -------- | ------------- | ---------- | ----------------- |
| GPT-6-Luna, medium    | 4    | 7, 8, 8, 8    | 7.75 | 8.5      | 2.0           | 2 of 4     | 0                 |
| GPT-6-Sol, medium     | 2    | 8, 8          | 8.00 | 9.5      | 4.0           | 0 of 2     | 0                 |
| Opus 5.5, high effort | 2    | 8, 8          | 8.00 | 12.0     | 4.0           | 0 of 2     | 0                 |

No run had a misplaced marker or a backstop comment. When the follow-up fired, Luna published
every remaining draft itself in one call and closed with a line such as "I added CAD comments for
the gear spacing, belt path, motor mounting and roller drive, unsupported and stacked shafts, the
gear and controller collisions, and the apparent duplicate plate." Sol and Opus never needed it.
The run that scored 7 lost half points on items 2 and 3: it pinned the gear spacing and the motor
mount, and a comment covers a draft when it targets any of the draft's parts, so the two collision
drafts counted as covered and nothing asked for them. That leniency is deliberate: a stricter rule would
send Opus back for drafts its own comments already cover.

With "Just answer in chat, I don't want CAD comments on this one yet" (a gear-ratio question),
Opus declined every draft, answered 5.71:1 with the tight mesh, and offered to pin the rest later.
Nothing was published.

The runs found three problems, fixed before the graded runs:

- A `cad_checks` call that ran fewer checks replaced the turn's drafts. One Luna run called it again
  with `checks: ["drivetrain"]`, which erased the two collision drafts and the duplicate plate, so
  neither the follow-up nor the backstop published them. Opus and Sol make such calls too (Opus ran
  default, drivetrain-only, and mesh-interference-only calls in one review). Draft keys are now
  digests of snapshot, kind, and parts, and later calls merge into the ledger by key.
- When the first render of a turn was a placement inspection, a cold renderer under heavy load
  missed the 60-second worker deadline, the worker restarted, and every placement failed the same
  way: `cad_checks` took 12.5 minutes and offered no points. Placement now stops after a render
  failure (83 and 110 seconds in the two graded Luna runs where it happened), and a turn reuses
  its placements when `cad_checks` runs again.
- Ordinal draft keys could repeat across reviews in one chat, so a later review's draft could hit
  `idempotency-conflict` against an earlier comment. Snapshot-based keys never repeat.

The machine ran at load averages of 80 to 300 on 32 cores during these runs, and two Opus runs
were discarded after the Claude API stalled for 23 and 29 minutes with nothing in flight. Durations
here are not representative; harness runs of the same review take 2 to 4 minutes.

The Claude follow-up never fired in a real review, because Opus never stopped with drafts
pending, and Haiku 4.5 could not run through the local model proxy. The SDK behavior it relies on
was checked directly: a `Stop` hook answering `{decision: "block", reason}` made Claude continue in
the same query with the reason as feedback, one result came back, and the hook fired again with
`stop_hook_active` set, where the ledger allows the stop.

### After adversarial review

Two rounds of adversarial review (Opus 5.5 and GPT-6.1-Sol) changed what gets published: the
backstop now publishes only after a main-agent turn completes (or after a failed follow-up), never
on Stop, app shutdown, a child agent's turn end, or while child agents still run; agents may
decline a draft their own comment covers, one the user asked not to have, one they asked the user
about, or one they inspected and found wrong; standoffs, adapters, and couplers are no longer
shafts and bushings count as bearings; length mismatches are not drafted; a stack of copies is one
draft. The same transfer through the app path afterwards, graded blind:

| Model                 | Runs | Score per run | Comments | Point markers | Follow-ups | Backstop comments | Declines |
| --------------------- | ---- | ------------- | -------- | ------------- | ---------- | ----------------- | -------- |
| GPT-6-Luna, medium    | 4    | 8, 8, 8, 8    | 9.0      | 4.0           | 0 of 4     | 0                 | 0        |
| GPT-6-Sol, medium     | 2    | 8, 8          | 9.5      | 4.0           | 0 of 2     | 0                 | 0        |
| Opus 5.5, high effort | 2    | 8, 8          | 10.5     | 4.5           | 0 of 2     | 0                 | 1 each   |

The machine was lightly loaded for these runs, so Luna finished in 45 to 101 seconds and published
every draft in its first turn. Each Opus run declined only the unpowered-rollers draft, citing its
own comment on the missing link between the 1.75 in and 2.39 in shafts, which targets the shafts
rather than the rollers; under the old rule the backstop would have published that draft as a
second comment. No Luna or Sol run declined anything under the wider rule.

## Matched evaluation before the review-process update

These results compare baseline `9479482ee` with `ef30dc417`, before the added
intent, lifecycle, and tradeoff guidance. Both versions used the same snapshot
and GPT-5.6-Terra with medium reasoning in fresh chats. An initial six-run batch
hit renderer timeouts and was excluded. The four replacement runs below had no
renderer-failure reports. These are individual runs, not statistical estimates.

Motor prompt:

> I moved the motors and added these printed supports with hollow paths for the wires. Do the supports look okay? The elevator motor moves a little, and I'm not sure how to route its wires without them hanging loose. Can you review that part of my arm? Most bolts aren't in the CAD yet.

Pivot prompt:

> I want to add a lightening pattern to the pivot side plates on this arm. Can you review them and help me figure out what to change? I haven't added most of the bolts yet, but the MaxSpline collars are in the CAD.

| Case  | Baseline run                           | Updated run                            | Final reply words | CAD comments |
| ----- | -------------------------------------- | -------------------------------------- | ----------------- | ------------ |
| Motor | `61b747fc-179f-45a6-b8fe-59fb2eb84e0a` | `51a52e0e-4bfa-40e1-b89f-c74ff371e1be` | 216 → 75          | 0 → 2        |
| Pivot | `995e64d3-e09c-4b4e-9d93-ecfe06efc544` | `3de0bf39-cde5-4a7c-b3d8-6292d9e57e0f` | 249 → 66          | 0 → 2        |

The updated motor comment was more local:

> **Clamp the wire at this channel exit**
>
> The hollow path protects the wire, but it does not retain it at the motor. Add a small zip-tie or clip near the motor exit and leave a short service loop so elevator motion bends a controlled length of cable.

However, it also published this unsupported interpretation:

> **Finish the elevator motor mount**
>
> The elevator motor can move at this support. Add the intended mounting bolts and any washers or retainer for this pattern, then check that the motor has no play before running it.

The baseline had speculated that absent bolts "may allow the small movement you
noticed." The updated version turned that assumption into a definite finding.
Neither established that the described motion was mounting play rather than
intended stage travel. This fails intent and evidence checks despite its brevity.

The baseline pivot reply recommended "0.5 in ligaments" as a conservative starting
point without a load calculation. The updated comment instead asked for arm load,
plate thickness, and the final fastener layout before setting a band width. Yet
another updated comment still instructed: "Put the main weight-saving window in
this open triangular field, with large inside radii." It still prescribed a cutout
region without analysis. Both updated cases also retained technical phrasing.

## Lessons incorporated from team reviews

The September 16 team reviews led with consequential concerns such as structural
stability, accessibility, and compactness. Their useful questions followed real
work: reaching a motor, replacing a mechanism, retaining shafts, routing wires,
and manufacturing parts without adding play. The side-roller discussion first
established that compactness explained the layout choice.

The review defaults now use that process: understand intent, investigate actual
use and maintenance, identify the main supported concern, and explain changes
with their tradeoffs. Missing fasteners or wires can block a design decision even
when the student already plans to add them. Team-specific repair times and
material preferences remain context, not universal rules.

The matched results above motivated this revision; they do not validate it. Rerun
the motor and pivot prompts to assess whether the new guidance prevents the
motion-to-looseness inference and unsupported cutout recommendations. Also test
repair-access and compactness cases on suitable CAD before claiming those review
skills work reliably.
