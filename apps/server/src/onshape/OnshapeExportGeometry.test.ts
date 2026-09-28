import { CadSnapshotRoot } from "@cadsense/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { normalizeCadGeometry } from "../cad/CadGeometry.ts";
import { normalizeOnshapeExport } from "./OnshapeExportBundle.ts";
import { readOnshapeExportGeometry } from "./OnshapeExportGeometry.ts";
import {
  parseAssemblySnapshotDraft,
  snapshotRootId,
  enrichSnapshotMetadata,
} from "./OnshapeSnapshotManifest.ts";
import {
  bulkFixture,
  bulkInput,
  bulkMicroversion,
  encodeFixture,
} from "./testFixtures/bulkExport.ts";

const root = Schema.decodeUnknownSync(CadSnapshotRoot)({
  host: bulkInput.source.host,
  documentId: bulkInput.source.documentId,
  elementId: bulkInput.root.elementId,
  kind: "assembly",
  originalRevision: { kind: "w", id: bulkInput.source.workspaceId },
  microversionId: bulkMicroversion,
  configuration: "default",
  tessellationProfile: "test",
});
const context = {
  snapshotId: "00000000-0000-4000-8000-000000000001",
  projectId: bulkInput.projectId,
  createdAt: "2026-09-07T00:00:00Z",
  root,
  rootId: snapshotRootId(root),
};
const encode = (value: unknown) => new TextEncoder().encode(encodeFixture(value));
const decode = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);
const glbDocument = (bytes: Uint8Array) =>
  decode(
    new TextDecoder().decode(
      bytes.subarray(20, 20 + new DataView(bytes.buffer, bytes.byteOffset).getUint32(12, true)),
    ),
  );

describe("Onshape export geometry", () => {
  it.effect("retains every exported body of a composite instance", () =>
    Effect.gen(function* () {
      const fixture = bulkFixture(1);
      const definition = {
        ...fixture.definition,
        parts: fixture.definition.parts.map((part) => ({ ...part, bodyType: "composite" })),
      };
      const base = yield* parseAssemblySnapshotDraft(context, definition);
      const draft = yield* enrichSnapshotMetadata(base, [
        {
          source: base.parts[0]!.source,
          response: fixture.metadata.map((part) => ({ ...part, bodyType: "composite" })),
        },
      ]);
      const gltf = {
        ...fixture.gltf,
        nodes: [
          fixture.gltf.nodes[0],
          fixture.gltf.nodes[1],
          { ...fixture.gltf.nodes[2], children: [1, 3] },
          { ...fixture.gltf.nodes[1], children: [4] },
          { ...fixture.gltf.nodes[0] },
        ],
      };
      const input = yield* normalizeOnshapeExport(encode(gltf));
      const output = readOnshapeExportGeometry(draft, input).extract(draft.parts[0]!.geometryKey);
      yield* normalizeCadGeometry(output);
      const value = glbDocument(output);
      assert.deepEqual(value.scenes, [{ nodes: [0, 2] }]);
      const ordinary = yield* parseAssemblySnapshotDraft(context, fixture.definition);
      assert.throws(() => readOnshapeExportGeometry(ordinary, input));
    }),
  );
  it.effect(
    "extracts validated source geometry, retains color, and removes occurrence placement",
    () =>
      Effect.gen(function* () {
        const fixture = bulkFixture(2);
        const draft = yield* parseAssemblySnapshotDraft(context, fixture.definition);
        const normalized = yield* normalizeOnshapeExport(fixture.bytes);
        const geometry = readOnshapeExportGeometry(draft, normalized);
        for (const part of draft.parts) {
          const bytes = geometry.extract(part.geometryKey);
          yield* normalizeCadGeometry(bytes);
          const document = glbDocument(bytes);
          assert.deepEqual(document.materials, fixture.gltf.materials);
          assert.deepEqual(document.accessors, fixture.gltf.accessors);
          assert.notProperty((document.nodes as Array<Record<string, unknown>>)[0]!, "translation");
          assert.equal((document.buffers as Array<{ byteLength: number }>)[0]!.byteLength, 72);
        }
      }),
  );
  it.effect("requires occurrence IDs and rejects placement drift", () =>
    Effect.gen(function* () {
      const fixture = bulkFixture(2);
      const draft = yield* parseAssemblySnapshotDraft(context, fixture.definition);
      const missing = {
        ...fixture.gltf,
        nodes: fixture.gltf.nodes.map((node) => ({ ...node, extensions: undefined })),
      };
      const missingBytes = yield* normalizeOnshapeExport(encode(missing));
      assert.throws(() => readOnshapeExportGeometry(draft, missingBytes));
      const moved = {
        ...fixture.gltf,
        nodes: fixture.gltf.nodes.map((node, i) =>
          i === 2 ? { ...node, translation: [9, 0, 0] } : node,
        ),
      };
      const movedBytes = yield* normalizeOnshapeExport(encode(moved));
      assert.throws(() => readOnshapeExportGeometry(draft, movedBytes));
    }),
  );
  it.effect("matches nested occurrence paths containing slash and plus characters", () =>
    Effect.gen(function* () {
      const fixture = bulkFixture(1);
      const part = fixture.definition.rootAssembly.instances[0]!;
      const subRef = {
        documentId: root.documentId,
        documentMicroversion: bulkMicroversion,
        elementId: "999999999999999999999999",
        configuration: "default",
      };
      const parent = "sub/+1",
        child = "part/+1";
      const transform = (x: number) => [1, 0, 0, x, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
      const definition = {
        ...fixture.definition,
        rootAssembly: {
          ...fixture.definition.rootAssembly,
          instances: [
            { ...subRef, id: parent, type: "Assembly", name: "Nested", suppressed: false },
          ],
          occurrences: [
            { path: [parent], hidden: false, transform: transform(2) },
            { path: [parent, child], hidden: false, transform: transform(5) },
          ],
        },
        subAssemblies: [{ ...subRef, instances: [{ ...part, id: child }] }],
      };
      const gltf = {
        ...fixture.gltf,
        nodes: [
          fixture.gltf.nodes[0],
          {
            extensions: { PTC_onshape_metadata: { id: [child] } },
            children: [0],
            translation: [3, 0, 0],
          },
          {
            extensions: { PTC_onshape_metadata: { id: [parent] } },
            children: [1],
            translation: [2, 0, 0],
          },
        ],
      };
      const draft = yield* parseAssemblySnapshotDraft(context, definition);
      const normalized = yield* normalizeOnshapeExport(encode(gltf));
      const bytes = readOnshapeExportGeometry(draft, normalized).extract(
        draft.parts[0]!.geometryKey,
      );
      yield* normalizeCadGeometry(bytes);
      // Onshape can flatten the assembly group while preserving full leaf IDs
      // and an internal grouping ID absent from the assembly definition.
      const flattened = {
        ...gltf,
        nodes: [
          gltf.nodes[0],
          {
            ...gltf.nodes[1],
            extensions: { PTC_onshape_metadata: { id: [parent, "internal-group", child] } },
            translation: [5, 0, 0],
          },
          { ...gltf.nodes[2], translation: [0, 0, 0] },
        ],
      };
      const flatBytes = yield* normalizeOnshapeExport(encode(flattened));
      yield* normalizeCadGeometry(
        readOnshapeExportGeometry(draft, flatBytes).extract(draft.parts[0]!.geometryKey),
      );
    }),
  );
});
