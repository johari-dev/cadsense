import { CadSnapshotRoot } from "@cadsense/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { readOnshapeThreeMf } from "./OnshapeThreeMf.ts";
import { normalizeCadGeometry } from "../cad/CadGeometry.ts";
import {
  parseAssemblySnapshotDraft,
  snapshotRootId,
  withAssemblyExportMetadata,
} from "./OnshapeSnapshotManifest.ts";
import { bulkFixture, bulkInput, bulkMicroversion } from "./testFixtures/bulkExport.ts";
import { threeMfArchive, threeMfXml } from "./testFixtures/threeMf.ts";

const root = Schema.decodeUnknownSync(CadSnapshotRoot)({
  host: bulkInput.source.host,
  documentId: bulkInput.source.documentId,
  elementId: bulkInput.root.elementId,
  kind: "assembly",
  originalRevision: { kind: "w", id: bulkInput.source.workspaceId },
  microversionId: bulkMicroversion,
  configuration: "default",
  tessellationProfile: "3mf-test",
});
const context = {
  snapshotId: "00000000-0000-4000-8000-000000000001",
  projectId: bulkInput.projectId,
  createdAt: "2026-09-10T00:00:00Z",
  root,
  rootId: snapshotRootId(root),
};
const draft = () => {
  const f = bulkFixture(2);
  return parseAssemblySnapshotDraft(context, f.definition).pipe(
    Effect.flatMap((d) => withAssemblyExportMetadata(d, f.definition)),
  );
};
const decodeGlb = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      materials: Schema.Array(
        Schema.Struct({
          pbrMetallicRoughness: Schema.Struct({ baseColorFactor: Schema.Array(Schema.Number) }),
        }),
      ),
    }),
  ),
);
describe("3MF source geometry", () => {
  it.effect("maps reordered instances and retains face colors in linear glTF space", () =>
    Effect.gen(function* () {
      const d = yield* draft(),
        xml = threeMfXml().replace(
          '<item objectid="2" transform="1 0 0 0 1 0 0 0 1 0 0 0"/><item objectid="3" transform="1 0 0 0 1 0 0 0 1 0.01 0 0"/>',
          '<item objectid="3" transform="1 0 0 0 1 0 0 0 1 0.01 0 0"/><item objectid="2" transform="1 0 0 0 1 0 0 0 1 0 0 0"/>',
        );
      const geometry = readOnshapeThreeMf(d, threeMfArchive(xml));
      for (const part of d.parts) {
        const b = yield* normalizeCadGeometry(geometry.extract(part.geometryKey));
        const doc = decodeGlb(
          new TextDecoder().decode(
            b.subarray(20, 20 + new DataView(b.buffer, b.byteOffset).getUint32(12, true)),
          ),
        );
        assert.lengthOf(doc.materials, 2);
        assert.closeTo(
          doc.materials[0]!.pbrMetallicRoughness.baseColorFactor[0]!,
          0.051269,
          0.00001,
        );
        assert.closeTo(
          doc.materials[1]!.pbrMetallicRoughness.baseColorFactor[0]!,
          0.0331048,
          0.00001,
        );
        assert.equal(doc.materials[1]!.pbrMetallicRoughness.baseColorFactor[1], 1);
      }
    }),
  );
  for (const [name, change] of [
    [
      "missing body",
      (x: string) => x.replace('<item objectid="2" transform="1 0 0 0 1 0 0 0 1 0 0 0"/>', ""),
    ],
    ["wrong placement", (x: string) => x.replace("0.01 0 0", "0.1 0 0")],
    ["wrong name", (x: string) => x.replace('name="Part 0"', 'name="Unknown"')],
    ["non-meter units", (x: string) => x.replace('unit="meter"', 'unit="inch"')],
    ["invalid vertex reference", (x: string) => x.replace('v3="2"', 'v3="999"')],
    ["external entity", (x: string) => '<!DOCTYPE model SYSTEM "https://example.com/evil">' + x],
    ["unsupported interpolated color", (x: string) => x.replace('p1="1"', 'p1="1" p2="0"')],
  ] as const)
    it.effect(`rejects ${name} before publishing`, () =>
      Effect.gen(function* () {
        const d = yield* draft();
        assert.throws(() => readOnshapeThreeMf(d, threeMfArchive(change(threeMfXml()))));
      }),
    );
  it.effect("rejects ambiguous same-name same-placement source instances", () =>
    Effect.gen(function* () {
      const d = yield* draft(),
        first = d.nodes.find((n) => n.sourcePartKey !== null)!;
      const ambiguous = {
        ...d,
        nodes: d.nodes.map((n) =>
          n.sourcePartKey !== null ? { ...n, name: first.name, transform: first.transform } : n,
        ),
        parts: d.parts.map((p) => ({
          ...p,
          metadata: p.metadata ? { ...p.metadata, name: "Part 0" } : p.metadata,
        })),
      };
      assert.throws(() => readOnshapeThreeMf(ambiguous, threeMfArchive(threeMfXml())));
    }),
  );
  it.effect("preserves source-ID reference geometry for ambiguous coincident parts", () =>
    Effect.gen(function* () {
      const d = yield* draft(),
        first = d.nodes.find((n) => n.sourcePartKey !== null)!;
      const ambiguous = {
        ...d,
        nodes: d.nodes.map((n) =>
          n.sourcePartKey !== null ? { ...n, name: first.name, transform: first.transform } : n,
        ),
        parts: d.parts.map((p) => ({
          ...p,
          metadata: p.metadata ? { ...p.metadata, name: "Part 0" } : p.metadata,
        })),
      };
      const original = readOnshapeThreeMf(d, threeMfArchive(threeMfXml()));
      const refs = new Map(d.parts.map((p) => [p.geometryKey, original.extract(p.geometryKey)]));
      const result = readOnshapeThreeMf(ambiguous, threeMfArchive(threeMfXml()), refs);
      for (const p of d.parts)
        assert.strictEqual(result.extract(p.geometryKey), refs.get(p.geometryKey));
    }),
  );
  it.effect("collects renamed composite member bodies at a unique source placement", () =>
    Effect.gen(function* () {
      const d = yield* draft(),
        first = d.parts[0]!;
      const composite = {
        ...d,
        nodes: d.nodes.filter(
          (n) => n.sourcePartKey === null || n.sourcePartKey === first.geometryKey,
        ),
        parts: [
          { ...first, metadata: { ...first.metadata!, bodyType: "composite", name: "Composite" } },
        ],
      };
      const xml = threeMfXml()
        .replace("0.01 0 0", "0 0 0")
        .replaceAll('name="Part', 'name="Member');
      const result = readOnshapeThreeMf(composite, threeMfArchive(xml));
      const bytes = yield* normalizeCadGeometry(result.extract(first.geometryKey));
      assert.isAbove(bytes.length, 0);
    }),
  );
  it.effect("does not assign an unnamed body to a composite sharing a solid's placement", () =>
    Effect.gen(function* () {
      const d = yield* draft(),
        first = d.nodes.find((n) => n.sourcePartKey !== null)!;
      const collision = {
        ...d,
        nodes: d.nodes.map((n) =>
          n.sourcePartKey !== null ? { ...n, transform: first.transform } : n,
        ),
        parts: d.parts.map((p, i) => ({
          ...p,
          metadata: p.metadata
            ? { ...p.metadata, bodyType: i === 0 ? "composite" : "solid" }
            : p.metadata,
        })),
      };
      const original = readOnshapeThreeMf(d, threeMfArchive(threeMfXml()));
      const refs = new Map(d.parts.map((p) => [p.geometryKey, original.extract(p.geometryKey)]));
      const result = readOnshapeThreeMf(
        collision,
        threeMfArchive(
          threeMfXml().replace('name="Part 0"', 'name="Unknown"').replace("0.01 0 0", "0 0 0"),
        ),
        refs,
      );
      for (const p of d.parts)
        assert.strictEqual(result.extract(p.geometryKey), refs.get(p.geometryKey));
    }),
  );
});
