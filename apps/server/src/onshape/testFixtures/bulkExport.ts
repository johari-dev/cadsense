import { OnshapeElementId, OnshapeProjectSource, ProjectId } from "@cadsense/contracts";
import * as Schema from "effect/Schema";

export const bulkSource = Schema.decodeUnknownSync(OnshapeProjectSource)({
  connectionId: "00000000-0000-4000-8000-000000000001",
  host: "https://cad.onshape.com",
  documentId: "111111111111111111111111",
  workspaceType: "w",
  workspaceId: "222222222222222222222222",
  configuration: "default",
});
export const bulkMicroversion = "333333333333333333333333";
export const bulkInput = {
  projectId: ProjectId.make("bulk-test"),
  source: bulkSource,
  root: {
    elementId: OnshapeElementId.make("444444444444444444444444"),
    kind: "assembly" as const,
    configuration: "default",
  },
};
export const bulkTranslationId = "aaaaaaaaaaaaaaaaaaaaaaaa";
export const bulkExternalId = "bbbbbbbbbbbbbbbbbbbbbbbb";
export const translationDone = {
  id: bulkTranslationId,
  requestState: "DONE",
  resultDocumentId: bulkSource.documentId,
  resultExternalDataIds: [bulkExternalId],
};
export const encodeFixture = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

/** Same PTC metadata layout as Onshape's exports, with small deterministic triangles. */
export function bulkFixture(count = 400) {
  const source = {
    documentId: "555555555555555555555555",
    documentMicroversion: "666666666666666666666666",
    documentVersion: "777777777777777777777777",
    elementId: "888888888888888888888888",
    configuration: "default",
    fullConfiguration: "default",
  };
  const parts = Array.from({ length: count }, (_, i) => ({
    ...source,
    partId: `part-${i}`,
    bodyType: "solid",
  }));
  const instances = parts.map((part, i) => ({
    ...part,
    id: `instance-${i}`,
    name: `Part ${i} <1>`,
    type: "Part",
    suppressed: false,
  }));
  const definition = {
    rootAssembly: {
      documentId: bulkSource.documentId,
      documentMicroversion: bulkMicroversion,
      elementId: bulkInput.root.elementId,
      configuration: "default",
      fullConfiguration: "default",
      instances,
      occurrences: instances.map((instance, i) => ({
        path: [instance.id],
        hidden: false,
        transform: [1, 0, 0, i * 0.01, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
      })),
    },
    subAssemblies: [],
    parts,
  };
  const buffer = Buffer.from(
    new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 1, 0, 0, 1]).buffer,
  );
  const gltf = {
    asset: { version: "2.0" },
    extensionsUsed: ["PTC_onshape_metadata"],
    scene: 0,
    scenes: [{ nodes: [count * 2] }],
    nodes: [
      ...parts.map((part, i) => ({
        extensions: { PTC_onshape_metadata: { id: [part.partId] } },
        name: `Part ${i}`,
        mesh: 0,
      })),
      ...instances.map((instance, i) => ({
        extensions: { PTC_onshape_metadata: { id: [instance.id] } },
        name: instance.name,
        children: [i],
        translation: [i * 0.01, 0, 0],
      })),
      { name: "Robot", children: instances.map((_, i) => count + i) },
    ],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1 }, material: 0 }] }],
    materials: [
      {
        pbrMetallicRoughness: {
          baseColorFactor: [0.2, 0.5, 0.8, 1],
          metallicFactor: 0,
          roughnessFactor: 0.7,
        },
      },
    ],
    buffers: [
      {
        byteLength: buffer.length,
        uri: `data:application/octet-stream;base64,${buffer.toString("base64")}`,
      },
    ],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: 36, target: 34962 },
      { buffer: 0, byteOffset: 36, byteLength: 36, target: 34962 },
    ],
    accessors: [
      {
        bufferView: 0,
        componentType: 5126,
        count: 3,
        type: "VEC3",
        min: [0, 0, 0],
        max: [1, 1, 0],
      },
      { bufferView: 1, componentType: 5126, count: 3, type: "VEC3" },
    ],
  };
  const metadata = parts.map((part, i) => ({
    partId: part.partId,
    name: `Part ${i}`,
    bodyType: part.bodyType,
    elementId: part.elementId,
    microversionId: part.documentMicroversion,
    appearance: { color: { red: 64, green: 64, blue: 64 }, opacity: 255 },
  }));
  return { definition, metadata, gltf, bytes: new TextEncoder().encode(encodeFixture(gltf)) };
}
