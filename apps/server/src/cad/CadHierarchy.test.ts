import { CadHierarchyResult, CadSnapshotManifest, ProjectId } from "@cadsense/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { readCadHierarchy } from "./CadHierarchy.ts";
import { CAD_TOOL_PAGE_BYTES, indexCadSnapshot, initialCadView } from "./CadViewState.ts";

const id = (value: number) => value.toString(16).padStart(64, "0");
const rootId = id(1_000_000);
const partKey = id(1_000_001);
const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const source = {
  host: "https://cad.onshape.com",
  documentId: "a".repeat(24),
  documentMicroversion: "d".repeat(24),
  documentVersion: null,
  elementId: "b".repeat(24),
  configuration: "default",
  fullConfiguration: "default",
  tessellationProfile: "test",
};
const decodeManifest = Schema.decodeUnknownSync(CadSnapshotManifest);
const encodePage = Schema.encodeSync(Schema.fromJsonString(CadHierarchyResult));
const pageBytes = (page: CadHierarchyResult) => new TextEncoder().encode(encodePage(page)).length;

/** Occurrence 1 is the only top-level node; each name becomes one of its part children, numbered from 2. */
const manifest = (names: ReadonlyArray<string>, material = "6061-T6 Aluminum") =>
  decodeManifest({
    schemaVersion: 1,
    snapshotId: "00000000-0000-4000-8000-000000000001",
    rootId,
    projectId: ProjectId.make("test"),
    createdAt: "2026-09-28T00:00:00Z",
    root: {
      host: source.host,
      documentId: source.documentId,
      elementId: source.elementId,
      kind: "assembly",
      originalRevision: { kind: "w", id: "c".repeat(24) },
      microversionId: source.documentMicroversion,
      configuration: "default",
      tessellationProfile: "test",
    },
    nodes: [
      { number: 1, parent: null, name: "Cascade", part: false },
      ...names.map((name, index) => ({ number: index + 2, parent: 1, name, part: true })),
    ].map(({ number, parent, name, part }) => ({
      id: id(number),
      parentId: parent === null ? null : id(parent),
      name,
      occurrencePath: [String(number)],
      instanceId: String(number),
      kind: part ? "part" : "assembly",
      suppressed: false,
      defaultVisible: true,
      transform: identity,
      sourcePartKey: part ? partKey : null,
    })),
    parts: [
      {
        geometryKey: partKey,
        source: { ...source, partId: "A" },
        geometryRequired: false,
        metadata: {
          name: "Tube",
          bodyType: "solid",
          isHidden: null,
          isMesh: null,
          partIdentity: null,
          configurationId: null,
          appearance: null,
          material: { displayName: material },
          massKg: 0.2381,
        },
      },
    ],
    dependencies: [],
    assets: [],
  });

/** Follows nextCursor from the first page to the last, as an agent would. */
const readAllPages = (snapshot: CadSnapshotManifest, input: { limit?: number }) =>
  Effect.gen(function* () {
    const index = indexCadSnapshot(snapshot);
    const state = initialCadView(snapshot);
    const pages: CadHierarchyResult[] = [];
    let cursor: string | undefined;
    do {
      const page = yield* readCadHierarchy(index, state, {
        parentOccurrenceId: id(1),
        ...input,
        ...(cursor === undefined ? {} : { cursor }),
      });
      pages.push(page);
      cursor = page.nextCursor ?? undefined;
    } while (cursor !== undefined && pages.length <= 1_000);
    return pages;
  });

describe("cad_hierarchy paging", () => {
  it.effect(
    "keeps a 200-entry request on a large parent under the byte cap without dropping entries",
    () =>
      Effect.gen(function* () {
        // The shape of the elevator cascade that spilled: hundreds of vendor parts under one parent.
        const names = Array.from(
          { length: 450 },
          (_, i) => `2" x 1" x 0.125" MAXTube (30" L, Full Pattern, 0.5" Pitch) <${i + 1}>`,
        );
        const pages = yield* readAllPages(manifest(names), { limit: 200 });
        for (const page of pages) {
          assert.isAtMost(pageBytes(page), CAD_TOOL_PAGE_BYTES);
          assert.isNotEmpty(page.entries);
        }
        assert.deepEqual(
          pages.flatMap((page) => page.entries.map((entry) => entry.occurrenceId)),
          names.map((_, i) => id(i + 2)),
        );
        // The cap, not the limit, ended the first page: 200 of these entries would not fit.
        assert.isBelow(pages[0]!.entries.length, 200);
      }),
  );

  it.effect("names the parent once per page, with null for the top level", () =>
    Effect.gen(function* () {
      const snapshot = manifest(["Tube <1>", "Tube <2>"]);
      const index = indexCadSnapshot(snapshot);
      const state = initialCadView(snapshot);
      const top = yield* readCadHierarchy(index, state, {});
      assert.isNull(top.parentOccurrenceId);
      assert.deepEqual(
        top.entries.map((entry) => entry.occurrenceId),
        [id(1)],
      );
      const children = yield* readCadHierarchy(index, state, { parentOccurrenceId: id(1) });
      assert.equal(children.parentOccurrenceId, id(1));
      for (const entry of [...top.entries, ...children.entries])
        assert.notProperty(entry, "parentOccurrenceId");
    }),
  );

  it.effect("advances through entries at the name and material length limits", () =>
    Effect.gen(function* () {
      const names = Array.from({ length: 30 }, (_, i) => `${i}`.padEnd(4096, "x"));
      const pages = yield* readAllPages(manifest(names, "m".repeat(4096)), { limit: 200 });
      for (const page of pages) {
        assert.isAtMost(pageBytes(page), CAD_TOOL_PAGE_BYTES);
        assert.isNotEmpty(page.entries);
      }
      assert.deepEqual(
        pages.flatMap((page) => page.entries.map((entry) => entry.occurrenceId)),
        names.map((_, i) => id(i + 2)),
      );
    }),
  );

  it.effect("returns a page that already fits in one call", () =>
    Effect.gen(function* () {
      const names = Array.from({ length: 120 }, (_, i) => `Bolt <${i + 1}>`);
      const byDefault = yield* readAllPages(manifest(names), {});
      assert.deepEqual(
        byDefault.map((page) => page.entries.length),
        [100, 20],
      );
      const whole = yield* readAllPages(manifest(names), { limit: 120 });
      assert.equal(whole.length, 1);
      assert.equal(whole[0]!.entries.length, 120);
      assert.isNull(whole[0]!.nextCursor);
    }),
  );
});
