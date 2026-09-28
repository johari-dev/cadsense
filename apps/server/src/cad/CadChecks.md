# CAD checks

`cad_checks` is the deterministic pass that runs before the agent looks. Like a linter feeding a code review, it scans the pinned snapshot of the selected root and returns candidate findings with occurrence IDs. The agent verifies each lead visually and writes comments with evidence; the tool never proves interference on its own.

## Checks

Every finding carries the check name, the involved occurrence IDs and names, numbers in meters, and a one-line explanation of what it does and does not prove.

- `mesh-interference`: pairs of unsuppressed part occurrences whose solids actually intersect by more than one cubic millimeter, computed with exact mesh booleans on the stored triangles. Reports the intersection volume, its fraction of the smaller solid, and `withinSubassembly`. Pairs that share a parent subassembly other than the root (a vendor kit's screw and nut, a motor and its own shaft) are usually the kit author's modeling choice, so they sort after every cross-subassembly pair; each group is ordered by volume, largest first. This is the default overlap check.
- `overlapping-bounds`: pairs of unsuppressed part occurrences whose world-space axis-aligned bounding boxes overlap by more than one cubic millimeter. Reports the overlap box size, volume, the overlap fraction of the smaller box, and whether one box lies fully inside the other. Findings are ordered by overlap volume, largest first. Fasteners in holes and parts in pockets overlap too, so the explanation says the result is a lead, not proof.
- `coincident-instances`: two occurrences of the same source part whose transforms differ by at most one micron per element, which usually means a duplicate insertion.
- `degenerate-geometry`: part occurrences whose bounds are unavailable (`size: null`) or thinner than 0.1 micron on some axis. Surface bodies trigger this on purpose.

Suppressed occurrences and everything under a suppressed assembly are skipped. Explosion is ignored; boxes use the original placement.

## Bounds

The manifest caches no bounds, so `CadChecks.ts` reads them from each stored GLB once per asset hash and keeps them for the activation. It composes the glTF default scene's node matrices (or TRS) onto each `POSITION` accessor's `min`/`max`, so no vertex data is decoded. Assets over the 128 MiB per-part limit, normalized accessors, cyclic node graphs, and unreadable containers produce unknown bounds; those occurrences count in `summary.boundsUnknown` and appear in `degenerate-geometry`. `mesh-interference`, `overlapping-bounds`, and `degenerate-geometry` read bounds; only `mesh-interference` also reads triangles, per call rather than cached, since they are needed only while intersecting. A `coincident-instances`-only call touches no assets.

## Mesh interference

Bounding boxes overlap for shafts in holes, parts in pockets, and every part near a tilted game piece, so on an 88-part transfer `overlapping-bounds` returns 312 leads and agents skip the real ones. `mesh-interference` uses the bounding-box sweep only as the broad phase, then intersects the two solids with `manifold-3d` (WASM, Apache-2.0). Intended fits touch at zero volume, so on the same transfer 70 pairs remain and the overlapping duplicate plate and the duplicated roller shafts lead the list.

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

## Registration

`CAD_TOOL_INPUTS` in `packages/contracts/src/cadTools.ts` declares the input; `CadProviderTools.ts` describes it, lists it as read-only, and routes it to `CadAgentTools.checks`, which `CadViewing.ts` implements inside the activation. Codex and Claude receive it with the other CAD tools; `CAD_REVIEW_INSTRUCTIONS` tells agents to run it early, explain each exact interference finding, and never publish an interference comment from bounds overlap alone. Without `checks`, a call runs `mesh-interference`, `coincident-instances`, and `degenerate-geometry`; `overlapping-bounds` runs only on request.

## Verification

- `CadChecks.test.ts` covers the mesh interference failure list above against real triangle GLBs and the WASM kernel, plus glTF matrix and TRS composition, unreadable containers, overlap size and volume, touching faces, containment, occurrence rotation, suppressed subtrees, duplicate and near-miss placements, flat and unknown bounds, the sweep against brute force on 300 random boxes, the budget cutoff and its determinism, bounds caching, cursor binding, revision conflicts, and malformed input.
- `CadViewing.test.ts` runs `cad_checks` through the real activation and provider tool path with a stored GLB, checking the default exact finding, that bounds are read once per activation while triangles are read per call, and that stale revisions conflict.
- `cadHttp.test.ts` and `CodexCadTools.test.ts` enumerate the nine registered tools and the read-only set.
