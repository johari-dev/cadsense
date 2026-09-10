# Kraken mesh detail experiment — 2026-09-10

Coarse 3MF is sufficient for the five tested Kraken screw-hole locations. Fine increases download size almost ninefold and processing time about sixfold, with little improvement relevant to these comment anchors. This supports testing coarse as a default for visual findings; it does not establish a universal mesh tolerance or justify using meshes for manufacturing measurements.

## Controlled input and API usage

Used the small [Kraken assembly](https://cad.onshape.com/documents/2cad51ee956f732494213c6e/v/711fcc0deca72ba0961f4d40/e/64a06775f2e4cd5bca8709c3), not the full robot. Submitted three 3MF exports against that identical immutable version, with the PoC's settings: meters, grouping enabled, `allowFaultyParts: true`. Only `resolution` changed between `coarse`, `medium`, and `fine`. These are supported [Onshape export detail choices](https://cad.onshape.com/help/Content/File/exporting_files.htm).

**Exactly 9 HTTP requests to Onshape**, all successful: one submission, one status poll, and one download per level. Polls were deliberately spaced 20 seconds apart. No automatic retries, model reimports, or further Onshape requests were used. Rate-limit remaining headers were absent, so the result is a recorded request count, not an independently verified quota-balance delta.

## Results

| Export | Download, decimal MB | Unique triangles | Median processing, seconds | Maximum hole-profile difference from fine |
| ------ | -------------------: | ---------------: | -------------------------: | ----------------------------------------: |
| Coarse |                1.274 |           79,990 |                      1.314 |                                0.01331 mm |
| Medium |                3.023 |          190,326 |                      2.473 |                                0.00333 mm |
| Fine   |               11.362 |          724,512 |                      7.857 |                                 Reference |

All three have the same three unique meshes and five rendered part instances. Instanced triangle totals are 80,470 / 191,254 / 726,816. Expanded archive sizes are 6.732 / 15.959 / 61.844 MB.

Processing uses the actual PoC parser and shared-geometry builder, a fresh module worker per sample, and Three.js rendering in the controlled browser. Three repetitions per level, with rotated order; medians above exclude network transfer and Onshape export time. Input bytes were already downloaded. A reused WebGL context means shader compilation is warm, although each new geometry is uploaded; `gl.finish()` includes GPU completion. Ranges were 1.286–1.476 / 2.339–2.511 / 7.817–7.981 seconds. These are an isolated parser/render experiment, not full application navigation times. The first network-inclusive run was noisy and is not used as comparative evidence.

## Hole and anchor checks

Cold page reloads were much less stable than the repeated, already-downloaded-byte benchmark: two observed per-level fetch-to-first-frame passes were 8.54 / 15.88 / 18.04 seconds and 8.19 / 18.00 / 60.55 seconds (coarse / medium / fine). Fine worker parsing alone varied from 7.83 to 48.76 seconds. The cause of this browser/runtime variability was not isolated. Keep these observations alongside the warm medians; **the 1.31 / 2.47 / 7.86 second figures are not cold-load promises**. File-size and geometric-comparison results do not depend on these timing fluctuations.

Inspected the five exposed flange holes at 90, 60, 30, 0, and -30 degrees around the 25.4 mm bolt-circle radius. Intersected each exported mesh at assembly Z = -0.25, -1, and -2 mm, then measured radial distance to each hole wall in 360 directions. All **5,400 samples per export** found a wall; no tested hole was missing. Compared matching samples to fine, not to an exact CAD/B-rep oracle. Mean differences were 0.00791 mm coarse and 0.00176 mm medium; maxima are in the table.

Also replayed five previously published, alternate-view-verified Kraken comment anchor points, transformed from the motor part into assembly coordinates. Maximum distance to the exported surface was **0.01065 mm coarse**, 0.00153 mm medium, and 0.00237 mm fine. Fine is not necessarily closest to these points because the original anchors were selected on another tessellation.

Manual visual review of matched top and angled close-up renders retained all five visible openings at every level. This was visual and geometric testing, **not a rerun of the complete agent comment-publishing workflow**. It does not prove unchanged detection accuracy for arbitrary tiny features, threads, gears, or other models.

## Separate appearance limitation

The coarse archive contains 16 color elements and 15,446 triangle tags with material attributes, but the PoC parser assigns a single material to each parsed mesh and ignores triangle-level assignments. Its resulting motor looks gray. This is a parser limitation independent of resolution; adopting the lower-detail geometry should not carry over that loss of appearance information.

## Reproduction and artifacts

Retained original exports, sanitized request ledger, metrics, geometry samples, browser benchmark results, and the hole close-up image in `.scratch/detail-levels/`. No credentials are stored there; `download.mjs` reads the existing isolated preview connection in memory. It skips completed downloads and has a hard 15-request ceiling. Do not delete its checkpoints and rerun casually.

- `node .scratch/detail-levels/analyze.mjs`: six offline parser/build runs per level, first omitted. Node timings are recorded separately from the browser values above.
- `node .scratch/detail-levels/probe.mjs`: reconstruct hole sections and distances to existing comment anchors; reads the isolated preview database without writing it.
- `node .scratch/detail-levels/check.mjs`: checks request counts, matching mesh inventories, complete radial samples, and browser repetition counts.
- `server.mjs`, `index.html`, `view.mjs`, and `worker.mjs`: isolated visual comparison, using locally retained exports. The server explicitly serves only experiment files and library modules, not connection data or job checkpoints.
- `parser.mjs` and `limits.mjs`: transpiled snapshots of `D:/Projects/cadsense/apps/web/src/lib/cadThreeMfFastParser.ts` and `cadThreeMfResourceLimits.ts`; no application source was changed.

Preview during this investigation: `https://zephyrusg16-1.tailf2c6b7.ts.net:10001/` (tailnet only; process 38084, loopback port 18117). Main app preview port 10000 remains unchanged.
