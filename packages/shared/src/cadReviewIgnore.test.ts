import { CadReviewIgnoreMatch, CadSnapshotManifest, ProjectId } from "@cadsense/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  compileCadReviewGlob,
  describeCadReviewIgnoreMatch,
  ignoredCadOccurrences,
  matchesCadReviewIgnore,
} from "./cadReviewIgnore.ts";

const decodeIgnore = Schema.decodeUnknownSync(Schema.Array(CadReviewIgnoreMatch));
const decodeSnapshot = Schema.decodeUnknownSync(CadSnapshotManifest);

describe("compileCadReviewGlob", () => {
  it.each([
    ["Drivetrain/*", "Drivetrain/Gearbox", true],
    ["Drivetrain/*", "Drivetrain/Gearbox/Gear", false],
    ["Drivetrain/**", "Drivetrain/Gearbox/Gear", true],
    ["Drivetrain/**", "Drivetrain", true],
    ["**/Gear", "Drivetrain/Gearbox/Gear", true],
    ["**/Gear", "Gear", true],
    ["**/Gear", "Gear/Tooth", false],
    ["*/Gear*", "Drivetrain/Gear <2>", true],
    ["Gear <?>", "Gear <2>", true],
    ["Gear <?>", "Gear <12>", false],
    ["drivetrain/GEARBOX", "Drivetrain/Gearbox", true],
    ["Bracket (Left)", "Bracket (Left)", true],
    ["Bracket (Left)", "Bracket Left", false],
    ["Chassis", "Chassis Plate", false],
  ])("%s against %s is %s", (pattern, subject, expected) => {
    expect(compileCadReviewGlob(pattern).test(subject)).toBe(expected);
  });
});

describe("matchesCadReviewIgnore", () => {
  const gear = { path: "Drivetrain <1>/Gearbox <1>/Gear <2>", name: "Gear <2>", material: "Steel" };

  it("matches each field on its own", () => {
    expect(matchesCadReviewIgnore({ path: "drivetrain*/**" }, gear)).toBe(true);
    expect(matchesCadReviewIgnore({ name: "gear*" }, gear)).toBe(true);
    expect(matchesCadReviewIgnore({ material: "*steel*" }, gear)).toBe(true);
  });

  it("requires every listed field to match", () => {
    expect(matchesCadReviewIgnore({ path: "Drivetrain*/**", material: "Steel" }, gear)).toBe(true);
    expect(matchesCadReviewIgnore({ path: "Drivetrain*/**", material: "Aluminum" }, gear)).toBe(
      false,
    );
    expect(matchesCadReviewIgnore({ name: "Gear*", path: "Chassis/**" }, gear)).toBe(false);
  });

  it("never matches a material glob against a component without a material", () => {
    expect(matchesCadReviewIgnore({ material: "*" }, { ...gear, material: null })).toBe(false);
  });

  it("describes the listed fields in a fixed order", () => {
    expect(describeCadReviewIgnoreMatch({ material: "*steel*", path: "Drivetrain/**" })).toBe(
      "path Drivetrain/**, material *steel*",
    );
  });
});

describe("ignoredCadOccurrences", () => {
  const id = (value: number) => value.toString(16).padStart(64, "0");
  const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const partSource = {
    host: "https://cad.onshape.com",
    documentId: "a".repeat(24),
    documentMicroversion: "d".repeat(24),
    documentVersion: null,
    elementId: "b".repeat(24),
    configuration: "default",
    fullConfiguration: "default",
    partId: "JHD",
    tessellationProfile: "test",
  };
  const part = (geometryKey: string, material: string | null) => ({
    geometryKey,
    source: partSource,
    geometryRequired: false,
    metadata: {
      name: "Part",
      bodyType: "solid",
      isHidden: null,
      isMesh: null,
      partIdentity: null,
      configurationId: null,
      appearance: null,
      material: material === null ? null : { displayName: material },
    },
  });
  // Children are listed before their parents to check the flag does not depend on node order.
  const snapshot = decodeSnapshot({
    schemaVersion: 1,
    snapshotId: "00000000-0000-4000-8000-000000000001",
    rootId: id(20),
    projectId: ProjectId.make("test"),
    createdAt: "2026-09-05T00:00:00Z",
    root: {
      host: "https://cad.onshape.com",
      documentId: "a".repeat(24),
      elementId: "b".repeat(24),
      kind: "assembly",
      originalRevision: { kind: "w", id: "c".repeat(24) },
      microversionId: "d".repeat(24),
      configuration: "default",
      tessellationProfile: "test",
    },
    nodes: [
      { number: 5, parent: 3, name: "Gear <1>", kind: "part", part: id(31) },
      { number: 3, parent: 2, name: "Gearbox <1>", kind: "assembly" },
      { number: 2, parent: 1, name: "Drivetrain <1>", kind: "assembly" },
      { number: 1, parent: null, name: "Assembly", kind: "assembly" },
      { number: 4, parent: 1, name: "Chassis <1>", kind: "part", part: id(32) },
      { number: 6, parent: 1, name: "Bolt <1>", kind: "part", part: id(33) },
    ].map(({ number, parent, name, kind, part }) => ({
      id: id(number),
      parentId: parent === null ? null : id(parent),
      name,
      occurrencePath: parent === null ? [] : [String(number)],
      instanceId: parent === null ? null : String(number),
      kind,
      suppressed: false,
      defaultVisible: true,
      transform: identity,
      sourcePartKey: part ?? null,
    })),
    parts: [part(id(31), "Steel"), part(id(32), "Aluminum"), part(id(33), null)],
    dependencies: [],
    assets: [],
  });

  it("flags matching occurrences and everything inside a matching assembly", () => {
    const ignored = ignoredCadOccurrences(decodeIgnore([{ path: "Drivetrain*" }]), snapshot);
    expect([...ignored].sort()).toEqual([id(2), id(3), id(5)].sort());
  });

  it("matches materials through the source part", () => {
    const ignored = ignoredCadOccurrences(decodeIgnore([{ material: "alu*" }]), snapshot);
    expect([...ignored]).toEqual([id(4)]);
  });

  it("flags nothing without entries and never flags the root", () => {
    expect(ignoredCadOccurrences([], snapshot).size).toBe(0);
    expect(ignoredCadOccurrences(decodeIgnore([{ name: "Assembly" }]), snapshot).size).toBe(0);
  });
});
