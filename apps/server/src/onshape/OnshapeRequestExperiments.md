# Onshape download request experiments

September 22, 2026. Baseline commit: `a15db1a2847f0de18bcfa7103fb015b763007628`.

The supplied assembly now downloads in **9 live API requests**, down from the
intermediate 56-request implementation and the original 222-request replay.
An unchanged live sync uses **1 request** and returns the same snapshot.
The cold acquisition took 54.9 seconds. This excludes browser rendering.

## Input and request counts

The source is document `e5fd6dd412a8653a52ad3252`, workspace
`1cc3344ea68c679223cb7558`, element `e46921a75b1bb6cff79888e0`.
Every comparison uses microversion `00bc99fc702d682d31e0d064`.

| Cold acquisition operation                     | Requests |
| ---------------------------------------------- | -------: |
| Pin and verify the workspace revision          |        2 |
| Read assembly identities and placements        |        1 |
| Read expanded BOM appearance and materials     |        1 |
| Submit, poll, and download one 3MF export      |        3 |
| Fetch ambiguous geometry in two studio batches |        2 |
| Total                                          |    **9** |

The real acquisition, connection, signer, transport, parsers, and disk store ran
against Onshape with empty experiment storage. No responses were replayed in the
live cold run. Counts exclude the runner's separate connection-verification call.
Credentials stayed in memory. The experiments did not write to the Onshape
document, production storage, or daily-driver state.

The runner's first live comparison rejected `-0` versus `0` in transforms after
the importer had published successfully. The comparison now treats these as the
same number. A complete replay of that live recording passes the nine-request
assertion. A separate live unchanged sync took 0.416 seconds and returned the
published snapshot `7b69a5ed-442a-4a23-8404-b98702b7f5f6`.

## Changes from the PoC comparison

The `AadiJo/cadsense` PoC at commit
`e65516921a5843c3c5413f71fd585fa846c45bd7` downloads one grouped, coarse,
meter-unit 3MF archive. Replaying its actual sync service used four requests:
one submission, two polls, and one download. It does not acquire native occurrence
identities, repair missing opacity, or fetch ambiguous source geometry.

The production importer now uses the same single-export approach. It keeps the
existing per-face color parser and obtains source identities separately. Names or
array order never resolve ambiguous source parts.

- `OnshapeSnapshotMetadata.ts` reads one expanded BOM, requesting name, appearance,
  and material columns. The live response supplies all 153 required parts exactly.
  Rows must match document, pinned revision, element, part ID, and configuration.
  `distinctConfigurations` handles BOM rows that collapse metadata-equivalent
  configurations. Ambiguous, malformed, conflicting, or missing rows retain the
  studio fallback. Authentication and quota errors stop acquisition.
- `OnshapeBulkAcquisition.ts` extracts 100 source geometries directly from 3MF.
  It downloads the remaining 53 in two source-ID studio batches instead of starting
  another whole-assembly export. Failed or partial batches fall back only for their
  unresolved parts. Batches retain the existing synchronous angle and chord
  tolerances, immutable source revisions, and face appearances.
- New exports wait 20 seconds before the first status poll. Resumed jobs are
  checked immediately. Polling remains bounded and checkpoints remain resumable.
- Bulk geometry uses two-sided materials, including synchronous fallback geometry.
  Profile `onshape-3mf-coarse-meters-z-up-opacity-v3` distinguishes the changed
  representation from cached older snapshots. Historical snapshots stay immutable.

The BOM does not supply Part Studio `isHidden`, `isMesh`, or `configurationId`.
These optional metadata values remain null. Occurrences still determine assembly
visibility. The BOM does supply `partIdentity`. Suppressed-part metadata can remain
null. No rendering or review identity depends on the omitted fields in this checkout.

## Geometry and appearance

Both versions retain **577 scene nodes, 196 source-part records, and 153 assets**.
Occurrence IDs, parents, source references, configurations, transforms, suppression,
and visibility match. Geometry keys change only with the explicit profile version.
Names, body types, materials, and authored appearance match for every required part.
The transparent Origin Cube retains opacity `64/255`. The 3MF archive alone makes
that cube opaque, so removing the appearance read would regress the model.

The geometry checks use Three.js's glTF loader and actual stored assets:

- 101 assets have exactly equivalent decoded geometry, normals, and materials.
- 45 retain their geometry and colors, with back-face rendering enabled to match
  the archive's two-sided behavior.
- Six receive denser tessellation. Bidirectional tests sample every vertex, edge
  midpoint, and triangle centroid by material. The largest sampled surface
  difference is **0.062756 mm**, below the existing 0.5 mm synchronous chord tolerance.
- One asset changes because the old assembly glTF assigned a complete composite
  mesh to constituent `KFDE`. The studio response supplies that constituent's
  actual 252-triangle mesh instead of the duplicated 9,388-triangle mesh.

The composite check compares the removed mesh against the retained source parts
at the same placement, parent, and visibility. Same-color surfaces agree within
0.041509 mm. Its 1,952 exporter-default gray triangles overlap the unchanged,
authored blue `KFrE` geometry within 0.001415 mm. Removing the duplicate exposes
that existing authored color. This is **not pixel-identical output**, nor a loss
of those surfaces. The report retains the failed per-part comparison alongside
the scene-coverage evidence instead of hiding the difference.

Total unique-asset triangles increase from 775,351 to 863,327. These are mesh
comparison results, not manufacturing accuracy guarantees or a browser benchmark.
Sampling does not establish an exact surface-distance bound between sample points.
Other assemblies can require more batches, polls, or metadata fallbacks.

## Rejected approaches

The earlier `/assembly-debug` metadata request returned either 184 nodes or only
43 for the same revision. The incomplete response caused the 56-request run.
Expansion flags and linked-subassembly probes did not make that tree reliable.
The expanded BOM returned all required appearance in one response.

Adding `includeExportIds` did not provide usable source IDs in 3MF. The importer
therefore keeps the native assembly definition and targeted source-ID geometry.
The PoC parser also discards triangle-level color overrides already present in
the archive. That parser behavior was not adopted.

Nine is the measured count for this assembly, not a universal minimum. This
implementation cannot reduce a cold export to one call: it submits and downloads
an asynchronous job, and retains revision, identity, and appearance checks.

## Verification and evidence

Importer regressions were run red before their implementation. They cover BOM
configuration matching, partial or conflicting metadata, revision mismatches,
opacity, targeted geometry, oversized and partial batches, quota failures,
poll timing, interruption recovery, and unchanged sync.

Final checks pass: 175 Onshape tests, 124 CAD tests, 219 contract tests, server and
web typechecks, scoped lint, and formatting.

The ignored `.cadsense/request-experiments/` directory retains:

- `bom-targeted-live/`: all nine live requests, responses, manifest, and assets.
- `bom-targeted-live-unchanged/`: the one-request live unchanged-sync result.
- `bom-final-replay/`: successful cold and unchanged replay with a nine-request assertion.
- `bom-targeted-live/fidelity.json`: strict decoded geometry comparison for all assets.
- `bom-targeted-live/surface-fidelity.json`: sampled surface, material, and duplicate-coverage checks.
- `surface-fidelity.mjs` and `geometry-tools/`: the local surface audit and its
  Three.js and `three-mesh-bvh` dependencies.
- `poc-replay/`: execution of the PoC's actual sync service and parser.

Artifacts contain CAD data, not credentials or authorization headers. Earlier
`baseline-offline`, `optimized-live`, and `bulk-first-live-complete` directories
retain the 222-, 78-, and 56-request comparisons. None is presented as the final result.

See [the runner reference](../../scripts/onshape-request-experiment.md) for commands.
