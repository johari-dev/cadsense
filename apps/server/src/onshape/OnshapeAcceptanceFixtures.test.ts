import { CadSnapshotRoot, ProjectId } from "@cadsense/contracts";
import { createCadSceneBudget, measureCadGeometry } from "@cadsense/shared/cadSceneBudget";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import assembly from "./testFixtures/configured-assembly.json" with { type: "json" };
import studio from "./testFixtures/multipart-studio.json" with { type: "json" };
import {
  completeSnapshotManifest,
  enrichSnapshotMetadata,
  parseAssemblySnapshotDraft,
  parsePartStudioSnapshotDraft,
  snapshotPartStudioGroups,
  snapshotRootId,
} from "./OnshapeSnapshotManifest.ts";

const root = Schema.decodeUnknownSync(CadSnapshotRoot)({
  host: "https://cad.onshape.com",
  documentId: assembly.rootAssembly.documentId,
  elementId: assembly.rootAssembly.elementId,
  kind: "assembly",
  originalRevision: { kind: "m", id: assembly.rootAssembly.documentMicroversion },
  microversionId: assembly.rootAssembly.documentMicroversion,
  configuration: assembly.rootAssembly.configuration,
  tessellationProfile: "offline-topology-only",
});
const context = {
  snapshotId: "00000000-0000-4000-8000-000000000001",
  projectId: ProjectId.make("offline-acceptance"),
  createdAt: "2026-09-06T00:00:00Z",
  root,
  rootId: snapshotRootId(root),
};
// Geometry-independent acceptance: a valid empty GLB, never presented as actual CAD geometry.
const json = new TextEncoder().encode('{"asset":{"version":"2.0"},"nodes":[]}');
const jsonLength = Math.ceil(json.length / 4) * 4;
const bytes = new Uint8Array(20 + jsonLength);
const header = new DataView(bytes.buffer);
header.setUint32(0, 0x46546c67, true);
header.setUint32(4, 2, true);
header.setUint32(8, bytes.length, true);
header.setUint32(12, jsonLength, true);
header.setUint32(16, 0x4e4f534a, true);
bytes.fill(32, 20);
bytes.set(json, 20);
const asset = {
  sha256: "a".repeat(64),
  byteLength: bytes.length,
  relativePath: `${"a".repeat(64)}.glb`,
  format: "glb" as const,
  complexity: measureCadGeometry(bytes),
};

it.effect("normalizes the complete sanitized configured assembly without losing occurrences", () =>
  Effect.gen(function* () {
    const draft = yield* parseAssemblySnapshotDraft(context, assembly);
    assert.isAtLeast(draft.nodes.length, 1347);
    assert.isAtLeast(draft.parts.filter((part) => part.geometryRequired).length, 400);
    const byPath = new Map(draft.nodes.map((node) => [node.occurrencePath.join("/"), node]));
    for (const occurrence of assembly.rootAssembly.occurrences) {
      const node = byPath.get(occurrence.path.join("/"));
      assert.isDefined(node);
      assert.deepEqual(node!.transform, occurrence.transform);
      if (occurrence.hidden) assert.isFalse(node!.defaultVisible);
    }
    assert.isTrue(draft.nodes.some((node) => node.suppressed && !node.defaultVisible));
    assert.isTrue(draft.nodes.some((node) => node.occurrencePath.length >= 4));
    assert.isTrue(draft.parts.some((part) => part.source.documentId !== root.documentId));
    assert.isTrue(draft.parts.some((part) => part.source.fullConfiguration !== "default"));
    const keys = draft.nodes.flatMap((node) => (node.sourcePartKey ? [node.sourcePartKey] : []));
    assert.isAbove(keys.length, new Set(keys).size);
    const groups = snapshotPartStudioGroups(draft);
    const enriched = yield* enrichSnapshotMetadata(
      draft,
      groups.map((group) => ({
        source: group.source,
        response: draft.parts
          .filter(
            (part) =>
              part.geometryRequired &&
              part.source.documentId === group.source.documentId &&
              part.source.documentMicroversion === group.source.documentMicroversion &&
              part.source.elementId === group.source.elementId &&
              part.source.fullConfiguration === group.source.fullConfiguration,
          )
          .map((part) => ({
            partId: part.source.partId,
            name: "Offline component",
            bodyType: "solid",
            appearance: studio[0]!.appearance,
          })),
      })),
    );
    const assets = enriched.parts
      .filter((part) => part.geometryRequired)
      .map((part) => ({ ...asset, geometryKey: part.geometryKey }));
    const complete = yield* completeSnapshotManifest(enriched, assets);
    const budget = createCadSceneBudget(complete.nodes);
    for (const entry of complete.assets) budget.add(entry, asset.complexity);
    assert.equal(complete.nodes.length, draft.nodes.length);
    assert.equal(
      complete.assets.length,
      draft.parts.filter((part) => part.geometryRequired).length,
    );
    assert.isTrue(
      complete.parts
        .filter((part) => part.geometryRequired)
        .every((part) => part.metadata?.appearance?.color.blue === 190),
    );
  }),
);

it.effect("preserves multipart studio visibility, mesh flags, and independent appearances", () =>
  Effect.gen(function* () {
    const studioRoot = { ...root, kind: "part-studio" as const };
    const draft = yield* parsePartStudioSnapshotDraft(
      { ...context, root: studioRoot, rootId: snapshotRootId(studioRoot) },
      studio,
    );
    const complete = yield* completeSnapshotManifest(
      draft,
      draft.parts.map((part) => ({ ...asset, geometryKey: part.geometryKey })),
    );
    assert.equal(complete.nodes.length, 4);
    assert.equal(complete.assets.length, 3);
    assert.deepEqual(
      complete.parts.map((part) => part.metadata?.appearance),
      studio.map((part) => part.appearance),
    );
    assert.equal(complete.nodes.find((node) => node.name === "Guard")?.defaultVisible, false);
    assert.equal(
      complete.parts.find((part) => part.source.partId === "roller")?.metadata?.isMesh,
      true,
    );
    assert.equal(new Set(complete.parts.map((part) => part.geometryKey)).size, 3);
  }),
);
