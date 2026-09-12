# CAD model diagnostics

`cad_model_diagnostics` reports stored evidence for the selected pinned CAD snapshot. Requests require `snapshotId` and `expectedRevision` from `cad_context`. A stale snapshot, root, or revision fails with `revision-conflict`.

```json
{
  "snapshotId": "00000000-0000-4000-8000-000000000002",
  "expectedRevision": 4,
  "minimumSeverity": "warning",
  "thresholds": { "triangles": 1000000 },
  "limit": 50
}
```

`minimumSeverity` defaults to `info`. The allowed values are `info`, `warning`, and `error`. Pages contain at most 100 findings. `nextCursor` binds the snapshot, revision, severity, and resolved thresholds. Page size can change between requests.

Findings distinguish four classes:

- Expected state includes suppressed components and source geometry that is not required for loading.
- Coverage gaps include unsupported components, absent optional metadata, and missing or invalid complexity records.
- Manifest defects include required geometry without an asset descriptor, missing source-part references, and inconsistent requirements.
- Cost findings identify stored geometry counts or potential instance counts that meet a threshold. They do not establish engineering defects.

Each finding includes a source geometry key when available, a source part ID and microversion, and up to 20 linked occurrence IDs. `occurrenceCount` reports all matching occurrences, and `occurrenceIdsTruncated` identifies incomplete links. The severity filter changes the returned findings, while scan coverage and summary counts still cover the entire manifest.

Default cost thresholds are 1,000,000 triangles, 128 MiB of decoded bytes, and 128 draw calls. A request can override each threshold independently. A cost finding includes the observed stored counts and the thresholds exceeded.

`geometryComplexity` counts each required source geometry key once. Different source keys can refer to identical asset bytes, so `assets.distinctHashes` reports distinct SHA-256 values separately. These decoded-byte totals are not process-memory measurements.

`potentialAssembledWorkload` weights triangles and draw calls by all unsuppressed part occurrences. Hidden and isolated-away parts remain in that estimate. It is not the current rendered workload, and display explosion does not change it.

Unknown complexity contributes to `unknownGeometryCount` or `unknownOccurrenceCount`. `trianglesKnownSubtotal`, `decodedBytesKnownSubtotal`, and `drawCallsKnownSubtotal` exclude those records. `complete` is false when any required contribution is unknown or the sum exceeds the safe integer range. A null subtotal indicates numeric overflow. Per-finding potential counts are null when complexity is unknown or multiplication overflows.

The diagnostic scan reads no asset files, GLB bytes, or remote sources. `coverage.assetIntegrity` always reports `not-checked` and zero checked assets. Manifest descriptors do not prove that files exist or that their contents match their hashes. Normal snapshot activation validates required metadata and asset associations before this tool runs, so diagnostics cannot inspect a snapshot that fails to load.

The scanner traverses the bounded manifest arrays and retains only the requested page and bounded occurrence links. It does not recompute mesh geometry or change the CAD view.
