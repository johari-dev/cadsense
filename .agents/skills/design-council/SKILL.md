---
name: design-council
description: Hill climb the Cadsense UI against a council of reviewer models that score screenshots. Use when asked to redesign, polish, or "hill climb" the app's look, or to score the UI against other apps.
---

# Design council

A design hill climb: capture the same app screens every round, have reviewers from three model
providers score them per category against peer apps, fix what they flag, and repeat until every
reviewer rates every category at or above the bar. Scores are vibes, not a test. A 9 from three
providers at once is still hard to get without real improvement.

## Fixed inputs

Keep these the same for every round so scores compare.

- **Screens.** `apps/server/scripts/design-capture.ts shoot` writes `NN-<screen>.png` at
  1440x900 and a `manifest.json` that says what each screen shows. Do not hand-pick screenshots.
- **Fixture.** One seeded home, built once with `design-capture.ts seed` (real agent turns on the
  dm1 bracket assembly). Keep it under `.cadsense/hillclimb/` (ignored by git). Never point it at
  `~/.cadsense/userdata`.
- **Baseline.** Shoot `main` once into `rounds/r00-baseline` before any change.
- **References** in `.cadsense/hillclimb/references/`:
  - `t3code-upstream.png`. Cadsense is a T3 Code fork. It must not look like this.
  - Peer app shots (Claude desktop, Codex app, others the user adds). Name the peer in the
    file name. Reviewers also know these apps; name them in the brief even without a shot.

## Setup

```bash
vp run dev --home-dir "$PWD/.cadsense/hillclimb/home"     # tracked background process
# read webPort from the [dev-runner] line in its output
CADSENSE_CHROMIUM_PATH=<chrome> node apps/server/scripts/design-capture.ts seed \
  --url http://localhost:<webPort>/ --fixture .cadsense/hillclimb
CADSENSE_CHROMIUM_PATH=<chrome> node apps/server/scripts/design-capture.ts shoot \
  --url http://localhost:<webPort>/ --fixture .cadsense/hillclimb --out .cadsense/hillclimb/rounds/r00-baseline
```

The dev server hot reloads, so a round is: edit, `shoot` into a new `rounds/rNN`, look at the
shots yourself, then convene the council.

## The council

Call `orchestrator_capabilities` and pick the latest model in each family. Do not hardcode IDs.

| Seat | Model family | Route |
| --- | --- | --- |
| Fast | GPT Sol (Codex) | `codex` provider |
| Strict | Claude Opus | `claudeAgent` provider |
| Third opinion | Muse Wonder | `cursor` provider |
| Jester | Gemini Argon | `cursor` provider, if available |

- Start each reviewer with `delegate_task` (`role: "review"`, `mode: "async"`), one per seat,
  a fresh task every round. Reviewers are read-only and start no subagents.
- **Stage the seats to save tokens.** Run only Sol until it rates every category at or above the
  bar. Then add Opus. Add Muse once Sol and Opus both pass. A reviewer that already passed comes
  back once the others are in, to confirm the final state.
- **The jester.** Give Gemini the same brief. Ignore its scores. Never wait on it. Never put its
  scores in a PR. In the final reply only, list anything funny it said or did under "Gemini flubs".
- **Do not tell reviewers the target score** or that a bar exists. Knowing it inflates scores.
- Treat findings as hypotheses. Fix what you agree with. Decline the rest with a reason in the
  ledger. Don't chase one reviewer's taste if it breaks another's top finding.

## Reviewer brief

Children get no history. Send this, with paths filled in:

```
Review only. Do not edit files, run the app, commit, or start subagents.
You are a senior product designer reviewing Cadsense, a desktop app where engineers chat with an
AI agent about their CAD models (Onshape, SolidWorks, STEP). It is a fork of T3 Code.

Open every image below with your image viewer tool before you score.
Current Cadsense screens: <round dir>/*.png  (manifest.json says what each one shows)
Original Cadsense screens (before this redesign): <baseline dir>/*.png
T3 Code, the app Cadsense forked from: <references>/t3code-upstream.png
Peer apps: <references>/<peer>*.png. Also compare against what you know of the Claude desktop
app, the Codex app, and Linear.

Score 1-10 (decimals allowed) for Cadsense current, Cadsense original, T3 Code, Claude desktop,
and Codex app, in each category:
hierarchy, typography, color-and-contrast, spacing-and-layout, iconography, consistency,
polish, identity (reads as its own product made for CAD work, not a T3 Code reskin).
Base the scores only on what you see. Then list the top problems in the current screens, worst
first, each with: screen file, what is wrong, a concrete fix (values where you can: sizes,
colors, weights, spacing).

Reply exactly:
SCORES
| app | hierarchy | typography | color-and-contrast | spacing-and-layout | iconography | consistency | polish | identity |
...
FINDINGS
D1 <screen> <problem>. Fix: <fix>
...
```

## Constraints on the design

- Keep the neutral dark theme as the base: near-black neutral surfaces, white primary text.
  Color is for meaning (selection, status, primary action, brand), not decoration. Do not let it
  drift to all-gray: an earlier hill climb on T3 Code got too grayscale.
- Change the token layer first (`apps/web/src/index.css` `--app-theme-*`, radius, fonts), then
  components. Keep the semantic tokens; components should not gain raw colors.
- No continuously repainting animations (pulse, shimmer, spinners) as decoration.
- Keep behavior, labels used by tests and e2e scripts, and accessibility names unchanged unless
  the change is the point.

## Ledger and stopping

Keep `.cadsense/hillclimb/ledger.md`: one row per round with each seat's per-category scores for
Cadsense current and the peers, plus what changed and which findings were declined. Copy the
round table into the PR description (no jester scores).

Done when, in the same round, every active seat rates every category at or above the bar the
user set (default 9), and Cadsense current scores at or above every peer app on average.
Report the rounds, the cost if the tools expose it, and what a person should still eyeball.
