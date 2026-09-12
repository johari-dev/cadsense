# Initial CAD load research — September 12, 2026

The remaining first-visit cost needs to be reduced before the geometry reaches the browser. Browser persistence fixes repeat visits, but cannot eliminate a new device's first transfer. The strongest candidates preserve the complete scene: prepare a smaller lossless representation before the viewer opens, remove repeated verification from the critical path where integrity guarantees permit it, and measure the browser's remaining work independently of transport.

The subsequent implementation and measured outcomes are recorded in
[Initial CAD load implementation results](CadInitialLoadResults.md). The research
measurements below remain labeled as offline experiments.

This is a research note with offline size and reconstruction measurements, not a production change or a measured browser speedup. No Onshape requests were made for this pass. Findings below distinguish existing browser evidence, new offline measurements, and proposed experiments. The user's earlier requirement remains complete-scene publication at the imported review detail; a coarse placeholder is not counted as ready.

## Current implementation and measurement boundaries

The current robot contains 467 geometry assets and 1,362 component-tree entries. Deduplicated GLB bytes total 202,050,012, compared with 322,976,716 in the older full-detail revision. The current import uses 324 geometries from 3MF and 143 identity-verified fallback geometries; therefore a bare 3MF is not yet an equivalent complete-scene benchmark. See [the import evidence](CadThreeMfImport.md).

At review time, `CadPreparedTransfer.ts` prepares Brotli quality 5 in bounded 4 MiB ranges, retaining prepared responses in a bounded memory cache. `panelHttp.ts` starts warming when the manifest is requested and validates a scene ticket before serving geometry. Preparation is not a persistent import artifact, so the first request after a process restart can still perform encoding. `CadSceneRenderer.ts` fetches ahead, parses GLBs, and publishes the candidate only when every asset is ready.

The [earlier investigation](CadLoadPerformance.md) already tried exact BIN deduplication and attribute-aware encodings on the older 323 MB revision. Those results are useful controls, not new evidence for the current 202 MB revision. Node parsing times also exclude browser decompression, WebGL uploads, shader compilation, and the user's remote link.

Record separately: new-import preparation, cold-server first response, cold-browser transfer, decode/scene construction, and first complete rendered frame. A cold browser against precomputed server bytes is a valid first-device test, but must be labeled separately from first open immediately after import.

## Lossless delivery candidates

### Prepare and persist the delivery artifact

The smallest integration change is to retain the existing geometry and HTTP representation while preparing compressed ranges during import publication or bounded background preparation. Persist derived bytes using a key containing source hashes, ordered lengths, range layout, and encoder version; retain ticket checks on every read. Treat missing, corrupt, or obsolete artifacts as regenerable cache misses. This is an inference from the current code, not an external benchmark.

Compare prepared Brotli with Zstandard on the exact current data. HTTP permits negotiation through `Accept-Encoding` and reports the chosen representation through `Content-Encoding`; browser JavaScript cannot force this forbidden request header. A Zstandard experiment therefore needs real client negotiation, not a universal browser-support assumption. Preserve gzip/identity fallback. [HTTP negotiation reference](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Accept-Encoding)

Do not add a costly encoder to the first-response path merely because its output is smaller. Measure preparation and transfer together for a newly imported model, then independently for a new browser opening existing CAD. Persistent preparation improves the latter and removes repeat preparation after restarts; it does not make import computation disappear.

### Exact geometry deduplication and meshopt

Meshoptimizer's vertex codec is lossless by itself, while quantization and filters are separate transformations. Its triangle index codec can rotate a triangle's vertex order, so it is not suitable for byte-for-byte GLB reconstruction without accommodation. Its documentation also warns that unoptimized floating-point input can compress poorly. A meaningful exact experiment keeps all float bits and metadata, uses no lossy filters, and verifies every decoded buffer; exact index reconstruction should use a suitable sequence encoding or retain the original index bytes. [Meshoptimizer algorithms](https://github.com/zeux/meshoptimizer#mesh-compression)

The glTF meshopt extension operates on buffer views and is designed to remain compressible by general-purpose HTTP encoders. Measure its output after the same Brotli setting as the control, rather than comparing encoded meshopt bytes with uncompressed GLBs. [EXT_meshopt_compression specification](https://github.com/KhronosGroup/glTF/blob/main/extensions/2.0/Vendor/EXT_meshopt_compression/README.md)

Prefer a delivery layer that reconstructs the existing normalized GLBs if that gives sufficient savings: it preserves the current manifest hashes, validation, scene budgets, and parser. A direct compressed-GLB path is a larger integration: `CadGeometry.ts` currently rejects meshopt and Draco extensions, and the renderer does not configure their decoders. Three.js exposes both `setMeshoptDecoder` and `setDRACOLoader`, so decoder availability is not the blocker; safe normalization and decoded-size admission are. [Three.js GLTFLoader](https://threejs.org/docs/pages/GLTFLoader.html)

An automatic `gltfpack` pass is not an exact compression toggle. Defaults include quantization, mesh merging, and node pruning. The tool has preservation flags for named nodes, named materials, and extras, but drops some unknown data; `-noq` disables quantization without promising byte-identical output. Benchmark the narrow codec separately before considering this broader optimizer. [gltfpack documentation](https://github.com/zeux/meshoptimizer/blob/master/gltf/README.md)

### More compact equivalent geometry

Indexed geometry reuses vertices across triangles. However, each vertex's complete attribute tuple matters: sharing position alone can destroy normal seams or material appearance. Three.js also computes normals differently for indexed and non-indexed geometry. An experiment that deduplicates only identical full vertex attributes, preserves triangle winding/material groups, and leaves occurrence transforms unchanged can test representation savings without lowering tessellation. It must verify surface and appearance equivalence rather than assume identical GLB hashes. [Three.js BufferGeometry](https://threejs.org/docs/pages/BufferGeometry.html)

## Direct 3MF, quantization, and Draco

3MF uses a ZIP package with Deflate or uncompressed entries, reusable object resources, and component transforms. Being a compressed archive is useful, but the format does not inherently prove a smaller equivalent model or faster end-to-end load. Its object resource IDs and optional part numbers are not a promise of Onshape occurrence identity. [3MF Core specification](https://github.com/3MFConsortium/spec_core/blob/master/3MF%20Core%20Specification.md)

The local PoC directly fetches a 3MF and parses it in a worker. Reusing that representation would require an authoritative sidecar mapping, preserved colors/transforms, and the same fallback bodies used by the current importer. First measure the retained equivalent source archive plus those fallback bodies. No complete matching robot archive was established by this research; do not extrapolate the small Kraken archive or the PoC's coarse-only result.

`KHR_mesh_quantization` deliberately trades precision for smaller attribute types. Uniform quantization over extent L with b bits has a per-axis rounding bound of L / (2 × (2^b − 1)), before transform scaling; this is a mathematical bound, not an acceptable CAD tolerance. Any experiment must report world-space error on the largest and smallest parts, including close openings and comment targets. Quantization is a separate product decision from lossless delivery. [Quantization specification](https://github.com/KhronosGroup/glTF/blob/main/extensions/2.0/Khronos/KHR_mesh_quantization/README.md)

Draco is supported through glTF, but the extension warns that compression may change vertex order and count. It is worth an offline controlled comparison if exact approaches are insufficient, with quantization settings explicit and visual/error measurements alongside byte size. It is not automatically a lossless replacement for the authoritative assets. [Draco extension specification](https://github.com/KhronosGroup/glTF/blob/main/extensions/2.0/Khronos/KHR_draco_mesh_compression/README.md)

In this repo, comment targets store an occurrence ID and local point/normal, not a triangle index (`packages/contracts/src/cadComments.ts`). Vertex reordering alone need not invalidate a target if the surface and occurrence coordinate system remain identical. Dropped instances, changed transforms, altered surfaces, and changed raycast occlusion can invalidate review behavior. Validate existing precise targets and whole-part targets on repeated instances.

## Workers and progressive loading

Workers can keep decoding off the UI thread. Transferable ArrayBuffers move ownership without copying their backing memory; sending large buffers by ordinary cloning defeats that benefit. A worker experiment should transfer owned input/output buffers and measure main-thread long tasks, total ready time, and peak memory. It cannot by itself reduce transfer bytes. [Transferable objects](https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API/Transferable_objects)

Current parsing already overlaps fetching, so prioritize workers only if a browser trace shows material CPU stalls. Preserve geometry admission checks before large allocations and complete-scene publication. Sharing parsed geometry between identical occurrences is already implemented; a worker rewrite should not reintroduce per-occurrence copies.

Progressive spatial LOD systems use screen-space error and additive/replacement refinement to reduce the data needed for the current view. This is a well-established first-visible strategy, illustrated by 3D Tiles. [3D Tiles specification](https://github.com/CesiumGS/3d-tiles/blob/main/specification/README.adoc)

That strategy changes the review contract: missing or simplified parts can make an occluded location appear visible. The user previously rejected reduced detail before refinement, so LOD, partial assemblies, and cached thumbnails are optional future UX decisions, not the recommended default. Even progressive arrival of exact parts would need a clearly incomplete state and disabled verification until the complete revision is present.

## Local benchmark evidence and recommendation order

### Existing browser trace: where the time goes

The recorded cold current-model run with Brotli and panel-toggle fixes reached the complete scene at **34.31 seconds after navigation**:

| Observed interval                      |    Time | Interpretation                                                                            |
| -------------------------------------- | ------: | ----------------------------------------------------------------------------------------- |
| Navigation to manifest request         |  5.21 s | Startup, synchronization, scene authorization/pinning; trace does not isolate these costs |
| Manifest request to final CAD response | 24.95 s | Predominantly geometry delivery, with concurrent server/client work                       |
| Final CAD response to ready indicator  |  4.14 s | Remaining browser work; not a CPU-only measurement                                        |

These intervals come from Resource Timing and a DOM readiness observer in `.scratch/cad-browser-regressions/cold-toggle-after.json`. HTTP response completion is not GPU completion. The resulting 83.04 MB transfer includes a 0.19 MB compressed manifest.

After a page reload with persistent geometry present, the manifest request did not start until 6.89 s; it finished at 7.24 s and the scene was ready at 8.20 s. That makes **time before the geometry loader starts** a separate worthwhile target. It would be incorrect to call the entire eight seconds parsing time. See `.scratch/cad-browser-regressions/persistent-cache-final-build.json`.

The store still verifies every asset during `loadUnlocked` under its mutex and verifies assets again when reading for transfer. Earlier controlled store probes preserved all path/hash checks and reduced the verification-stage median from 1,010 ms to 596 ms using four readers in 32 MiB cohorts. That evidence concerns the historical revision and one stage, not the full current-model opening time. Instrument current startup/RPC/pin stages before attributing the five-second gap to any one of them.

### New offline comparison on the current robot

Reproduction from repo root:

```powershell
node .scratch/cad-initial-load/representation.mjs
node .scratch/cad-initial-load/representation.mjs --combined
```

The probe uses the installed meshoptimizer 1.1.1, vertex codec version 0 with no filters, no quantization, and exact index-sequence encoding. All candidates use the same Brotli quality 5 and independent 4 MiB ranges as the delivery control. Framing metadata is included; HTTP headers and the unchanged manifest are excluded. Originals, imports, and the preview are untouched.

| Candidate                                 | Bytes before Brotli |  Encoded bytes | Reduction from current delivery |
| ----------------------------------------- | ------------------: | -------------: | ------------------------------: |
| Current manifest-ordered GLBs             |         202,050,012 |     82,852,898 |                         control |
| Exact shared BIN dictionary               |         165,995,680 |     68,346,686 |                           17.5% |
| Exact meshopt buffer views                |         110,470,815 |     70,910,740 |                           14.4% |
| **Exact meshopt + shared BIN dictionary** |      **90,966,825** | **57,253,348** |                       **30.9%** |

The 462 distinct GLBs contain 453 distinct BIN chunks. Merely sharing those identical binary chunks removes about 36 MB of redundant uncompressed data even though the whole-file hashes differ. Combining sharing with meshopt provides substantially more benefit than either alone on this current fixture.

The combined serialized frame was decoded back into **all 462 original GLBs**, with byte equality and SHA-256 checks against every manifest asset hash. No geometry, normal, color, transform, JSON field, or topology was changed. The existing manifest still maps those assets to all 467 geometry identities and 1,362 tree entries.

In the repeated combined run, mesh encoding across source buffer views took 0.70 s. Brotli encoding plus decode verification took 6.03 s, including 0.79 s for Brotli decoding. Decoding the serialized dictionary, reconstructing all GLBs, and checking their hashes took another 0.52 s. These are Node/WASM offline stage measurements, not browser-ready timing or a production memory bound; the intentionally simple probe holds several whole-model buffers simultaneously.

Results: `.scratch/cad-initial-load/representation-results.json` and `representation-combined-results.json`. The combined payload size repeated exactly. Roughly scaling the previous transfer interval by byte count suggests about **7.7 seconds less network time** at unchanged effective throughput, before accounting for the new decoder. This is a projection to justify the next experiment, not an end-to-end promise or evidence of a sub-ten-second first load.

The payload audit also found 62.33 MB each of positions and normals, 59.66 MB of indices, and only 0.56 MB of embedded GLB JSON. JSON cleanup is therefore low priority. About 33.56 MB of index data fits unsigned 16-bit values and could halve in uncompressed representation, but Brotli already compresses redundant high bytes; its actual wire savings must be measured. A material-name classification assigns 89.61 MB to 319 distinct 3MF-produced assets; the remaining 112.44 MB is consistent with the importer’s 143 fallback geometries. Investigating equivalent identity-preserving export for those fallback bodies may be valuable, but the next export's size cannot be inferred without measuring it.

### Recommended next implementation experiment

1. **Prototype a persisted, lossless meshopt + BIN-dedup delivery artifact.** Prepare it during import/background work and retain it across backend restarts. Reconstruct the existing GLBs before the existing validator/parser, preserving manifest hashes and comments. This has the strongest new measured size result without lowering review detail. Compare its total first-open cost against already prepared current Brotli, and separately measure newly imported CAD so preparation is not hidden.
2. **Shorten startup and authorization/verification latency in parallel.** Instrument app readiness, scene RPC, mutex wait, verification, manifest first byte, and first frame. Start with the previously demonstrated bounded verification cohorts and eliminate redundant work only while retaining corruption, deletion, symlink, and authorization guarantees. Do not assume all pre-manifest time is asset verification.
3. **Measure browser CPU/GPU after the smaller transfer.** The observed cold tail is about four seconds, but the cached current-model tail after its manifest is roughly one second. Collect decode, parse, allocation/GC, scene construction, shader compile/upload, and first-frame marks. Move work to a transferable-buffer worker only where the trace establishes a benefit.

The artifact experiment needs bounded streaming reconstruction rather than the scratch probe's whole-model allocations; explicit codec/version identity in both server and browser cache keys; decoded-length admission before allocation; cancellation and partial-transfer recovery; fallback to the existing representation; and unchanged authorization/snapshot cleanup. Do not run broad `gltfpack` defaults as the implementation of this exact codec.

Acceptance should report median and slow-case **first complete frame** over multiple fresh browser contexts on the same full robot, with server preparation cold and warm listed separately. Also verify peak memory, exact reconstructed hashes, all occurrences/colors, the existing battery comment and repeated-instance targets, panel toggles during load, and failed/aborted ranges. Keep the existing representation as the control.

For an entirely new Onshape connection, export/poll/download and import normalization occur before these viewer measurements. This pass did not incur new API calls or establish that ingestion latency. Add URL submission → import ready → first complete frame to the same instrumentation so improvements are judged against the onboarding wait the user actually experiences.
