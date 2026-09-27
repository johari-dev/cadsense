# CAD checks

`cad_checks` is the deterministic pass that runs before the agent looks. Like a linter feeding a code review, it scans the pinned snapshot of the selected root and returns candidate findings with occurrence IDs. The agent verifies each lead visually and writes comments with evidence; the tool never proves interference on its own.

## Checks

Every finding carries the check name, the involved occurrence IDs and names, numbers in meters, and a one-line explanation of what it does and does not prove.

- `overlapping-bounds`: pairs of unsuppressed part occurrences whose world-space axis-aligned bounding boxes overlap by more than one cubic millimeter. Reports the overlap box size, volume, the overlap fraction of the smaller box, and whether one box lies fully inside the other. Findings are ordered by overlap volume, largest first. Fasteners in holes and parts in pockets overlap too, so the explanation says the result is a lead, not proof.
- `coincident-instances`: two occurrences of the same source part whose transforms differ by at most one micron per element, which usually means a duplicate insertion.
- `degenerate-geometry`: part occurrences whose bounds are unavailable (`size: null`) or thinner than 0.1 micron on some axis. Surface bodies trigger this on purpose.

Suppressed occurrences and everything under a suppressed assembly are skipped. Explosion is ignored; boxes use the original placement.

## Bounds

The manifest caches no bounds, so `CadChecks.ts` reads them from each stored GLB once per asset hash and keeps them for the activation. It composes the glTF default scene's node matrices (or TRS) onto each `POSITION` accessor's `min`/`max`, so no vertex data is decoded. Assets over the 128 MiB per-part limit, normalized accessors, cyclic node graphs, and unreadable containers produce unknown bounds; those occurrences count in `summary.boundsUnknown` and appear in `degenerate-geometry`. Only `overlapping-bounds` and `degenerate-geometry` read geometry; a `coincident-instances`-only call touches no assets.

## Budget and paging

The overlap check sorts boxes by minimum X and sweeps, so a 577-part assembly evaluates a few thousand candidate pairs instead of 166k. Candidate evaluations stop at `summary.pairBudget` (250k) and `summary.budgetExhausted` tells the agent the pass was partial. Findings are deterministic for a given snapshot and check selection, so cursors are plain offsets bound to `snapshotId` and the selected checks, the same scheme as `cad_hierarchy`. Pages default to 50 findings and cap at 100. `expectedRevision` must match the private view revision.

## Registration

`CAD_TOOL_INPUTS` in `packages/contracts/src/cadTools.ts` declares the input; `CadProviderTools.ts` describes it, lists it as read-only, and routes it to `CadAgentTools.checks`, which `CadViewing.ts` implements inside the activation. Codex and Claude receive it with the other CAD tools; `CAD_REVIEW_INSTRUCTIONS` tells agents to run it early and never publish an interference comment from bounds overlap alone.

## Verification

- `CadChecks.test.ts` covers glTF matrix and TRS composition, unreadable containers, overlap size and volume, touching faces, containment, occurrence rotation, suppressed subtrees, duplicate and near-miss placements, flat and unknown bounds, the sweep against brute force on 300 random boxes, the budget cutoff and its determinism, bounds caching, cursor binding, revision conflicts, and malformed input.
- `CadViewing.test.ts` runs `cad_checks` through the real activation and provider tool path with a stored GLB, checking that bounds are read once per activation and that stale revisions conflict.
- `cadHttp.test.ts` and `CodexCadTools.test.ts` enumerate the nine registered tools and the read-only set.
