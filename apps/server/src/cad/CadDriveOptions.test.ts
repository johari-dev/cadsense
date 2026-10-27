import {
  CadDriveOptionsResult,
  CadSnapshotManifest,
  type CadDriveFamily,
} from "@cadsense/contracts";
import { assert, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { CadTriangleMesh } from "./CadChecks.ts";
import type { CadDrivetrainFinding } from "./CadDrivetrain.ts";
import {
  DRIVE_CATALOG,
  driveMotorFromName,
  jackshaftPositions,
  readCadDriveOptions,
  searchDriveOptions,
  type DriveSearch,
} from "./CadDriveOptions.ts";
import { INCH, along, beltLoop, cylinder, scene, toMesh } from "./CadDrivetrain.testFixtures.ts";
import { initialCadView } from "./CadViewState.ts";

// Each case maps to one line of "Ways this can fail" in CadDriveOptions.md.

const ALL: readonly CadDriveFamily[] = [
  "gear-20dp",
  "gear-32dp",
  "htd-5mm",
  "gt2-3mm",
  "rt25",
  "chain-25",
  "chain-35",
];
const search = (overrides: Partial<DriveSearch>) =>
  searchDriveOptions({
    reduction: 3,
    tolerance: 0.03,
    families: ALL,
    maxStages: 2,
    driverBore: null,
    centerMeters: null,
    limit: 12,
    ...overrides,
  });
const product = (stages: readonly { readonly reduction: number }[]) =>
  stages.reduce((total, stage) => total * stage.reduction, 1);
const pitchMm = { "htd-5mm": 5, "gt2-3mm": 3, rt25: 6.35, "chain-25": 6.35, "chain-35": 9.525 };
const pitchRadius = (family: CadDriveFamily, teeth: number) =>
  family.startsWith("gear")
    ? (teeth / (2 * (family === "gear-20dp" ? 20 : 32))) * INCH
    : (teeth * pitchMm[family as keyof typeof pitchMm]) / (2 * Math.PI) / 1000;

describe("ratios", () => {
  it("reduces for a reduction target and speeds up for a speed-up target", () => {
    for (const option of search({ reduction: 3 }).options) {
      expect(product(option.stages)).toBeCloseTo(option.reduction, 3);
      for (const stage of option.stages) {
        expect(stage.driven.teeth / stage.driver.teeth).toBeCloseTo(stage.reduction, 3);
        expect(stage.reduction).toBeGreaterThanOrEqual(1);
      }
    }
    for (const option of search({ reduction: 0.5 }).options)
      for (const stage of option.stages) expect(stage.reduction).toBeLessThanOrEqual(1);
  });

  it("keeps every option inside the tolerance and finds an exact single stage", () => {
    const { options } = search({ reduction: 3, families: ["gear-20dp"], maxStages: 1 });
    expect(options.length).toBeGreaterThan(0);
    for (const option of options)
      expect(Math.abs(option.reduction / 3 - 1)).toBeLessThanOrEqual(0.03);
    expect(options[0]!.errorPercent).toBe(0);
    expect(options.every((option) => option.stages.length === 1)).toBe(true);
  });

  it("multiplies two stages, and ranks a single stage that hits the target first", () => {
    const deep = search({ reduction: 25 }).options;
    expect(deep.length).toBeGreaterThan(0);
    for (const option of deep) {
      expect(option.stages).toHaveLength(2);
      expect(Math.abs(product(option.stages) / 25 - 1)).toBeLessThanOrEqual(0.03);
    }
    expect(search({ reduction: 3 }).options[0]!.stages).toHaveLength(1);
  });

  it("returns the same options in the same order every time", () => {
    const center = { centerMeters: 6 * INCH };
    expect(search(center)).toEqual(search(center));
  });
});

describe("catalog parts", () => {
  const wheelTeeth = (family: CadDriveFamily) => {
    const fam = family;
    if (fam === "gear-20dp" || fam === "gear-32dp")
      return new Set(
        DRIVE_CATALOG.gears
          .filter((g) => g.dp === (fam === "gear-20dp" ? 20 : 32))
          .map((g) => g.teeth),
      );
    if (fam === "chain-25" || fam === "chain-35")
      return new Set(
        DRIVE_CATALOG.sprockets
          .filter((s) => s.chain === (fam === "chain-25" ? "#25" : "#35"))
          .map((s) => s.teeth),
      );
    const [profile, pitch] = { "htd-5mm": ["HTD", 5], "gt2-3mm": ["GT2", 3], rt25: ["RT25", 6.35] }[
      fam
    ];
    return new Set(
      DRIVE_CATALOG.pulleys
        .filter((p) => p.profile === profile && p.pitchMm === pitch)
        .map((p) => p.teeth),
    );
  };
  const beltTeeth = (family: "htd-5mm" | "gt2-3mm" | "rt25") => {
    const [profile, pitch] = { "htd-5mm": ["HTD", 5], "gt2-3mm": ["GT2", 3], rt25: ["RT25", 6.35] }[
      family
    ];
    return new Set(
      DRIVE_CATALOG.belts
        .filter((b) => b.profile === profile && b.pitchMm === pitch)
        .map((b) => b.teeth),
    );
  };

  it("offers only sizes the catalog sells, belts matched to their pulleys, and no gear under 10T", () => {
    for (const reduction of [1, 1.5, 2.5, 3, 4, 9, 25])
      for (const centerMeters of [null, 4.25 * INCH, 6 * INCH, 9 * INCH])
        for (const option of search({ reduction, centerMeters }).options)
          for (const stage of option.stages) {
            const sold = wheelTeeth(stage.family);
            expect(sold.has(stage.driver.teeth) && sold.has(stage.driven.teeth)).toBe(true);
            if (stage.family.startsWith("gear"))
              expect(Math.min(stage.driver.teeth, stage.driven.teeth)).toBeGreaterThanOrEqual(10);
            if (stage.loop && !stage.family.startsWith("chain"))
              expect(beltTeeth(stage.family as "htd-5mm").has(stage.loop.teeth)).toBe(true);
          }
  });

  it("gives the first wheel the requested bore", () => {
    const { options } = search({ reduction: 4, driverBore: "SplineXS" });
    expect(options.length).toBeGreaterThan(0);
    for (const option of options) {
      const driver = option.stages[0]!.driver;
      expect(driver.bores).toContain("SplineXS");
      for (const part of driver.parts) expect(part.bore).toBe("SplineXS");
    }
  });
});

describe("centers", () => {
  it("gives gears their spacing plus 0.003 in, and leaves belts and chains open without a center", () => {
    for (const option of search({ reduction: 3, centerMeters: null }).options)
      for (const stage of option.stages)
        if (stage.family === "gear-20dp")
          expect(stage.centerInches).toBeCloseTo(
            (stage.driver.teeth + stage.driven.teeth) / 40 + 0.003,
            4,
          );
        else if (!stage.family.startsWith("gear")) {
          expect(stage.centerInches).toBeNull();
          expect(stage.loop).toBeNull();
        }
  });

  it("wraps at least 6 belt teeth and keeps wheels apart", () => {
    for (const centerMeters of [3 * INCH, 4.25 * INCH, 6 * INCH])
      for (const option of search({ reduction: 2.5, centerMeters }).options)
        for (const stage of option.stages) {
          if (stage.centerInches === null || stage.family.startsWith("gear")) continue;
          const c = stage.centerInches * INCH;
          const small = pitchRadius(stage.family, stage.driver.teeth);
          const large = pitchRadius(stage.family, stage.driven.teeth);
          expect(c - small - large).toBeGreaterThanOrEqual(0.125 * INCH - 1e-5);
          if (!stage.family.startsWith("chain")) {
            const wrap = Math.PI - 2 * Math.asin((large - small) / c);
            expect((stage.driver.teeth * wrap) / (2 * Math.PI)).toBeGreaterThanOrEqual(6);
          }
        }
  });

  // The invariant: what the tool says fits, cad_checks passes once it is modeled.
  it("suggests belts and chains at a fixed center that cad_checks passes", () => {
    const center = 6 * INCH;
    const fitting = search({
      reduction: 2.5,
      maxStages: 1,
      families: ["htd-5mm", "chain-25"],
      centerMeters: center,
    }).options.filter((option) => option.fits);
    expect(fitting.length).toBeGreaterThan(0);
    for (const option of fitting) {
      const [stage] = option.stages;
      const s = scene();
      const chain = stage!.family === "chain-25";
      const [a, b] = [
        pitchRadius(stage!.family, stage!.driver.teeth),
        pitchRadius(stage!.family, stage!.driven.teeth),
      ];
      s.add(
        chain
          ? `${stage!.loop!.teeth}L #25 Chain <1>`
          : `${stage!.loop!.teeth}T 5M 9mm Wide Belt <1>`,
        beltLoop(center, [a, b], 0.009),
        along("y", [0, 0, 0]),
      );
      const wheel = chain ? "#25 Sprocket" : "HTD Pulley";
      s.add(
        `${stage!.driver.teeth}T ${wheel} <1>`,
        cylinder(a, 0.012),
        along("y", [-center / 2 / INCH, 0, 0]),
      );
      s.add(
        `${stage!.driven.teeth}T ${wheel} <1>`,
        cylinder(b, 0.012),
        along("y", [center / 2 / INCH, 0, 0]),
      );
      const lengths = s.analyze().filter((f: CadDrivetrainFinding) => f.kind === "loop-length");
      expect(lengths, stage!.recalcUrl).toHaveLength(1);
      expect(lengths[0]!.problem, lengths[0]!.summary).toBe(false);
    }
  });

  it("suggests gears at a fixed center that cad_checks passes", () => {
    const center = ((12 + 36) / 40 + 0.003) * INCH;
    const fitting = search({
      reduction: 3,
      maxStages: 1,
      families: ["gear-20dp"],
      centerMeters: center,
    }).options.filter((option) => option.fits);
    expect(fitting.map((option) => option.stages[0]!.driver.teeth)).toContain(12);
    for (const option of fitting) {
      const [stage] = option.stages;
      const s = scene();
      for (const [teeth, x] of [
        [stage!.driver.teeth, 0],
        [stage!.driven.teeth, center / INCH],
      ] as const)
        s.add(
          `${teeth}t Steel Spur Gear (20 DP, 1/2" Hex Bore) <1>`,
          cylinder(((teeth + 2) / 40) * INCH, 0.5 * INCH),
          along("y", [x, 0, 0]),
        );
      const meshes = s.analyze().filter((f: CadDrivetrainFinding) => f.kind === "gear-mesh");
      expect(meshes).toHaveLength(1);
      expect(meshes[0]!.problem, meshes[0]!.summary).toBe(false);
    }
  });

  it("only offers a jackshaft when its two centers reach between the axes", () => {
    const center = 6 * INCH;
    const twoStage = search({ reduction: 9, centerMeters: center }).options.filter(
      (option) => option.stages.length === 2 && option.fits,
    );
    expect(twoStage.length).toBeGreaterThan(0);
    for (const option of twoStage) {
      const [c1, c2] = option.jackshaftCenters!;
      expect(c1 + c2).toBeGreaterThanOrEqual(center - 1e-9);
      expect(Math.abs(c1 - c2)).toBeLessThanOrEqual(center + 1e-9);
      expect(option.stages[0]!.centerInches! * INCH).toBeCloseTo(c1, 5);
      expect(option.stages[1]!.centerInches! * INCH).toBeCloseTo(c2, 5);
    }
    // Gears alone are too small to span 20 in in two stages.
    const far = search({ reduction: 9, families: ["gear-20dp"], centerMeters: 20 * INCH });
    expect(far.options.filter((option) => option.fits)).toEqual([]);
    expect(far.notes.join(" ")).toContain("No stock drive");
  });

  it("places the jackshaft at each stage's center from its axis, across the axes", () => {
    const driver = {
      center: [0, 0.1, 0] as const,
      axis: [0, 1, 0] as const,
      halfLength: 0.05,
      radius: 0.03,
    };
    const driven = {
      center: [0.12, -0.2, 0.09] as const,
      axis: [0, -1, 0] as const,
      halfLength: 0.2,
      radius: 0.025,
    };
    const points = jackshaftPositions(driver, driven, 0.1, 0.08);
    expect(points).toHaveLength(2);
    for (const p of points) {
      expect(Math.hypot(p[0] - 0, p[2] - 0)).toBeCloseTo(0.1, 9);
      expect(Math.hypot(p[0] - 0.12, p[2] - 0.09)).toBeCloseTo(0.08, 9);
      expect(p[1]).toBeCloseTo(0.1, 9);
    }
  });
});

describe("speed targets", () => {
  it("reads the motor from its CAD name", () => {
    expect(driveMotorFromName("NEO 550 Brushless Motor <1>")).toBe("NEO 550");
    expect(driveMotorFromName("Kraken X44 <2>")).toBe("Kraken X44");
    expect(driveMotorFromName("Kraken X60")).toBe("Kraken X60");
    expect(driveMotorFromName("NEO Vortex <1>")).toBe("NEO Vortex");
    expect(driveMotorFromName("REV NEO Brushless Motor")).toBe("NEO");
    expect(driveMotorFromName("MiniCIM")).toBe("MiniCIM");
    expect(driveMotorFromName("Intake Roller")).toBeNull();
  });
});

// A manifest of the scene's parts, so the tool runs through its real entry point.
const source = {
  host: "cad.onshape.com",
  documentId: "a".repeat(24),
  documentMicroversion: "b".repeat(24),
  documentVersion: null,
  elementId: "c".repeat(24),
  configuration: "default",
  fullConfiguration: "default",
  partId: "test",
  tessellationProfile: "test-mesh",
};
const decodeManifest = Schema.decodeUnknownSync(CadSnapshotManifest);
const cad = (build: (s: ReturnType<typeof scene>) => void) => {
  const s = scene();
  const meshes = new Map<string, CadTriangleMesh | null>();
  const nodes: unknown[] = [];
  const parts: unknown[] = [];
  const add = s.add;
  s.add = (name, mesh, transform) => {
    const id = add(name, mesh, transform);
    const geometryKey = id.replace(/^0/, "f");
    meshes.set(geometryKey, toMesh(mesh));
    nodes.push({
      id,
      parentId: null,
      occurrencePath: [id],
      instanceId: id,
      name,
      kind: "part",
      suppressed: false,
      defaultVisible: true,
      sourcePartKey: geometryKey,
      transform,
    });
    parts.push({ geometryKey, source, geometryRequired: false, metadata: null });
    return id;
  };
  build(s);
  const manifest = decodeManifest({
    schemaVersion: 1,
    snapshotId: "00000000-0000-4000-8000-000000000002",
    rootId: "1".repeat(64),
    projectId: "test",
    createdAt: "2026-10-26T00:00:00Z",
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
    nodes,
    parts,
    assets: [],
    dependencies: [],
  });
  const state = initialCadView(manifest, 4);
  return (input: object) =>
    readCadDriveOptions(manifest, state, () => Effect.succeed(meshes), {
      expectedRevision: 4,
      ...input,
    });
};
const intake = (rollerAxis: "y" | "z" = "y") => {
  const ids = { motor: "", roller: "" };
  const run = cad((s) => {
    ids.motor = s.add("Kraken X60", cylinder(1.18 * INCH, 4 * INCH), along("y", [0, 8, 0]));
    // 6.000 in from the motor axis: 4.8 in across and 3.6 in up.
    ids.roller = s.add(
      "Intake Roller",
      cylinder(1 * INCH, 14 * INCH),
      along(rollerAxis, [4.8, 0, 3.6]),
    );
  });
  return { run, ...ids };
};
const decode = Schema.decodeUnknownSync(CadDriveOptionsResult);
const encodeJson = Schema.encodeSync(Schema.fromJsonString(CadDriveOptionsResult));

describe("the tool", () => {
  it.effect(
    "measures the center between the named parts and reads the roller for surface speed",
    () =>
      Effect.gen(function* () {
        const { run, motor, roller } = intake();
        const result = decode(
          yield* run({
            target: { kind: "surface-speed", feetPerSecond: 20 },
            driverOccurrenceId: motor,
            drivenOccurrenceId: roller,
          }),
        );
        expect(result.centerInches).toBeCloseTo(6, 2);
        expect(result.motor).toEqual({ name: "Kraken X60", freeRpm: 6065 });
        expect(result.driven!.diameterInches).toBeCloseTo(2, 2);
        // 20 ft/s on a 2 in roller is 2292 rpm, so 6065 rpm needs 2.65:1.
        expect(result.reduction).toBeCloseTo(6065 / ((20 * 720) / (Math.PI * 2)), 2);
        const best = result.options[0]!;
        expect(best.surfaceFeetPerSecond).toBeCloseTo(
          (6065 / best.reduction / 720) * Math.PI * 2,
          1,
        );
        const twoStage = result.options.find((option) => option.jackshaftPositions);
        if (twoStage) expect(twoStage.jackshaftPositions!.length).toBeGreaterThan(0);
        expect(new TextEncoder().encode(encodeJson(result)).byteLength).toBeLessThan(32 * 1024);
      }),
  );

  it.effect("rejects axes that are not parallel", () =>
    Effect.gen(function* () {
      const { run, motor, roller } = intake("z");
      const error = yield* run({
        target: { kind: "reduction", reduction: 3 },
        driverOccurrenceId: motor,
        drivenOccurrenceId: roller,
      }).pipe(Effect.flip);
      assert.equal(error.reason, "invalid-operation");
      expect(error.details).toContain("not parallel");
    }),
  );

  it.effect("rejects unknown parts, speed targets with no motor, and stale revisions", () =>
    Effect.gen(function* () {
      const { run, roller } = intake();
      const unknown = yield* run({
        target: { kind: "reduction", reduction: 3 },
        driverOccurrenceId: "e".repeat(64),
        drivenOccurrenceId: roller,
      }).pipe(Effect.flip);
      expect(unknown.details).toContain("driverOccurrenceId");
      const noMotor = yield* run({ target: { kind: "output-rpm", rpm: 2000 } }).pipe(Effect.flip);
      expect(noMotor.details).toContain("Kraken X60");
      const stale = yield* run({
        target: { kind: "reduction", reduction: 3 },
        expectedRevision: 3,
      }).pipe(Effect.flip);
      assert.equal(stale.reason, "revision-conflict");
    }),
  );

  it.effect("links each stage to ReCalc with its teeth, pitch, and center", () =>
    Effect.gen(function* () {
      const { run } = intake();
      const result = decode(
        yield* run({
          target: { kind: "reduction", reduction: 2.5 },
          centerInches: 4.25,
          maxStages: 1,
        }),
      );
      const belt = result.options.find((option) => option.stages[0]!.family === "htd-5mm");
      const chain = result.options.find((option) => option.stages[0]!.family === "chain-25");
      for (const option of [belt, chain]) {
        if (!option) continue;
        const stage = option.stages[0]!;
        const url = new URL(stage.recalcUrl);
        expect(url.origin).toBe("https://www.reca.lc");
        expect(url.searchParams.get("p1Teeth")).toBe(String(stage.driver.teeth));
        expect(url.searchParams.get("p2Teeth")).toBe(String(stage.driven.teeth));
        expect(url.searchParams.get("pitch")).toBe(
          stage.family === "htd-5mm" ? '{"s":5,"u":"mm"}' : '{"s":0.25,"u":"in"}',
        );
        expect(url.searchParams.get("desiredCenter")).toBe('{"s":4.25,"u":"in"}');
      }
      expect(belt ?? chain).toBeDefined();
      const overall = new URL(result.recalcUrl);
      expect(overall.pathname).toBe("/ratio-finder");
      expect(overall.searchParams.get("targetReduction")).toBe(
        '{"magnitude":2.5,"ratioType":"Reduction"}',
      );
    }),
  );
});
