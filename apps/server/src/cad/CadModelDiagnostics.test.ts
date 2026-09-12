import {
  CadModelDiagnosticsResult,
  CadSnapshotManifest,
  CadPartSource,
  type CadGeometryAsset,
  type CadSnapshotNode,
  type CadSnapshotPart,
} from "@cadsense/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { readCadModelDiagnostics, CAD_DIAGNOSTIC_THRESHOLDS } from "./CadModelDiagnostics.ts";
import { initialCadView } from "./CadViewState.ts";
import { cadToolDefinitions } from "../provider/CadProviderTools.ts";

const hash = (n: number) => n.toString(16).padStart(64, "0");
const source = Schema.decodeUnknownSync(CadPartSource)({
  host: "cad.onshape.com",
  documentId: "a".repeat(24),
  documentMicroversion: "b".repeat(24),
  documentVersion: null,
  elementId: "c".repeat(24),
  configuration: "default",
  fullConfiguration: "default",
  partId: "test",
  tessellationProfile: "test-mesh",
});
const part = (id: number, required = true): CadSnapshotPart => ({
  geometryKey: hash(id),
  source: { ...source, partId: `part-${id}` },
  geometryRequired: required,
  metadata: required
    ? {
        name: "test",
        bodyType: "solid",
        isHidden: false,
        isMesh: false,
        partIdentity: null,
        configurationId: null,
        appearance: null,
        material: null,
      }
    : null,
});
const node = (id: number, sourceId: number | null, suppressed = false): CadSnapshotNode => ({
  id: hash(id),
  parentId: null,
  occurrencePath: [String(id)],
  instanceId: String(id),
  name: `part-${id}`,
  kind: "part",
  suppressed,
  defaultVisible: !suppressed,
  sourcePartKey: sourceId === null ? null : hash(sourceId),
  transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
});
const asset = (id: number, complexity?: CadGeometryAsset["complexity"]): CadGeometryAsset => ({
  geometryKey: hash(id),
  sha256: hash(id + 100),
  byteLength: 100,
  relativePath: `${hash(id + 100)}.glb`,
  format: "glb",
  ...(complexity ? { complexity } : {}),
});
const small = { triangles: 100, decodedBytes: 2000, drawCalls: 2, nodeCount: 1 };
const snapshot = Schema.decodeUnknownSync(CadSnapshotManifest)({
  schemaVersion: 1,
  snapshotId: "00000000-0000-4000-8000-000000000002",
  rootId: hash(1),
  projectId: "test",
  createdAt: "2026-09-05T00:00:00Z",
  root: {
    host: source.host,
    documentId: source.documentId,
    elementId: source.elementId,
    kind: "assembly",
    originalRevision: { kind: "m", id: source.documentMicroversion },
    microversionId: source.documentMicroversion,
    configuration: "default",
    tessellationProfile: "test-mesh",
  },
  nodes: [
    node(10, 2),
    node(11, 2),
    node(12, 3),
    node(13, 4, true),
    node(14, null, true),
    { ...node(15, null), kind: "unsupported" },
  ],
  parts: [part(2), part(3), part(4, false)],
  assets: [asset(2, small), asset(3)],
  dependencies: [],
});
const state = initialCadView(snapshot, 4);
const request = { snapshotId: snapshot.snapshotId, expectedRevision: state.revision };
const decodeResult = Schema.decodeUnknownSync(CadModelDiagnosticsResult);
const diagnostics = (overrides: Record<string, unknown> = {}, value = snapshot) =>
  readCadModelDiagnostics(value, state, { ...request, ...overrides }).pipe(
    Effect.map(decodeResult),
  );

it.effect(
  "distinguishes expected omission, unavailable metadata, unsupported components, and unknown costs",
  () =>
    Effect.gen(function* () {
      const result = yield* diagnostics();
      assert.deepEqual(result.coverage.assetIntegrity, { status: "not-checked", assetsChecked: 0 });
      assert.equal(result.coverage.nodesScanned, 6);
      assert.equal(result.coverage.sourcePartsScanned, 3);
      assert.equal(result.coverage.assetDescriptorsScanned, 2);
      assert.equal(result.coverage.complete, true);
      assert.equal(result.summary.occurrences.suppressed, 2);
      assert.equal(result.summary.occurrences.unsupported, 1);
      assert.equal(result.summary.sourceParts.expectedUnloaded, 1);
      assert.equal(result.summary.sourceParts.missingRequiredAssets, 0);
      assert.equal(result.summary.sourceParts.missingMetadata, 1);
      assert.equal(result.counts.bySeverity.error, 0);
      assert.deepEqual(
        result.findings.map((finding) => finding.code),
        [
          "suppressed-component",
          "suppressed-component",
          "unsupported-component",
          "expected-unloaded-geometry",
          "metadata-unavailable",
          "complexity-unavailable",
        ],
      );
      const missingMetadata = result.findings.find(
        (finding) => finding.code === "metadata-unavailable",
      )!;
      assert.equal(missingMetadata.severity, "info");
      assert.equal(missingMetadata.geometryKey, hash(4));
      assert.equal(missingMetadata.evidence.metadataPresent, false);
      assert.equal(missingMetadata.evidence.geometryRequired, false);
      const unknown = result.findings.find((finding) => finding.code === "complexity-unavailable")!;
      assert.equal(unknown.evidence.storedComplexity, null);
      assert.equal(unknown.evidence.potentialTriangles, null);
      assert.equal(unknown.evidence.complexityState, "missing");
    }),
);
it.effect("counts a shared geometry once and its unsuppressed instances separately", () =>
  Effect.gen(function* () {
    const result = yield* diagnostics();
    assert.deepEqual(result.summary.geometryComplexity, {
      basis: "required-source-geometry-key",
      knownGeometryCount: 1,
      unknownGeometryCount: 1,
      trianglesKnownSubtotal: 100,
      decodedBytesKnownSubtotal: 2000,
      drawCallsKnownSubtotal: 2,
      complete: false,
    });
    assert.deepEqual(result.summary.potentialAssembledWorkload, {
      knownOccurrenceCount: 2,
      unknownOccurrenceCount: 1,
      trianglesKnownSubtotal: 200,
      drawCallsKnownSubtotal: 4,
      complete: false,
    });
    const hidden = yield* readCadModelDiagnostics(
      snapshot,
      {
        ...state,
        visibility: { [hash(10)]: false },
        explosion: 1,
        isolatedOccurrenceIds: [hash(12)],
      },
      request,
    );
    assert.deepEqual(hidden.summary, result.summary);
    assert.equal(hidden.coverage.visibilityApplied, false);
    assert.equal(hidden.coverage.workloadBasis, "all-unsuppressed-part-occurrences");
  }),
);
it.effect("reports repeated geometry cost using stored counts and supplied thresholds", () =>
  Effect.gen(function* () {
    const result = yield* diagnostics({ thresholds: { triangles: 150 } });
    const expensive = result.findings.find((finding) => finding.code === "expensive-geometry")!;
    assert.equal(expensive.geometryKey, hash(2));
    assert.equal(expensive.sourcePartId, "part-2");
    assert.deepEqual(expensive.occurrenceIds, [hash(10), hash(11)]);
    assert.equal(expensive.occurrenceCount, 2);
    assert.equal(expensive.evidence.storedComplexity?.triangles, 100);
    assert.equal(expensive.evidence.potentialTriangles, 200);
    assert.deepEqual(expensive.evidence.thresholdsExceeded, ["potential-triangles"]);
    assert.deepEqual(result.filters.thresholds, { ...CAD_DIAGNOSTIC_THRESHOLDS, triangles: 150 });
    const unique = yield* diagnostics({ thresholds: { decodedBytes: 2000, drawCalls: 2 } });
    const cost = unique.findings.find((finding) => finding.code === "expensive-geometry")!;
    assert.deepEqual(cost.evidence.thresholdsExceeded, [
      "geometry-decoded-bytes",
      "geometry-draw-calls",
      "potential-draw-calls",
    ]);
  }),
);
it.effect("counts identical hashes separately by source key and states the accounting basis", () =>
  Effect.gen(function* () {
    const value = {
      ...snapshot,
      assets: [
        asset(2, small),
        { ...asset(3, small), sha256: asset(2).sha256, relativePath: asset(2).relativePath },
      ],
    };
    const result = yield* diagnostics({}, value);
    assert.equal(result.summary.assets.distinctHashes, 1);
    assert.equal(result.summary.geometryComplexity.knownGeometryCount, 2);
    assert.equal(result.summary.geometryComplexity.decodedBytesKnownSubtotal, 4000);
    assert.equal(result.summary.geometryComplexity.complete, true);
    assert.equal(result.summary.potentialAssembledWorkload.trianglesKnownSubtotal, 300);
  }),
);
it.effect("identifies manifest association defects without claiming a disk file is missing", () =>
  Effect.gen(function* () {
    // Completed snapshots normally reject these rows before activation. Exercise the scanner's evidence semantics directly.
    const value = {
      ...snapshot,
      nodes: [...snapshot.nodes, node(16, null), node(17, 999), node(18, 4)],
      parts: snapshot.parts.map((part) =>
        part.geometryKey === hash(2) ? { ...part, metadata: null } : part,
      ),
      assets: [asset(3), asset(999, small)],
    };
    const result = yield* diagnostics({}, value);
    assert.equal(result.summary.sourceParts.missingRequiredAssets, 1);
    assert.equal(result.summary.sourceParts.expectedUnloaded, 0);
    assert.equal(result.summary.assets.invalidAssociations, 1);
    assert.equal(
      result.findings.filter((finding) => finding.code === "missing-part-reference").length,
      2,
    );
    assert.equal(
      result.findings.filter((finding) => finding.code === "inconsistent-geometry-requirement")
        .length,
      1,
    );
    const missing = result.findings.find(
      (finding) => finding.code === "missing-required-geometry",
    )!;
    assert.equal(missing.classification, "manifest-defect");
    assert.equal(missing.evidence.assetDescriptorPresent, false);
    assert.equal(result.coverage.assetIntegrity.status, "not-checked");
    assert.equal(
      result.findings.find(
        (finding) => finding.code === "metadata-unavailable" && finding.geometryKey === hash(2),
      )?.severity,
      "error",
    );
  }),
);
it.effect("keeps occurrence links and pages bounded while reporting full coverage", () =>
  Effect.gen(function* () {
    const value = {
      ...snapshot,
      nodes: Array.from({ length: 25 }, (_, i) => node(20 + i, 2)),
      parts: [part(2)],
      assets: [asset(2, small)],
    };
    const result = yield* diagnostics({ thresholds: { triangles: 150 }, limit: 1 }, value);
    assert.equal(result.coverage.nodesScanned, 25);
    assert.equal(result.findings.length, 1);
    assert.equal(result.findings[0]!.occurrenceIds.length, 20);
    assert.equal(result.findings[0]!.occurrenceCount, 25);
    assert.equal(result.findings[0]!.occurrenceIdsTruncated, true);
    assert.equal(result.summary.potentialAssembledWorkload.trianglesKnownSubtotal, 2500);
    assert.equal(result.nextCursor, null);
    const full = yield* diagnostics();
    const seen = [];
    let cursor: string | undefined;
    do {
      const page = yield* diagnostics({ limit: 2, ...(cursor ? { cursor } : {}) });
      assert.deepEqual(page.summary, full.summary);
      assert.equal(page.counts.allFindings, 6);
      assert.equal(page.counts.matchingFindings, 6);
      assert.equal(page.counts.returnedFindings, 2);
      seen.push(...page.findings);
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    assert.deepEqual(seen, full.findings);
  }),
);
it.effect("binds cursors to resolved filters, thresholds, revision, and snapshot", () =>
  Effect.gen(function* () {
    const first = yield* diagnostics({ limit: 1 });
    assert.ok(first.nextCursor);
    for (const override of [
      { minimumSeverity: "warning" },
      { thresholds: { triangles: 4 } },
      { thresholds: { decodedBytes: 4 } },
      { thresholds: { drawCalls: 4 } },
      { cursor: `${first.nextCursor}garbage` },
      { cursor: first.nextCursor!.replace(/1$/, "999") },
    ]) {
      const failed = yield* readCadModelDiagnostics(snapshot, state, {
        ...request,
        cursor: first.nextCursor,
        ...override,
      }).pipe(Effect.flip);
      assert.equal(failed.reason, "invalid-operation");
    }
    const resolvedDefaults = yield* diagnostics({
      cursor: first.nextCursor,
      minimumSeverity: "info",
      thresholds: CAD_DIAGNOSTIC_THRESHOLDS,
      limit: 3,
    });
    assert.equal(resolvedDefaults.counts.offset, 1);
    assert.equal(resolvedDefaults.counts.returnedFindings, 3);
    const advanced = { ...state, revision: 5 };
    assert.equal(
      (yield* readCadModelDiagnostics(snapshot, advanced, {
        ...request,
        expectedRevision: 5,
        cursor: first.nextCursor,
      }).pipe(Effect.flip)).reason,
      "invalid-operation",
    );
    assert.equal(
      (yield* readCadModelDiagnostics(snapshot, advanced, request).pipe(Effect.flip)).reason,
      "revision-conflict",
    );
    assert.equal(
      (yield* readCadModelDiagnostics(snapshot, state, {
        ...request,
        snapshotId: "00000000-0000-4000-8000-000000000003",
      }).pipe(Effect.flip)).reason,
      "revision-conflict",
    );
    assert.equal(
      (yield* readCadModelDiagnostics(snapshot, { ...state, rootId: hash(999) }, request).pipe(
        Effect.flip,
      )).reason,
      "revision-conflict",
    );
    const warnings = yield* diagnostics({ minimumSeverity: "warning" });
    assert.equal(warnings.counts.allFindings, 6);
    assert.equal(warnings.counts.matchingFindings, 1);
    assert.equal(warnings.findings[0]!.code, "unsupported-component");
  }),
);
it.effect("marks unsafe complexity and overflowing subtotals unknown", () =>
  Effect.gen(function* () {
    const unsafe = yield* diagnostics(
      {},
      {
        ...snapshot,
        assets: [asset(2, { ...small, triangles: Number.MAX_SAFE_INTEGER + 1 }), asset(3)],
      },
    );
    assert.equal(unsafe.summary.geometryComplexity.knownGeometryCount, 0);
    assert.equal(unsafe.summary.geometryComplexity.unknownGeometryCount, 2);
    assert.equal(unsafe.summary.geometryComplexity.complete, false);
    assert.equal(
      unsafe.findings.find((finding) => finding.geometryKey === hash(2))?.evidence.complexityState,
      "invalid",
    );
    const overflow = yield* diagnostics(
      {},
      {
        ...snapshot,
        assets: [asset(2, { ...small, triangles: Number.MAX_SAFE_INTEGER }), asset(3, small)],
      },
    );
    assert.equal(overflow.summary.geometryComplexity.trianglesKnownSubtotal, null);
    assert.equal(overflow.summary.potentialAssembledWorkload.trianglesKnownSubtotal, null);
    assert.equal(overflow.summary.geometryComplexity.complete, false);
    assert.equal(overflow.summary.potentialAssembledWorkload.complete, false);
  }),
);
it.effect("validates page and threshold bounds and registers an object tool schema", () =>
  Effect.gen(function* () {
    for (const override of [
      { limit: 0 },
      { limit: 101 },
      { thresholds: { triangles: 0 } },
      { thresholds: { decodedBytes: Infinity } },
      { cursor: "x".repeat(257) },
    ])
      assert.equal(
        (yield* readCadModelDiagnostics(snapshot, state, { ...request, ...override }).pipe(
          Effect.flip,
        )).reason,
        "invalid-operation",
      );
    const definition = cadToolDefinitions.find((tool) => tool.name === "cad_model_diagnostics");
    assert.ok(definition);
    assert.equal(definition.inputSchema.type, "object");
  }),
);

it.effect("explains suppressed unsupported components as expected omission", () =>
  Effect.gen(function* () {
    const value = {
      ...snapshot,
      nodes: [{ ...node(99, null, true), kind: "unsupported" as const }],
      parts: [],
      assets: [],
    };
    const result = yield* diagnostics({}, value);
    assert.equal(result.findings.length, 1);
    assert.equal(result.findings[0]!.code, "unsupported-component");
    assert.equal(result.findings[0]!.severity, "info");
    assert.equal(result.findings[0]!.classification, "expected-state");
    assert.equal(result.findings[0]!.evidence.nodeKind, "unsupported");
    assert.equal(result.findings[0]!.evidence.suppressed, true);
    assert.equal(result.counts.bySeverity.error, 0);
    assert.equal(result.counts.bySeverity.warning, 0);
  }),
);
