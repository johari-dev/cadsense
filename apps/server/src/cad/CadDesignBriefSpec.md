# Design briefs: spec

Status: proposal, November 1, 2026. The template and comment removal are prototyped, and one evaluation ran on November 2-3 (see "Evaluation"). When it ships, fold it into [CadDesignBrief.md](CadDesignBrief.md) and add the terms below to `CONTEXT.md`.

A design brief tells review agents what a mechanism is meant to do, so they stop guessing intent from geometry. Cadsense already reads one from `DESIGN.md` (#100). This spec cuts the brief down to what students actually write, gives them a way to create it inside the app, and makes edits reach chats that are already running.

## Problems

1. **Onshape users cannot create a brief.** Onshape projects live in `managed-workspaces/project-<sha256>` (`../workspace/ManagedWorkspaceAllocator.ts`). Project settings hide "Open in Explorer" for Onshape projects (`apps/web/src/components/settings/ProjectSettingsPanel.tsx:291`). The file panel has no new-file action. Nothing in `apps/web` mentions the brief.
2. **The suggested contents ask for what students do not write.** `CadDesignBrief.md` suggests six headings: motion, loads and materials, rulebook limits, repair targets, unfinished work, and purchased parts. The four recorded student prompts say what the mechanism is, what moves, what is missing, and what they plan (`CadReviewEvaluation.md:25`, `:27`, `:597`, `:601`). None gives a load, a limit, a repair target, or a parts list. A template with those headings would reach the agent as empty sections.
3. **Edits do not reach a running chat.** Claude fixes its system prompt at session start (`../provider/Layers/ClaudeAdapter.ts:4460`). Codex sends the brief only on `thread/start` and `thread/resume` (`../provider/Layers/CodexSessionRuntime.ts:2602`). Its per-turn re-read (`CodexSessionRuntime.ts:2787-2809`) goes into `collaborationMode`, which Codex 0.166 replaces, so the model never sees it.
4. **Learnings never reach the chat that created them.** Both providers deliver learnings only when the session starts. Codex re-reads them on every turn (`CodexSessionRuntime.ts:2787-2791`), but it puts them in the same `collaborationMode` text that Codex drops. So a dismissal does not reach the chat it came from.

## Terms

Add to `CONTEXT.md`:

**Design brief**:
The designer's notes on one project's intent: what the mechanism is, what moves, and what is missing or a stand-in in the CAD. `DESIGN.md` at the workspace root unless `designBrief` in `cadsense.json` names another path.
_Avoid_: Spec, config

**CAD guidance**:
What an agent receives about a project before it reviews: the shared review guidance, the design brief, and the review learnings.

## Format

The brief is free-form prose. It has no headings, no fields, and no parser beyond the steps below. Agents are the only reader, and prose matches what students already type in chat.

The reader does three things:

1. It removes `<!-- ... -->` comments, so the template's questions never reach the agent, and a file the student never filled in counts as no brief.
2. It trims whitespace. A file that is empty after that is no brief everywhere: the prompt leaves it out, `cad_context` reports `null`, and the settings row shows "not filled in".
3. It cuts the text at 16 KiB and adds a note that names the file and its size on disk.

### Template

"Create design brief" writes this file. The whole template is one comment, so only the student's own sentences reach the agent. A skipped question leaves nothing behind.

```markdown
<!--
Write below this note. Skip any question you cannot answer.

What is this mechanism, what does it do, and what did you base it on?

What moves, what does it ride on, and what is supposed to move with it?

What is missing, or only a stand-in? Name the parts. "Most bolts are not in yet" is enough. "Everything is WIP" is not.
-->
```

Each question prevents a mistake the agent cannot avoid from the CAD alone:

- **What it is.** The guidance tells agents to understand the reason for design choices before suggesting changes (`../provider/CadReviewInstructions.ts:15`). Both arm prompts open with the mechanism and the design it copies (`CadReviewEvaluation.md:25`, `:27`).
- **What moves.** The matched motor run turned intended stage travel into a loose-mount finding (`CadReviewEvaluation.md:618`). Only the student knows what is supposed to move.
- **What is missing.** Every recorded prompt says which parts are not in yet. The decline rule depends on the user naming the part (`CadChecks.ts:456`). "Everything is WIP" is the kind of wording that led models to drop real defects (`CadReviewEvaluation.md:335-343`).

What the student wants checked in one review belongs in the chat message, not the brief. A brief that says "check the motor supports" would steer every later review toward a question already answered.

### What the template leaves out

| Topic                    | Why the template does not ask                                                                                                                                                                                                                      |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Loads and materials      | No recorded prompt gives a load, an alloy, or a print setting. The guidance already forbids strength claims without a stated load and tells the agent to ask (`CadReviewInstructions.ts:23`), as the pivot run did (`CadReviewEvaluation.md:626`). |
| Size and weight limits   | No recorded prompt gives one, and no recorded review got one wrong. The model is in one pose, so the agent cannot check extension anyway.                                                                                                          |
| Repair targets and tools | No recorded prompt gives one. The guidance already says a fast swap is not a universal requirement (`CadReviewInstructions.ts:18`).                                                                                                                |
| Purchased parts          | The drivetrain check already reads motors, gears, belts, and controllers from vendor part names (`CadDrivetrain.md`).                                                                                                                              |
| Planned changes          | Students mention plans anyway, in prose. Asking for them invites the wording that led models to decline real defects (`CadReviewEvaluation.md:335-343`).                                                                                           |
| Team-wide facts          | See the team brief under "Not now".                                                                                                                                                                                                                |

### Example

```markdown
Telescoping arm for our robot, based on 2910's 2023 arm, without the end effector. It pivots and extends to place game pieces. I moved the motors and added printed supports with wire passages.

The pivot turns the whole arm. The elevator motor is mounted on the first stage, so it travels with the stage on purpose.

Most fasteners are not in the CAD yet. The MaxSpline collars are all in.

I'm planning to lighten the pivot plates.
```

## Precedence

Agents receive the CAD guidance in this order: shared review guidance, design brief, learnings. The brief sits under a heading that names its file.

The brief and learnings describe the design. They do not change the review procedure in the shared guidance, such as how comments are written or when a draft may be declined. When they disagree about the design, this order decides, highest first:

1. The user's current message.
2. The design brief.
3. Review learnings.

The order is fixed rather than newest-wins, because agents receive learnings without dates (`CadReviewInstructions.ts:48-53`). When a learning contradicts the brief, the agent follows the brief and tells the user which learning conflicts, so the user can remove it or fix the brief. When the model contradicts the brief, the geometry is evidence: the agent says what it saw and asks, as the guidance at `CadReviewInstructions.ts:15` already requires.

## Freshness

Session start does not change. The full CAD guidance goes into Claude's system prompt and into Codex's thread `developerInstructions`. The session keeps that guidance (the brief and the learnings) as what it last delivered. A Claude session restart and a Codex thread resume each count as a start.

On each new turn, the adapter does this under one lock per session, so two quick sends cannot both carry one change or both skip it:

1. It reads the brief (`readCadDesignBrief`) and the learnings (`getCadReviewLearnings`). A failed learnings read keeps the last learnings, so it never reads as "all learnings removed".
2. `cadGuidanceUpdate` in `../provider/CadReviewInstructions.ts` compares that with what the session last delivered. If nothing the agent reads changed, the turn input does not change.
3. Otherwise the turn gets an update block that holds only the changed sources: the whole new brief, or the whole current learnings list, or a note that one was removed. It opens with "CAD guidance changed since this chat started. It replaces the matching section of your instructions."
4. The session records the new guidance only after the provider accepts the turn (Codex answers `turn/start`, or Claude's prompt queue takes the message). If the turn fails to start, the next turn sends the block again.

Where the block goes:

- It is its own text item, placed before the user's text. Claude runs a skill only when `/name` starts the last text block (`buildUserMessageEffect`), and Codex finds skills in the user's raw input before the block is added (`buildTurnStartParams`). So the block never moves or changes the user's text.
- A turn with only attachments still gets the block.
- Only the provider sees the block. The chat transcript keeps the user's own text. The settings row and `cad_context` are where a user checks what the agent has.

Which turns never get the block:

- **Steers.** A Claude message sent while a turn runs joins that turn. It carries no block, and the change waits for the next new turn, so a running turn keeps the guidance it started with. A Codex message sent during a turn is queued as its own turn and follows the normal steps.
- **CAD follow-ups.** The Codex follow-up reuses the parent turn's parameters with new input, so it drops the block. The Claude follow-up runs inside the same turn from a Stop hook. Both keep the parent turn's guidance.
- **Subagents.** A subagent sees what the main agent passes it. Nothing tells the main agent yet to pass along brief facts; that is a prompt change and needs the evaluation first.

Each block stays in the chat history for the rest of the session. The model cannot drop the old version. It can only be told to use the new one. A chat pays for each change once, not once per turn.

An edit reaches the next new turn after the editor saves it, which happens 500 ms after the last keystroke (`apps/web/src/components/files/EditableFileSurface.tsx`). Sessions do not restart when the brief changes. Codex's per-turn `collaborationMode` no longer carries the brief or learnings, because Codex 0.166 replaces that text.

Verification: `CadReviewInstructions.test.ts` covers the block (unchanged guidance, an edited brief, new learnings, removals). `Layers/CodexCadTools.test.ts` runs the Codex runtime against the mock app-server and checks the block's position, that it goes once, that a rejected `turn/start` resends it, and that two racing sends carry it once. `CadViewing.test.ts` runs the Claude adapter with a fake query and checks the first turn has no block, an edit reaches the next turn, a steer carries nothing, and the change the steer skipped reaches the turn after it.

Still open: `cad_context` could report `truncated` on `designBrief`, so a user who asks "did you get my brief?" learns whether it was cut.

## Creating and editing

**Entry points.** Three places open the brief in the right panel's file editor, creating it from the template when it is missing (`apps/web/src/components/designBrief/`):

- **Project settings** always show a "Design brief" row above "Review learnings" for CAD projects. Its button reads "Create" or "Edit", and its description follows the brief's state. Settings have no panel, so the button opens the brief in a new thread.
- **The new-thread screen** shows a card under the starting tasks while the brief is missing ("Write brief") or holds only the template ("Finish brief").
- **The CAD panel's title row** shows a "Brief" button once the brief has an answer in it.

The state comes from `designBriefState` in `@cadsense/shared/designBrief`, which uses the same comment stripping as the server reader, so the UI's "filled in" is exactly what reaches agents. The path is `designBrief` from `cadsense.json`, else `DESIGN.md`, as on the server.

## Agent proposals

Students tell the agent lasting facts in chat ("that belt is just a placeholder", "the hood does not move"), and those facts end with the chat. The evaluation found that a sentence naming a stand-in is the brief content that changes reviews, so the agent offers to save it. The agent proposes and the student decides. Agents never write the brief file themselves, because later reviews treat the brief as the user's own words.

**The rule.** Add one rule to `CAD_REVIEW_INSTRUCTIONS`. When the user states a fact that answers one of the template's questions (what the mechanism is, what moves, what is missing or a stand-in), or says something that contradicts a line in the brief, call `cad_brief_propose` once at the end of the reply. Never propose from the geometry alone, and never during a review's steps. This replaces the earlier plan to offer a drafted brief in chat.

**The tool.** `cad_brief_propose({ add, remove })`:

- `add` is a list of `{ text, quote }`. `text` is the sentence to add, in plain words. `quote` is the user's own words it comes from. The server rejects an addition whose `quote` does not appear in a user message of this chat (after whitespace and case folding), so an agent cannot attribute its own inference to the student.
- `replace` is a list of `{ from, to, quote }`, for a fact the user changed. `from` is brief text, usually one sentence of a longer line, that occurs exactly once outside the template comment; `to` changes only what the user said changed; `quote` passes the same check as an addition. Briefs are paragraphs, so this changes a stale sentence without the agent restating the true sentences beside it.
- `remove` is a list of `{ text, reason }`. `text` is a whole line or a sentence within one, occurring exactly once. `reason` says what the user said or what changed in the model.
- Only the main agent proposes; a subagent's call fails and tells it to report what the user said.
- At most 5 changes in all. One proposal is open per chat at a time; a second call while one is open fails and tells the agent to wait. A line the student dismissed in this chat fails if proposed again.
- The tool returns at once ("proposed; the student decides"). The turn does not wait. If the student approves, the brief changes and the next turn carries it through the update block (see "Freshness"). The agent learns nothing on dismissal, which is the point: no arguing.

**Applying it.** Approval runs on the server, not as an editor write. It reads the brief as it is now, appends the added lines below the template comment, deletes the removed lines, and writes. With no brief it creates one from the template first (create-only, as the entry points do). A removed line that the student already deleted counts as done. An open editor on the brief reloads after the write.

**Brief or learning.** The brief holds what the mechanism is, what moves, and what is missing or a stand-in. Review learnings (from dismissals) hold how to review. The tool takes only the first kind. "Do not flag fastener holes" stays a learning.

## cad_checks

No brief content feeds `cad_checks`. The checks read part names, world bounds, transforms, and meshes (`CadChecks.ts:1046`). That data cannot test intent.

The decline rule does not change in v1. `CAD_DRAFT_DECLINE_RULE` (`CadChecks.ts:456`) lets an agent decline a draft when "the user said that part is a placeholder or not modeled yet." The brief reaches agents as the user's stated intent, so agents may already read a brief sentence that names a stand-in that way. The decline arm in Verification measures what they do. Then pick one:

- **If agents decline only the finding that the stand-in explains,** write that into the rule. A part the brief names as missing or a stand-in excuses only the draft its status explains, never an unrelated defect on the same part.
- **If agents decline unrelated defects or follow a stale sentence,** add to the rule that a brief sentence alone is never a reason to decline.

The reasons for caution:

- In `CadReviewEvaluation.md:335-343`, Sol, Luna, and Opus each declined real defects when the prompt described plans. The placeholder evidence is one sentence in the current request, which excused only the belt draft in two rounds (`CadReviewEvaluation.md:257`, `:356-357`). No round put that sentence in a brief.
- A brief sentence is weaker evidence than the same words in the current message, because the student may have written it weeks ago.
- Declines last the session (`CadChecks.md:69`), so removing a stale sentence mid-chat does not bring a declined draft back.

Both versions keep the rule that agents never mention drafts or declined drafts to the student (`CadReviewInstructions.ts:22`). When the brief excuses a finding, the agent names the part and the finding in plain words: "I left the belt alone because your brief says it is a stand-in."

The evaluation (see "Evaluation") points to the first version. With "The 84T belt is just a stand-in for now" in the brief, all 8 runs (4 Opus 5.5, 4 GPT-6-Sol) excused the belt and cited the brief. None cited it for another draft, and the other key findings matched the clean brief. It did not test the unrelated-defect or stale-sentence cases, so the rule text stays unchanged until those run.

## Not now

- **A team brief.** A file of team facts that every project would inherit. Realistically a mentor writes one line a season ("plates are 1/8 in 6061, prints are PETG"), and no recorded review failed for lack of it. It would need its own file, cap, opt-out, editor, and precedence step. Revisit when a review invents a material, standard part, or season limit that the team's own facts would have prevented, or when a team asks to share standards across projects.
- Headings, fields, or questions about loads, materials, limits, repair, purchased parts, tools, or plans. See "What the template leaves out".
- Frontmatter, typed fields, or brief-driven thresholds in `cad_checks`.
- A part-name list in the brief that suppresses findings. A loosely filled list would hide real defects, such as the duplicate plate.
- Moving learnings into the brief. Revisit when a project reaches the 50-learning cap.
- A brief per assembly inside one project.
- Restarting sessions when the brief changes.
- A form or wizard for writing the brief.
- Agents writing the brief file directly. They propose through `cad_brief_propose` and the student approves.
- Recording which brief text each review used.

Revisit when evaluations show misses:

- Custom game-piece names that extend `GAME_PIECE` (`CadDrivetrain.ts:552`), so interference with an oddly named game piece sorts last. This only reorders findings and never hides one. Size S.
- Part-role overrides for custom gears and bearings in `cadDrivetrainRole` (`CadDrivetrain.ts:51`). This needs part selection that stays stable across imports. Size M.

## Rejected alternatives

- **Headings in the template.** Comment removal keeps headings, so a student who answers two of seven sections sends five empty ones. An empty "Limits" heading tells the agent nothing, or suggests there are no limits.
- **Asking students to write "unknown".** It turns a skipped question into text the agent must read. A skipped question now leaves nothing.
- **A team brief inherited by every project.** See "Not now". It needed a file, a cap, an opt-out, an editor, and a precedence step for about one line of content.
- **Deliver edits only through `cad_context`.** Agents call `cad_context` when a review starts, not on every turn, so a follow-up question would still see the old brief.
- **Send the full guidance on every turn.** It repeats up to 16 KiB of brief per message when nothing changed.
- **Send all guidance again on any change.** A new learning would resend an unchanged brief, and every block stays in the chat history.
- **Agents write the brief, the student reviews later.** Unreviewed agent text becomes "the user's intent" for every later review, including the agent's own guesses.
- **Proposals from what the agent saw in the model.** A guess approved in one click is still a guess, and later reviews would excuse findings because of it. The quote check limits additions to what the student said.
- **Let the reader return learnings too.** Learnings come from the orchestration database, and `cad_context` reads files only. Each adapter already has the learnings.

## Build order

1. **Make edits reach running chats.** Done: the update block in both adapters with its lock, the steer and follow-up rules, the removed Codex write, and the doc fixes. The subagent sentence waits for the evaluation.
2. **Put the brief in the app.** Size S. Built: the three entry points, the template, and comment removal. Still open: the `truncated` field.
3. **Run the decline arm, then settle the rule.** Size S. Instruction text only.
4. **Agent proposals.** Built: the tool for both providers, the quote check, server-side apply, card A from the mocks, and the rule. Still open: the proposal arm in Verification, and an "Edit first" button that opens the brief with the changes applied but unsaved.

## Verification

### Ways the reader and freshness can fail

Write tests for these in `CadDesignBrief.test.ts` and the adapter tests before writing the code:

- An untouched template, or a file with only comments, counts as a brief.
- A partly filled template sends the unanswered questions to the agent.
- A truncation note does not name the file, or `cad_context` reports a cut brief as whole.
- A turn with unchanged guidance gets the block.
- A turn after a brief edit or a new learning does not get the block.
- A block resends an unchanged brief, or unchanged learnings. A changed learnings list goes whole: learnings are one line each, and a whole list is the plain way to say one was removed.
- One change sends the block on more than one turn.
- A turn that fails to start still records the revision, so the update is lost.
- Two quick sends deliver the block twice, or deliver an older revision after a newer one.
- A Claude steer carries the block.
- A Codex or Claude CAD follow-up carries the block.
- The block stops a `/skill` at the start of the user's text from running, or shows up in the chat transcript.
- A turn with only attachments gets no block.
- After a session restart or Codex thread resume, the next turn sends the block again even though the start already sent that revision.
- Codex still writes CAD guidance into `collaborationMode`.
- A path outside the workspace is read. An existing test covers this.

### Ways proposals can fail

Write these as tests before the code:

- An addition whose quote is not in a user message of this chat is accepted.
- An addition quotes an assistant message, or a message from another chat.
- A removal names a line the brief does not have, and the server deletes something else.
- Approving overwrites edits the student made after the proposal, or an open editor saves over the approved write.
- Approving with no brief replaces a brief created in the meantime.
- A second proposal opens while one is pending, or a dismissed line comes back in the same chat.
- An approved change does not reach the next turn.
- The agent proposes from geometry alone, or proposes a review rule that belongs in learnings. (Evaluation, not unit tests.)

The proposal arm runs scripted chats on the Ultimate Ascent transfer. In some, the student states a stand-in or what moves; in others the student says nothing lasting. Measure how often the agent proposes when it should and when it should not, whether each line keeps the student's meaning, and whether an approved line changes the next review as a hand-written one did.

### End to end

Extend `apps/server/scripts/cad-app-review-e2e.ts`:

- `--brief <file>` writes `DESIGN.md` before the chat starts.
- `--edit-brief <file>` with `--second-prompt <file>` replaces the brief after turn 1 and sends turn 2.
- `--restart-between-turns` restarts the provider session after turn 1.
- `summary.json` records, for each turn, the guidance revision delivered, whether the block was sent, and the context cost it already reports. The run keeps the raw turn text sent to the provider.

The two-turn run passes when turn 1's text has no block and turn 2's text has the edited brief once. Compare turn 2's context cost with a run that has no edit.

Unit tests cannot show what a provider does with new instructions on resume. So run the restart case behind the logging proxy that `CadReviewEvaluation.md` describes. It passes when the request body after the restart holds the edited brief in the session instructions and turn 2's text has no block.

For review quality, follow `CadReviewEvaluation.md` on the telescoping arm with the models from its latest recorded check. Run three arms: no brief, the example brief, and a brief with only the sentence about what moves. The third arm checks that a partial brief does no harm.

The decline arm settles the rule in "cad_checks". It runs on the Ultimate Ascent transfer (`CadReviewEvaluation.md:96`), which has the 84T belt and the duplicate plate. Its brief says the 84T belt is a stand-in and calls the whole mechanism a work in progress. Run three cases:

- **Stand-in.** Passes when only the belt draft is declined and the reply names the belt in plain words.
- **Unrelated defect.** The brief also says the duplicated plate is a stand-in. Passes when the duplicate is still published.
- **Stale sentence.** The brief says a modeled part with a proven defect is not in yet. Passes when the defect is published and the reply says the brief looks out of date.

## Evaluation

November 2-3, 2026, on the Ultimate Ascent transfer, with the prototype reader and the review harness's new `--workspace` and `--brief` flags. Every arm asked "Can you review my transfer?" except one that typed the brief's sentences into chat. Opus 5.5 and GPT-6-Sol each ran 19 reviews: 4 per arm, 2 with the template sent unstripped, 1 with the untouched template. Blind graders: Grok 4.7 on every review, Muse Wonder on 12. Every run's logged requests confirmed what each model received.

- **No harm to the answer key.** With the clean brief, Opus scored 7.50 of 8 against 7.75 with none, and Sol 7.50 against 7.88. Both are inside the half-point noise this transfer shows; the grader's own regrade moved totals by 0.30 on average.
- **The untouched template is a no-op.** Its CAD guidance was byte-identical to no brief for both providers.
- **Stripping matters.** Sent as plain text, the template's questions cost Opus 0.75 on the key in two runs, and one reply told the student "Your design brief is still the blank template." Sol was unaffected.
- **Benefit not proven by the pre-registered test.** Under Grok, no review without context used the transfer's job (0 of 14), and most with context did. Grok repeated its own scores exactly, but the second grader matched it on only 6 of 12, so this measure did not count.
- **Exploratory: reviews with the job in context checked the disc's path.** 22 of 24 runs with the brief or the same sentences in chat flagged screw heads or rim contact along the disc's path, against 4 of 14 without (Opus 11/12 versus 3/7, Sol 11/12 versus 1/7). This count was defined after unblinding; make it a pre-registered measure next round.
- **Channel, for Codex.** Sol used the job more often when the sentences came in chat (4 of 4) than in the brief (1.5 of 4 by score). If that holds up, look at how Codex receives the brief in thread developer instructions.
- **A named stand-in excused only itself.** See "cad_checks".

### Proposals

November 25, 2026, 22 reviews (Opus 5.5 and GPT-6-Sol) through the same harness. Saying nothing lasting led to no proposal in 6 of 6 runs. A stated stand-in led to a faithful one-line proposal quoting the student in 10 of 10, with or without a brief, always after the review's comments were published. A stated change to a fact in the brief ("We switched it to 3 inch rollers") broke the line-level design: the stale sentence shares a line with three true ones, all 3 Opus runs first tried to remove just that sentence and were refused, and 5 of 6 runs then removed the whole first paragraph. Two would have deleted true claims, three restated the paragraph under a quote that does not contain it, and one added the new size beside the old. That led to `replace` and sentence-level `remove`. A rerun of the contradiction case (3 runs per model) proposed exactly one sentence replacement in 6 of 6, leaving the rest of the paragraph alone, and the stand-in case still gave one faithful line in 2 of 2.

Untested here: the "what moves" question (this model has no stage-mounted motor), the unrelated-defect and stale-sentence decline cases, and edits mid-chat.
