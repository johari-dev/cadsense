import {
  CadSnapshotRoot,
  CadSnapshotManifest,
  ProjectId,
  type CadGeometryAsset,
  type CadSnapshotDraft,
} from "@cadsense/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  completeSnapshotManifest,
  enrichSnapshotMetadata,
  parseAssemblySnapshotDraft,
  parsePartStudioSnapshotDraft,
  snapshotGeometryKey,
  snapshotPartStudioGroups,
  snapshotRootId,
} from "./OnshapeSnapshotManifest.ts";

const doc = "111111111111111111111111";
const isCompleteManifest = Schema.is(CadSnapshotManifest);
const mid = "aaaaaaaaaaaaaaaaaaaaaaaa";
const rootElement = "bbbbbbbbbbbbbbbbbbbbbbbb";
const subElement = "cccccccccccccccccccccccc";
const partElement = "dddddddddddddddddddddddd";
const linkedDoc = "222222222222222222222222";
const linkedMid = "eeeeeeeeeeeeeeeeeeeeeeee";
const linkedVersion = "ffffffffffffffffffffffff";
const root = Schema.decodeUnknownSync(CadSnapshotRoot)({
  host: "https://cad.onshape.com",
  documentId: doc,
  elementId: rootElement,
  kind: "assembly",
  originalRevision: { kind: "w", id: "999999999999999999999999" },
  microversionId: mid,
  configuration: "default",
  tessellationProfile: "test-medium-v1",
});
const context = {
  snapshotId: "00000000-0000-4000-8000-000000000001",
  projectId: ProjectId.make("project"),
  createdAt: "2026-09-05T00:00:00Z",
  root,
  rootId: snapshotRootId(root),
};
const transform = (x: number) => [1, 0, 0, x, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const rootRef = {
  documentId: doc,
  documentMicroversion: mid,
  elementId: rootElement,
  configuration: "default",
  fullConfiguration: "default",
};
const subRef = {
  documentId: linkedDoc,
  documentMicroversion: linkedMid,
  documentVersion: linkedVersion,
  elementId: subElement,
  configuration: "Position=Raised",
  fullConfiguration: "Position=Raised",
};
const partRef = {
  documentId: linkedDoc,
  documentMicroversion: linkedMid,
  documentVersion: linkedVersion,
  elementId: partElement,
  configuration: "Size=Large",
  fullConfiguration: "Size=Large;Width=10+mm",
  partId: "JHD",
};
const assembly = () => ({
  rootAssembly: {
    ...rootRef,
    instances: [
      { ...subRef, id: "sub-1", name: "Intake <1>", type: "Assembly", suppressed: false },
      { ...subRef, id: "sub-2", name: "Intake <2>", type: "Assembly", suppressed: false },
      {
        ...partRef,
        partId: "SUPPRESSED",
        id: "suppressed",
        name: "Suppressed part",
        type: "Part",
        suppressed: true,
      },
    ],
    occurrences: [
      { path: ["sub-1"], hidden: false, transform: transform(0.05) },
      { path: ["sub-1", "bolt"], hidden: false, transform: transform(0.08) },
      { path: ["sub-2"], hidden: true, transform: transform(0.1) },
      { path: ["sub-2", "bolt"], hidden: false, transform: transform(0.13) },
    ],
  },
  subAssemblies: [
    {
      ...subRef,
      instances: [{ ...partRef, id: "bolt", name: "Bolt", type: "Part", suppressed: false }],
    },
  ],
  parts: [partRef],
});
const metadata = [
  {
    partId: "JHD",
    name: "Configured bolt",
    elementId: partElement,
    microversionId: linkedMid,
    bodyType: "solid",
    isHidden: false,
    isMesh: false,
    appearance: { color: { red: 120, green: 130, blue: 140 }, opacity: 255 },
    material: {
      displayName: "Steel",
      id: "steel",
      libraryName: "Test",
      properties: [{ name: "density", value: "7850", units: "kg/m^3" }],
    },
  },
];
function assetsFor(draft: CadSnapshotDraft): CadGeometryAsset[] {
  return draft.parts
    .filter((part) => part.geometryRequired)
    .map((part) => ({
      geometryKey: part.geometryKey,
      sha256: "a".repeat(64),
      byteLength: 64,
      format: "glb",
      relativePath: `${"a".repeat(64)}.glb`,
    }));
}

describe("Onshape snapshot semantic normalization", () => {
  it.effect(
    "preserves suppressed empty-part-ID placeholders seen in evaluated assembly responses",
    () =>
      Effect.gen(function* () {
        const value = assembly();
        value.rootAssembly.instances[2] = {
          ...partRef,
          partId: "",
          id: "suppressed",
          name: "Suppressed part",
          type: "Part",
          suppressed: true,
        };
        value.parts.push({ ...partRef, partId: "" });
        const draft = yield* parseAssemblySnapshotDraft(context, value);
        const placeholder = draft.nodes.find((node) => node.instanceId === "suppressed")!;
        assert.isNull(placeholder.sourcePartKey);
        assert.strictEqual(placeholder.suppressed, true);
        assert.strictEqual(snapshotPartStudioGroups(draft).length, 1);
        value.rootAssembly.instances[2] = {
          ...value.rootAssembly.instances[2]!,
          suppressed: false,
        };
        value.rootAssembly.occurrences.push({
          path: ["suppressed"],
          hidden: false,
          transform: transform(0),
        });
        assert.strictEqual(
          (yield* Effect.flip(parseAssemblySnapshotDraft(context, value))).reason,
          "missing-reference",
        );
      }),
  );
  it.effect(
    "keeps recursive instance identity, absolute transforms, hidden geometry and suppressed placeholders",
    () =>
      Effect.gen(function* () {
        const draft = yield* parseAssemblySnapshotDraft(context, assembly());
        assert.strictEqual(draft.nodes.length, 6);
        const bolts = draft.nodes.filter((node) => node.instanceId === "bolt");
        assert.strictEqual(bolts.length, 2);
        assert.notStrictEqual(bolts[0]!.id, bolts[1]!.id);
        assert.strictEqual(bolts[0]!.sourcePartKey, bolts[1]!.sourcePartKey);
        assert.deepStrictEqual(bolts.map((node) => node.transform[3]).sort(), [0.08, 0.13]);
        assert.strictEqual(bolts.filter((node) => node.defaultVisible).length, 1);
        assert.strictEqual(draft.parts.filter((part) => part.geometryRequired).length, 1);
        const suppressed = draft.nodes.find((node) => node.instanceId === "suppressed")!;
        assert.strictEqual(suppressed.suppressed, true);
        assert.strictEqual(suppressed.defaultVisible, false);
        const groups = snapshotPartStudioGroups(draft);
        assert.strictEqual(groups.length, 1);
        assert.strictEqual(groups[0]!.source.documentVersion, linkedVersion);
        assert.strictEqual(groups[0]!.source.documentMicroversion, linkedMid);
        assert.strictEqual(groups[0]!.source.fullConfiguration, partRef.fullConfiguration);
        assert.strictEqual(draft.dependencies.length, 3);
        const enriched = yield* enrichSnapshotMetadata(draft, [
          { source: groups[0]!.source, response: metadata },
        ]);
        const complete = yield* completeSnapshotManifest(enriched, assetsFor(enriched));
        assert.strictEqual(complete.assets.length, 1);
        assert.deepStrictEqual(
          complete.parts.find((part) => part.geometryRequired)!.metadata?.appearance,
          metadata[0]!.appearance,
        );
        assert.strictEqual(
          complete.parts.find((part) => part.geometryRequired)!.metadata?.material?.displayName,
          "Steel",
        );
      }),
  );
  it.effect(
    "geometry identity includes configured dependency and tessellation without depending on occurrence path",
    () =>
      Effect.gen(function* () {
        const draft = yield* parseAssemblySnapshotDraft(context, assembly());
        const part = draft.parts.find((item) => item.geometryRequired)!;
        assert.notStrictEqual(
          snapshotGeometryKey({ ...part.source, fullConfiguration: "Size=Small" }),
          part.geometryKey,
        );
        assert.notStrictEqual(
          snapshotGeometryKey({ ...part.source, tessellationProfile: "test-fine" }),
          part.geometryKey,
        );
        assert.strictEqual(
          snapshotGeometryKey({ ...part.source, documentVersion: null }),
          part.geometryKey,
        );
      }),
  );
  it.effect("normalizes a multi-part Part Studio with optional metadata and hidden parts", () =>
    Effect.gen(function* () {
      const studioRoot = { ...root, kind: "part-studio" as const, elementId: root.elementId };
      const draft = yield* parsePartStudioSnapshotDraft(
        { ...context, root: studioRoot, rootId: snapshotRootId(studioRoot) },
        [
          { partId: "A", name: "Body", bodyType: "solid" },
          { partId: "B", name: "Surface", bodyType: "sheet", isHidden: true, isMesh: true },
        ],
      );
      assert.strictEqual(draft.nodes.length, 3);
      assert.deepStrictEqual(draft.nodes[1]!.transform, transform(0));
      assert.strictEqual(draft.nodes[2]!.defaultVisible, false);
      assert.strictEqual(draft.parts[1]!.geometryRequired, true);
      assert.isNull(draft.parts[0]!.metadata?.material);
      assert.strictEqual(
        (yield* completeSnapshotManifest(draft, assetsFor(draft))).assets.length,
        2,
      );
    }),
  );
  it.effect.each([
    (value: ReturnType<typeof assembly>) => {
      value.rootAssembly.occurrences.push(value.rootAssembly.occurrences[0]!);
    },
    (value: ReturnType<typeof assembly>) => {
      value.rootAssembly.occurrences[0]!.transform[0] = Number.NaN;
    },
    (value: ReturnType<typeof assembly>) => {
      value.rootAssembly.occurrences[0]!.transform[15] = 0;
    },
    (value: ReturnType<typeof assembly>) => {
      value.rootAssembly.occurrences[0]!.transform[0] = 0;
    },
    (value: ReturnType<typeof assembly>) => {
      value.subAssemblies = [];
    },
    (value: ReturnType<typeof assembly>) => {
      value.parts = [];
    },
    (value: ReturnType<typeof assembly>) => {
      value.rootAssembly.occurrences[0]!.path = ["orphan"];
    },
    (value: ReturnType<typeof assembly>) => {
      value.rootAssembly.instances.push(value.rootAssembly.instances[0]!);
    },
  ])("rejects ambiguous or invalid source topology %#", (mutate) =>
    Effect.gen(function* () {
      const value = assembly();
      mutate(value);
      const failure = yield* Effect.flip(parseAssemblySnapshotDraft(context, value));
      assert.strictEqual(failure._tag, "OnshapeSnapshotManifestError");
      assert.notProperty(failure, "cause");
    }),
  );
  it.effect("rejects missing metadata, mismatched revision and incomplete/extraneous assets", () =>
    Effect.gen(function* () {
      const draft = yield* parseAssemblySnapshotDraft(context, assembly());
      const group = snapshotPartStudioGroups(draft)[0]!;
      assert.strictEqual(
        (yield* Effect.flip(enrichSnapshotMetadata(draft, []))).reason,
        "missing-reference",
      );
      assert.strictEqual(
        (yield* Effect.flip(
          enrichSnapshotMetadata(draft, [
            { source: group.source, response: [{ ...metadata[0], microversionId: mid }] },
          ]),
        )).reason,
        "missing-reference",
      );
      const enriched = yield* enrichSnapshotMetadata(draft, [
        { source: group.source, response: metadata },
      ]);
      assert.isFalse(isCompleteManifest({ ...enriched, assets: [] }));
      assert.strictEqual(
        (yield* Effect.flip(completeSnapshotManifest(enriched, []))).reason,
        "incomplete-assets",
      );
      const assets = assetsFor(enriched);
      assert.strictEqual(
        (yield* Effect.flip(completeSnapshotManifest(enriched, [...assets, assets[0]!]))).reason,
        "incomplete-assets",
      );
      assert.strictEqual(
        (yield* Effect.flip(
          completeSnapshotManifest(enriched, [{ ...assets[0]!, relativePath: "../escape.glb" }]),
        )).reason,
        "invalid-response",
      );
    }),
  );
  it.effect(
    "rejects forged completion with orphan paths, hidden-state contradictions and changed root identity",
    () =>
      Effect.gen(function* () {
        const draft = yield* parseAssemblySnapshotDraft(context, assembly());
        const enriched = yield* enrichSnapshotMetadata(draft, [
          { source: snapshotPartStudioGroups(draft)[0]!.source, response: metadata },
        ]);
        const assets = assetsFor(enriched);
        const nodes = enriched.nodes.map((node) =>
          node.suppressed ? { ...node, defaultVisible: true } : node,
        );
        assert.strictEqual(
          (yield* Effect.flip(completeSnapshotManifest({ ...enriched, nodes }, assets))).reason,
          "invalid-topology",
        );
        const orphan = enriched.nodes.map((node, index) =>
          index === 1 ? { ...node, parentId: "b".repeat(64) } : node,
        );
        assert.strictEqual(
          (yield* Effect.flip(completeSnapshotManifest({ ...enriched, nodes: orphan }, assets)))
            .reason,
          "invalid-topology",
        );
        assert.strictEqual(
          (yield* Effect.flip(
            completeSnapshotManifest({ ...enriched, rootId: "c".repeat(64) }, assets),
          )).reason,
          "invalid-response",
        );
      }),
  );
});
