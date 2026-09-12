# Initial CAD load implementation results

September 12, 2026. Implements the lossless delivery experiment in
[the research pass](CadInitialLoadResearch.md). Measurements use the existing full
robot snapshots in the isolated comments-test environment, through the Tailscale
preview. No new Onshape export or ingestion was performed.

## What changed

- A versioned transfer artifact shares identical GLB BIN chunks and applies
  lossless meshoptimizer codecs. No quantization, geometry simplification, or
  partial-scene publication is introduced. The browser reconstructs each original
  GLB and verifies its SHA-256 before passing it to the existing renderer.
- The server persists prepared 4 MiB raw/Brotli ranges, keyed by codec version and
  source identity. Completed import acquisition prepares this derived cache before
  returning; existing snapshots prepare on demand. Preparation remains a real
  import/first-open cost. Process restarts reuse the artifact.
- Original browser cache entries remain usable. New transfer entries have a
  separate representation namespace. Missing, unsupported, or corrupt optimized
  delivery falls back to the original bundle; scene cancellation does not retry.
- Snapshot verification uses at most four assets and 32 MiB per cohort, with
  oversized assets alone. Existing integrity checks and pin/removal exclusion
  remain in place.
- Shared cold preparation holds an independent source pin until every writer
  settles, even if the initiating HTTP request or scene closes. Active scene
  artifacts cannot be evicted. Cache hits avoid another source verification scan.
- Historical review intent now survives panel remounts in a bounded, thread- and
  environment-scoped session store. This preserves the selected revision and
  return camera/framing when the panel closes during loading.

Derived server storage is capped at 1 GiB with a 2 GiB free-space reserve and
atomic publication after all writes finish. Browser range storage remains capped
at 512 MiB. Reconstruction retains at most 32 MiB of prefixes and 64 MiB of shared
BINs; larger cases use original delivery. Range prefetch remains four 4 MiB
requests. Preparation overlaps at most three compression/write jobs with at most
12 MiB of raw transfer staging, leaving capacity for verified source reads. These
are explicit buffer/cache limits, not a measured total-process
memory ceiling.

## Exact reconstruction

Production encoder/decoder verification checked all 929 distinct assets across
the two full robot revisions against original bytes and SHA-256:

| Revision   | Distinct assets | Original GLBs | Transfer blob before HTTP compression | Decoder CPU |
| ---------- | --------------: | ------------: | ------------------------------------: | ----------: |
| Current    |             462 | 202,050,012 B |                          90,865,179 B |      253 ms |
| Historical |             467 | 322,976,716 B |                         119,851,604 B |      444 ms |

These are offline Node stage measurements. They exclude HTTP, Brotli preparation,
and browser rendering. Manifest identities still describe all 467 geometry assets
and 1,362 tree entries in the current robot. Reproduction and detailed results:
`.scratch/cad-initial-load/production-codec.mjs` and
`production-codec-results.json`.

## Browser measurements

The readiness observer waits for the complete-scene UI after renderer publication;
screenshots verify the rendered robot. It does not measure the physical display's
presentation timestamp. Fresh-visit samples clear only the browser's CAD range
cache and navigate a fresh document; server artifact preparation is labeled
separately. Times start at navigation and include startup and authorization.

Final build: `index-C9x_yuyZ.js`. Three prepared-server, empty-browser-cache runs
per representation:

| Delivery                    | Complete-scene times     |   Median | Encoded bytes including metadata |
| --------------------------- | ------------------------ | -------: | -------------------------------: |
| Original GLB bundle         | 28.113, 25.063, 26.519 s | 26.519 s |                     83,043,160 B |
| Lossless optimized transfer | 15.410, 17.977, 17.112 s | 17.112 s |                     57,361,364 B |

The measured median improved **35.5%**, with **30.9% fewer transferred bytes**.
The control forces the existing fallback by returning an unavailable
transfer-index in browser instrumentation; it uses the same final app and server,
with already-prepared legacy ranges. No production feature flag was added.
Optimized runs use 22 geometry requests plus the manifest and index; original
runs use 49 geometry requests plus the manifest. None had browser errors, context
loss, or client socket closes. Connection/workstation variability remains; these
are local samples, not a latency guarantee.

An earlier three-run optimized series took 18.053, 17.959, and 17.987 seconds.
A separate final-build stress run with three panel toggles during loading took
23.149 seconds, with the same 22 geometry requests and one surviving canvas.

Reloading the final app with persisted optimized ranges took **4.013 seconds**,
with **zero geometry HTTP requests**. Only the manifest and index transferred
(234,457 encoded bytes). This is one warm-browser sample.

The earlier first open without a derived server artifact took **37.836 seconds**;
the transfer-index request occupied **14.964 seconds** of that run. This was the
initial serial preparation implementation, before preparation pipeline changes.
It must not be represented as an 18-second newly imported model. New-import
export/download/normalization latency has not been measured in this pass.

Final three-job preparation took **10.512 and 12.411 seconds** in isolated
actual-store measurements, versus **14.490 and 23.970 seconds** for alternating
serial controls. The workstation showed substantial I/O variability. These
measurements exclude the browser and do not establish the final unprepared
end-to-end time. New imports pay preparation before acquisition returns; existing
snapshots with no derived artifact pay it on first optimized open. The server
retains the result across restarts. See
`.scratch/perf-server/transfer-pipeline-results.json`.

Browser evidence is retained under `.scratch/cad-initial-load/browser-*.json`.

## Browser regressions and validation

- Current and historical full-robot loads survive three panel close/reopen cycles
  each. Historical revision selection, its battery comment, and one canvas remain
  intact. The historical run loaded all 1,362 tree entries and displayed its marker.
- Resolve, reopen, dismiss, and reopen on the historical battery comment issued
  no additional CAD requests. The fixture comment was restored to open.
- Closing/reopening comments, switching to the motor project and back, three
  same-project thread round trips, and a current/historical revision round trip
  completed without errors or context loss. Cached geometry was reused; some
  scene changes still request authorized metadata.
- Switching to the motor project during a cold robot load and returning completed
  successfully through optimized delivery, with no original-bundle fallback.
  Cancelled incomplete ranges may be fetched again when returning.
- Injecting a failed optimized range recovered to the full original scene in
  23.167 seconds with no unhandled browser error. Unit tests separately verify
  corruption rejection and cache invalidation.

Final checks: **144 web CAD tests, 136 server CAD/acquisition tests, and 9 shared
transfer tests passed (289 total)**. Web/server/shared typechecks, changed-file
lint/format checks, and production web build passed. Lifecycle tests cover
coalesced preparation after initiating-scene release/HTTP abort, active-artifact
retention under a tiny disk budget, writer cleanup, source
corruption, cancellation, codec bounds, and exact reconstruction.

Browser heap samples were collected in the evidence, but total resident memory
and GPU memory were not profiled. No claim of a measured whole-process memory
ceiling or a new-import Onshape latency improvement is made.

## Snapshot verification stage

Five alternating actual-store comparisons measured pin medians of **1,745 to
1,012 ms** for the current revision and **2,424 to 1,769 ms** for the historical
revision. These isolate store verification; they are not end-to-end browser
speedups. See `.scratch/perf-server/STARTUP_IMPLEMENTATION.md` and
`startup-compare.json`.
