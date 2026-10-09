import { describe, expect, it } from "vite-plus/test";
import type { CadTriangleMesh, PartOccurrence } from "./CadChecks.ts";
import {
  analyzeCadDrivetrain,
  beltEndPlacement,
  cadDrivetrainRole,
  rotatingCollisions,
  fitCadAxis,
  partLabel,
  partList,
  partPhrase,
  recognizeDrivetrainParts,
  type CadDrivetrainFinding,
} from "./CadDrivetrain.ts";

// Each case maps to one line of "Ways this can fail" in CadDrivetrain.md.

const INCH = 0.0254;
type Vector3 = readonly [number, number, number];
interface Mesh {
  readonly positions: number[];
  readonly indices: number[];
}

/** Closed cylinder along local z, centered on the origin. */
const cylinder = (radius: number, length: number, segments = 24): Mesh => {
  const positions: number[] = [];
  const indices: number[] = [];
  for (const z of [-length / 2, length / 2])
    for (let i = 0; i < segments; i++) {
      const angle = (2 * Math.PI * i) / segments;
      positions.push(radius * Math.cos(angle), radius * Math.sin(angle), z);
    }
  positions.push(0, 0, -length / 2, 0, 0, length / 2);
  for (let i = 0; i < segments; i++) {
    const j = (i + 1) % segments;
    const n = segments;
    indices.push(i, j, n + j, i, n + j, n + i, 2 * n, j, i, 2 * n + 1, n + i, n + j);
  }
  return { positions, indices };
};
const box = ([x0, y0, z0]: Vector3, [x1, y1, z1]: Vector3): Mesh => ({
  positions: [
    x0,
    y0,
    z0,
    x1,
    y0,
    z0,
    x1,
    y1,
    z0,
    x0,
    y1,
    z0,
    x0,
    y0,
    z1,
    x1,
    y0,
    z1,
    x1,
    y1,
    z1,
    x0,
    y1,
    z1,
  ],
  indices: [
    0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0,
    4, 3, 4, 7,
  ],
});
/** A flat belt loop around two pulleys `centers` apart, in the local xy plane. */
const beltLoop = (centers: number, radius: number, width: number, segments = 24): Mesh => {
  const line: [number, number][] = [];
  for (const [cx, start] of [
    [centers / 2, -Math.PI / 2],
    [-centers / 2, Math.PI / 2],
  ] as const)
    for (let i = 0; i <= segments; i++) {
      const angle = start + (Math.PI * i) / segments;
      line.push([cx + radius * Math.cos(angle), radius * Math.sin(angle)]);
    }
  const positions = line.flatMap(([x, y]) => [x, y, -width / 2, x, y, width / 2]);
  const indices = line.flatMap((_, i) => {
    const a = 2 * i;
    const b = 2 * ((i + 1) % line.length);
    return [a, b, b + 1, a, b + 1, a + 1];
  });
  return { positions, indices };
};
const merge = (...parts: Mesh[]): Mesh => {
  const positions: number[] = [];
  const indices: number[] = [];
  for (const part of parts) {
    const base = positions.length / 3;
    positions.push(...part.positions);
    indices.push(...part.indices.map((index) => index + base));
  }
  return { positions, indices };
};
const toMesh = ({ positions, indices }: Mesh): CadTriangleMesh => ({
  positions: Float64Array.from(positions),
  indices: Uint32Array.from(indices),
});
/** Row-major transform that turns local z onto a world axis, then moves to `at` (inches). */
const along = (axis: "x" | "y" | "z", [x, y, z]: Vector3) => {
  const [tx, ty, tz] = [x * INCH, y * INCH, z * INCH];
  return axis === "z"
    ? [1, 0, 0, tx, 0, 1, 0, ty, 0, 0, 1, tz, 0, 0, 0, 1]
    : axis === "y"
      ? [1, 0, 0, tx, 0, 0, 1, ty, 0, -1, 0, tz, 0, 0, 0, 1]
      : [0, 0, 1, tx, 0, 1, 0, ty, -1, 0, 0, tz, 0, 0, 0, 1];
};

/** A scene of named parts. `analyze` runs recognition and analysis the way cad_checks does. */
const scene = () => {
  const occurrences: PartOccurrence[] = [];
  const meshes = new Map<string, CadTriangleMesh | null>();
  let next = 0;
  const id = () => (++next).toString(16).padStart(64, "0");
  const add = (name: string, mesh: Mesh, transform: number[]) => {
    const geometryKey = id();
    const occurrenceId = id();
    meshes.set(geometryKey, toMesh(mesh));
    occurrences.push({ occurrenceId, name, geometryKey, transform });
    return occurrenceId;
  };
  return {
    add,
    analyze: () => analyzeCadDrivetrain(recognizeDrivetrainParts(occurrences, meshes)),
    /** Collisions among the given overlapping pairs, as cad_checks would pass them. */
    collisions: (pairs: ReadonlyArray<readonly [string, string]>, withinSubassembly = false) => {
      const parts = recognizeDrivetrainParts(occurrences, meshes);
      const byId = new Map(occurrences.map((occurrence) => [occurrence.occurrenceId, occurrence]));
      return rotatingCollisions(
        parts,
        pairs.map(([a, b]) => ({
          occurrences: [a, b].map((occurrenceId) => {
            const occurrence = byId.get(occurrenceId)!;
            const mesh = meshes.get(occurrence.geometryKey);
            return {
              occurrenceId,
              name: occurrence.name,
              fit: mesh ? fitCadAxis(mesh, occurrence.transform) : null,
            };
          }) as [OverlapSide, OverlapSide],
          volume: 1e-7,
          withinSubassembly,
        })),
      );
    },
  };
};
type OverlapSide = Parameters<typeof rotatingCollisions>[1][number]["occurrences"][number];
const ofKind = (findings: CadDrivetrainFinding[], kind: CadDrivetrainFinding["kind"]) =>
  findings.filter((finding) => finding.kind === kind);

// Parts sized like their FRC counterparts, in meters.
const gear = (teeth: number) => cylinder(((teeth + 2) / 40) * INCH, 0.5 * INCH);
const hexShaft = (inches: number) => cylinder(0.29 * INCH, inches * INCH);
const bearing = () => cylinder(0.56 * INCH, 0.31 * INCH);
const vortex = () => cylinder(1.4 * INCH, 3.1 * INCH);
const pinionShaft = () => cylinder(0.29 * INCH, 2 * INCH);
const gear40 = () => gear(40);

describe("cadDrivetrainRole", () => {
  it("reads roles from the right words", () => {
    expect(cadDrivetrainRole("SPARK Flex Brushless Motor Controller <1>")?.kind).toBe("controller");
    expect(cadDrivetrainRole('#10-32 x 0.5" L Shaft End Screw (V2, Steel, Black Oxide) <1>')).toBe(
      null,
    );
    expect(cadDrivetrainRole("Roller Endcap_HTD_24_Tooth_Square Nut <2>")).toEqual({
      kind: "pulley",
      teeth: 24,
    });
    expect(cadDrivetrainRole('7/8" OD Aluminum Roller Hub (1/2" Hex Bore) (WCP-1239) <1>')).toEqual(
      { kind: "roller" },
    );
    expect(cadDrivetrainRole("bottom motor support <1>")).toBe(null);
    expect(
      cadDrivetrainRole("8t Steel Spur Gear (20 DP, 10t Center Distance, 8mm SplineXS Bore)"),
    ).toEqual({ kind: "gear", teeth: 8, meshTeeth: 10, diametralPitch: 20 });
  });

  it("recognizes common FRC motors, gearboxes, loops, and shafts", () => {
    for (const name of ["Kraken X60 <1>", "Falcon 500 <2>", "NEO 550 Brushless Motor <1>"])
      expect(cadDrivetrainRole(name)?.kind, name).toBe("motor");
    expect(cadDrivetrainRole("MAXPlanetary 5:1 Slice <1>")).toEqual({ kind: "gearbox", ratio: 5 });
    expect(cadDrivetrainRole("VersaPlanetary 7:1 Stage <1>")).toEqual({
      kind: "gearbox",
      ratio: 7,
    });
    expect(cadDrivetrainRole("GT2 3mm 20T Pulley <1>")).toEqual({ kind: "pulley", teeth: 20 });
    expect(cadDrivetrainRole("70T 5M 9mm Wide Belt <1>")).toEqual({
      kind: "loop",
      wraps: "pulley",
      teeth: 70,
      pitchMm: 5,
    });
    expect(cadDrivetrainRole("60L #35 Chain <1>")).toEqual({
      kind: "loop",
      wraps: "sprocket",
      teeth: 60,
      pitchMm: 9.525,
    });
    for (const name of ['MAXSpline (16.5" L) <1>', '1/2" ThunderHex Shaft (6" L) <1>'])
      expect(cadDrivetrainRole(name)?.kind, name).toBe("shaft");
  });

  it("does not read standoffs, adapters, or couplers as shafts, and reads bushings as bearings", () => {
    for (const name of [
      "1/4-20 x 1.5in Hex Standoff <1>",
      "REV-41-1500 Hex Standoff <1>",
      "MAXSpline Hex Adapter <1>",
      '1/2" Hex Shaft Coupler <1>',
    ])
      expect(cadDrivetrainRole(name), name).toBe(null);
    expect(cadDrivetrainRole("Bronze Bushing 1/2 Hex <1>")).toEqual({ kind: "bearing" });
  });
});

describe("fitCadAxis and carrier alignment", () => {
  // A pulley with a tab, like an endcap with its square nut: the raw fit picks the tab direction.
  const tabbedPulley = merge(
    cylinder(0.02, 0.03),
    box([0.015, -0.006, -0.015], [0.035, 0.006, 0.015]),
  );

  it("fits discs and rods along their axes", () => {
    expect(Math.abs(fitCadAxis(toMesh(gear(40)), along("y", [0, 0, 0]))!.axis[1])).toBeCloseTo(1);
    expect(Math.abs(fitCadAxis(toMesh(hexShaft(12)), along("x", [0, 0, 0]))!.axis[0])).toBeCloseTo(
      1,
    );
  });

  it("snaps a part with an ambiguous fit onto the shaft through it", () => {
    const raw = fitCadAxis(toMesh(tabbedPulley), along("y", [0, 0, 0]))!;
    expect(Math.abs(raw.axis[1])).toBeLessThan(0.5);
    const s = scene();
    const pulley = s.add("HTD 24 Tooth Pulley <1>", tabbedPulley, along("y", [0, 0, 0]));
    s.add('1/2" Hex Shaft (6" L) <1>', hexShaft(6), along("y", [0, 0, 0]));
    const findings = s.analyze();
    // The pulley joined the shaft's rotating group, so the shaft reports it as carried.
    const support = ofKind(findings, "shaft-support")[0]!;
    expect(support.occurrences.map((occurrence) => occurrence.occurrenceId)).toContain(pulley);
  });
});

describe("gear meshes", () => {
  const pair = (distance: number, pinion = "Vortex Shaft (20DP Gear - 7T) <1>", driven = 40) => {
    const s = scene();
    s.add(pinion, pinionShaft(), along("y", [0, 0, 0]));
    s.add(
      `${driven}t Pocketed Steel Spur Gear (20 DP, 1/2" Hex Bore) <1>`,
      gear(driven),
      along("y", [distance, 0, 0]),
    );
    return ofKind(s.analyze(), "gear-mesh");
  };

  it("reports a pair set too close for its pitch", () => {
    const [finding] = pair(1.152);
    expect(finding?.problem).toBe(true);
    expect(finding?.summary).toContain("0.023 in too close");
    expect(finding?.summary).toContain("5.71:1");
  });

  it("accepts the exact center distance plus the usual 0.003 in", () => {
    expect(pair(1.178)[0]?.problem).toBe(false);
  });

  it("checks a profile-shifted pinion at its center-distance tooth count", () => {
    const [finding] = pair(1.603, "8t Steel Spur Gear (20 DP, 10t Center Distance) <1>", 54);
    expect(finding?.problem).toBe(false);
  });

  it("ignores gears at mesh distance that sit far apart along their shafts", () => {
    const s = scene();
    s.add('20t Steel Spur Gear (20 DP, 1/2" Hex Bore) <1>', gear(20), along("y", [0, 0, 0]));
    s.add('50t Steel Spur Gear (20 DP, 1/2" Hex Bore) <1>', gear(50), along("y", [1.75, 11, 0]));
    expect(ofKind(s.analyze(), "gear-mesh")).toEqual([]);
  });
});

describe("belts", () => {
  // 70T HTD 5 mm on two 24T pulleys: 350 mm needs 115.1 mm (4.532 in) centers.
  const centers = 115.1 / 1000 / INCH;
  const pitchRadius = (24 * 5) / (2 * Math.PI) / 1000;
  const loop = (pulleys: readonly number[], kind: CadDrivetrainFinding["kind"] = "loop") => {
    const s = scene();
    s.add(
      "70T 5M 9mm Wide Belt <1>",
      beltLoop(centers * INCH, pitchRadius, 0.009),
      along("y", [0, 0, 0]),
    );
    for (const x of pulleys)
      s.add("HTD 24 Tooth Pulley <1>", cylinder(pitchRadius, 0.012), along("y", [x, 0, 0]));
    return ofKind(s.analyze(), kind);
  };

  it("passes a belt that wraps a pulley at each end and matches its length", () => {
    const [finding] = loop([-centers / 2, centers / 2], "loop-length");
    expect(finding?.problem).toBe(false);
    expect(finding?.summary).toContain("length matches");
  });

  it("reports a belt too long for its centers as a length problem, not a bare loop", () => {
    const [finding] = loop([-centers / 2 + 0.2, centers / 2 - 0.2], "loop-length");
    expect(finding?.problem).toBe(true);
    expect(finding?.summary).toContain("too long");
  });

  it("links every wheel a loop wraps, so a motor on a middle pulley drives the rest", () => {
    const s = scene();
    s.add(
      "70T 5M 9mm Wide Belt <1>",
      beltLoop(centers * INCH, pitchRadius, 0.009),
      along("y", [0, 0, 0]),
    );
    // Added in this order, the motor's pulley is the middle wheel of the three.
    s.add(
      "HTD 24 Tooth Pulley <1>",
      cylinder(pitchRadius, 0.012),
      along("y", [-centers / 2, 0, 0]),
    );
    s.add("HTD 24 Tooth Pulley <2>", cylinder(pitchRadius, 0.012), along("y", [0, 0, 0]));
    s.add("NEO Vortex Brushless Motor <1>", vortex(), along("y", [0, -2.4, 0]));
    s.add("HTD 24 Tooth Pulley <3>", cylinder(pitchRadius, 0.012), along("y", [centers / 2, 0, 0]));
    s.add("Driven Hex Shaft <1>", hexShaft(10), along("y", [centers / 2, 4, 0]));
    s.add(
      "Deadaxle Tube_9.75_in <1>",
      cylinder(INCH, 9.75 * INCH),
      along("y", [centers / 2, 4, 0]),
    );
    const findings = s.analyze();
    expect(ofKind(findings, "loop-length")[0]?.problem).toBe(false);
    expect(ofKind(findings, "unpowered")).toEqual([]);
  });

  it("calls chain slack a lead, since a tensioner may take it up", () => {
    // 60L #35 on two 22T sprockets: 571.5 mm of chain at centers that need about 2 links less.
    const pitch = 9.525;
    const radius = (22 * pitch) / (2 * Math.PI) / 1000;
    const slackCenters = (571.5 - 2 * pitch - 2 * Math.PI * radius * 1000) / 2 / 1000;
    const s = scene();
    s.add("60L #35 Chain <1>", beltLoop(slackCenters, radius, 0.006), along("y", [0, 0, 0]));
    for (const x of [-slackCenters / 2, slackCenters / 2])
      s.add("#35 22T Sprocket <1>", cylinder(radius, 0.006), along("y", [x / INCH, 0, 0]));
    const [finding] = ofKind(s.analyze(), "loop-length");
    expect(finding?.summary).toContain("slack");
    expect(finding?.problem).toBe(false);
  });

  it("places a bare-belt marker at the end that has no pulley", () => {
    const occurrences: PartOccurrence[] = [];
    const meshes = new Map<string, CadTriangleMesh | null>();
    const add = (n: number, name: string, mesh: Mesh, transform: number[]) => {
      const key = n.toString(16).padStart(64, "0");
      meshes.set(key, toMesh(mesh));
      occurrences.push({ occurrenceId: key, name, geometryKey: key, transform });
    };
    add(
      1,
      "70T 5M 9mm Wide Belt <1>",
      beltLoop(centers * INCH, pitchRadius, 0.009),
      along("y", [0, 0, 0]),
    );
    add(
      2,
      "HTD 24 Tooth Pulley <1>",
      cylinder(pitchRadius, 0.012),
      along("y", [-centers / 2, 0, 0]),
    );
    const parts = recognizeDrivetrainParts(occurrences, meshes);
    const loop = parts.find((part) => part.role.kind === "loop")!;
    const placement = beltEndPlacement(
      loop,
      meshes.get(loop.occurrenceId)!,
      occurrences[0]!.transform,
      parts,
    );
    // Local X is world X here; the pulley sits at -X, so the bare end is at +X.
    expect(placement?.point[0]).toBeGreaterThan((centers * INCH) / 2);
    // Viewed face-on: the loop lies in the world XZ plane, so the view runs along Y.
    expect(Math.abs(placement!.normal[1])).toBeCloseTo(1, 3);
  });

  it("reports the end of a belt that has no pulley", () => {
    const [finding] = loop([-centers / 2]);
    expect(finding?.problem).toBe(true);
    expect(finding?.summary).toContain("one end");
  });
});

describe("power paths", () => {
  it("never calls an untraceable motor a problem", () => {
    const s = scene();
    s.add("NEO Vortex Brushless Motor <1>", vortex(), along("y", [0, 0, 0]));
    s.add("Deadaxle Tube_9.75_in <1>", cylinder(INCH, 9.75 * INCH), along("y", [6, 0, 0]));
    const findings = s.analyze();
    expect(ofKind(findings, "power-path")[0]?.problem).toBe(false);
    expect(ofKind(findings, "unpowered")[0]?.problem).toBe(false);
  });

  it("calls a trace that ends at an unrecognized part untraced, not broken", () => {
    const s = scene();
    s.add("NEO Vortex Brushless Motor <1>", vortex(), along("y", [0, 0, 0]));
    s.add("Vortex Shaft (20DP Gear - 7T) <1>", pinionShaft(), along("y", [0, -2.4, 0]));
    // The 40T gear meshes but sits on no recognized shaft.
    s.add('40t Steel Spur Gear (20 DP, 1/2" Hex Bore) <1>', gear(40), along("y", [1.178, -2.4, 0]));
    s.add("Deadaxle Tube_9.75_in <1>", cylinder(INCH, 9.75 * INCH), along("y", [6, 0, 0]));
    const findings = s.analyze();
    expect(findings.filter((finding) => finding.problem && finding.kind !== "gear-mesh")).toEqual(
      [],
    );
    expect(ofKind(findings, "unpowered")[0]?.summary).toContain("could not be traced");
  });

  it("calls a roller left out while others are driven a lead, since it may be an idler", () => {
    const s = scene();
    s.add("NEO Vortex Brushless Motor <1>", vortex(), along("y", [0, 0, 0]));
    s.add("Vortex Shaft (20DP Gear - 7T) <1>", pinionShaft(), along("y", [0, -2.4, 0]));
    s.add('40t Steel Spur Gear (20 DP, 1/2" Hex Bore) <1>', gear(40), along("y", [1.178, -2.4, 0]));
    s.add("Driven Hex Shaft <1>", hexShaft(10), along("y", [1.178, -6, 0]));
    s.add("Deadaxle Tube_9.75_in <1>", cylinder(INCH, 9.75 * INCH), along("y", [1.178, -6, 0]));
    s.add("Deadaxle Tube_9.75_in <2>", cylinder(INCH, 9.75 * INCH), along("y", [6, -6, 0]));
    const [unpowered] = ofKind(s.analyze(), "unpowered");
    expect(unpowered?.occurrences).toHaveLength(1);
    expect(unpowered?.problem).toBe(false);
  });

  it("reports two motors driving one gear as one power path", () => {
    const s = scene();
    s.add('1/2" Hex Shaft (6" L) <1>', hexShaft(6), along("y", [0, 0, 0]));
    s.add('50t Steel Spur Gear (20 DP, 1/2" Hex Bore) <1>', gear(50), along("y", [0, -2.4, 0]));
    const motors = [1.75, -1.75].map((x, index) => {
      const motor = s.add(
        `NEO Vortex Brushless Motor <${index + 1}>`,
        vortex(),
        along("y", [x, 0, 0]),
      );
      s.add(
        `Vortex Shaft (20DP Gear - 20T) <${index + 1}>`,
        pinionShaft(),
        along("y", [x, -2.4, 0]),
      );
      return motor;
    });
    const paths = ofKind(s.analyze(), "power-path");
    expect(paths).toHaveLength(1);
    const ids = paths[0]!.occurrences.map((occurrence) => occurrence.occurrenceId);
    for (const motor of motors) expect(ids).toContain(motor);
  });

  it("returns the same findings in the same order every time", () => {
    const s = scene();
    s.add("NEO Vortex Brushless Motor <1>", vortex(), along("y", [0, 0, 0]));
    s.add("Vortex Shaft (20DP Gear - 7T) <1>", pinionShaft(), along("y", [0, -2.4, 0]));
    s.add('40t Steel Spur Gear (20 DP, 1/2" Hex Bore) <1>', gear(40), along("y", [1.152, -2.4, 0]));
    s.add("1.75 in. Hex Shaft <1>", hexShaft(1.75), along("y", [1.152, -2.4, 0]));
    s.add('1/2" Hex Bore Bearing <1>', bearing(), along("y", [1.152, -3.1, 0]));
    expect(s.analyze()).toEqual(s.analyze());
  });
});

describe("motor mounts", () => {
  const mounted = (controllerY: number) => {
    const s = scene();
    s.add("NEO Vortex Brushless Motor <1>", vortex(), along("y", [0, 0, 0]));
    // The pinion sticks out of the motor's -y face, so -y is the output side.
    s.add("Vortex Shaft (20DP Gear - 7T) <1>", pinionShaft(), along("y", [0, -2.4, 0]));
    s.add(
      "SPARK Flex Brushless Motor Controller <1>",
      cylinder(1.45 * INCH, 1.17 * INCH),
      along("y", [0, controllerY, 0]),
    );
    return ofKind(s.analyze(), "motor-mount");
  };

  it("reports a controller docked in front of the motor face", () => {
    const [finding] = mounted(-2.1);
    expect(finding?.problem).toBe(true);
    expect(finding?.summary).toContain("SPARK Flex");
  });

  it("accepts a controller docked on the back of the motor", () => {
    expect(mounted(2.1)).toEqual([]);
  });
});

// Cases from "Check-placed points" in CadComments.md: only a spinning part running into a part it
// should clear is a collision.
describe("rotating collisions", () => {
  const tube = () => box([-0.5 * INCH, -6 * INCH, -0.5 * INCH], [0.5 * INCH, 6 * INCH, 0.5 * INCH]);
  it("reports a gear running into a tube, with the gear as the subject", () => {
    const s = scene();
    const gear = s.add(
      '40t Steel Spur Gear (20 DP, 1/2" Hex Bore) <1>',
      gear40(),
      along("y", [0, 0, 0]),
    );
    const frame = s.add('Tube 1"x1"x11" <1>', tube(), along("z", [1.2, 0, 0]));
    const [finding] = s.collisions([[frame, gear]]);
    expect(finding?.kind).toBe("collision");
    expect(finding?.problem).toBe(true);
    expect(finding?.occurrences.map((occurrence) => occurrence.occurrenceId)).toEqual([
      gear,
      frame,
    ]);
    expect(finding?.summary).toContain("runs into");
  });
  it("ignores intended fits", () => {
    const s = scene();
    const gear = s.add(
      '40t Steel Spur Gear (20 DP, 1/2" Hex Bore) <1>',
      gear40(),
      along("y", [0, 0, 0]),
    );
    const shaft = s.add('1/2" Hex Shaft (6" L) <1>', hexShaft(6), along("y", [0, 0, 0]));
    const bearing = s.add(
      '1/2" Hex Bore Bearing <1>',
      cylinder(0.56 * INCH, 0.31 * INCH),
      along("y", [0, 2, 0]),
    );
    const spacer = s.add(
      '1/2" Hex Spacer (0.25" L) <1>',
      cylinder(0.37 * INCH, 0.25 * INCH),
      along("y", [0, 1, 0]),
    );
    const pulley = s.add(
      "HTD 24 Tooth Pulley <1>",
      cylinder(0.75 * INCH, 0.5 * INCH),
      along("y", [0, -1, 0]),
    );
    const belt = s.add(
      "70T 5M 9mm Wide Belt <1>",
      beltLoop(0.1, 0.019, 0.009),
      along("y", [2, -1, 0]),
    );
    const pinion = s.add(
      "Vortex Shaft (20DP Gear - 7T) <1>",
      pinionShaft(),
      along("y", [1.15, 0, 0]),
    );
    const disc = s.add("FRC Game Piece <1>", cylinder(5 * INCH, 1 * INCH), along("z", [0, 0, 0]));
    const screw = s.add(
      '#10-32 x 0.5" L BHCS <1>',
      cylinder(0.1 * INCH, 0.5 * INCH),
      along("x", [0, 0, 0]),
    );
    expect(
      s.collisions([
        [gear, shaft],
        [shaft, bearing],
        [shaft, spacer],
        [pulley, belt],
        [gear, pinion],
        [gear, disc],
        [shaft, screw],
      ]),
    ).toEqual([]);
  });
  it("ignores a spacer or pin bolted through the spinning part, which turns with it", () => {
    const s = scene();
    const gear = s.add(
      '40t Steel Spur Gear (20 DP, 1/2" Hex Bore) <1>',
      gear40(),
      along("y", [0, 0, 0]),
    );
    // Parallel to the gear's axis, 0.7 in off it, entirely inside the gear's 1.05 in radius.
    const pin = s.add(
      "ROUND Spacer 1 in <1>",
      cylinder(0.16 * INCH, INCH),
      along("y", [0.7, 0, 0]),
    );
    expect(s.collisions([[gear, pin]])).toEqual([]);
  });
  it("ignores overlaps inside one vendor subassembly", () => {
    const s = scene();
    const gear = s.add(
      '40t Steel Spur Gear (20 DP, 1/2" Hex Bore) <1>',
      gear40(),
      along("y", [0, 0, 0]),
    );
    const frame = s.add('Tube 1"x1"x11" <1>', tube(), along("z", [1.2, 0, 0]));
    expect(s.collisions([[gear, frame]], true)).toEqual([]);
  });
});

// What a draft tells the student. The agent's summary keeps exact CAD names so it can find the
// parts; a comment published from a draft must read as if a mentor wrote it. See "Ways this can
// fail" in CadDrivetrain.md.
describe("draft wording", () => {
  const readable = (finding: CadDrivetrainFinding | undefined) => {
    const comment = finding?.comment?.body ?? "";
    expect(comment, "a problem finding has a comment").not.toBe("");
    expect(comment, "no instance tags or underscores").not.toMatch(/<\d+>|_/);
    expect(comment.charAt(0), "starts like a sentence").toMatch(/[A-Z0-9]/);
    return comment;
  };
  const title = (finding: CadDrivetrainFinding | undefined) => finding?.comment?.title;

  it("names parts the way a student would", () => {
    expect(partLabel('40t Pocketed Steel Spur Gear (20 DP, 1/2" Hex Bore) <1>')).toBe("40T gear");
    expect(partLabel("7T Vortex Shaft (20DP Gear - 7T) <1>")).toBe("7T gear");
    expect(partLabel("84T 5M 9mm Wide Belt <1>")).toBe("84T belt");
    expect(partLabel("HTD 24 Tooth Pulley <2>")).toBe("24T pulley");
    expect(partLabel('1/2" Rounded Hex (11.5" L, 13.75mm OD) <1>')).toBe('1/2" Rounded Hex');
    expect(partLabel("Deadaxle Tube_9.75_in <3>")).toBe("Deadaxle Tube 9.75 in");
    expect(partLabel("(Copy) <1>")).toBe("(Copy)");
    // Motors and controllers go by the name a team uses for them.
    expect(partLabel("SPARK Flex Brushless Motor Controller <1>")).toBe("SPARK Flex");
    expect(partLabel("NEO Vortex Brushless Motor <1>")).toBe("NEO Vortex");
    expect(partLabel("Kraken X60 <1>")).toBe("Kraken X60");
    expect(partPhrase("<1>")).toBe("the unnamed part");
    expect(partLabel(`${"Bracket ".repeat(40)}<1>`).length).toBeLessThanOrEqual(120);
    // An Onshape default name takes no article.
    expect(partPhrase("Part 20 <3>")).toBe("Part 20");
    expect(partPhrase("13 in. Hex Shaft <1>")).toBe("the 13 in. Hex Shaft");
    expect(partList(["13 in. Hex Shaft <1>", "13 in. Hex Shaft <2>", "Part 4 <1>"])).toBe(
      "the 13 in. Hex Shaft (2 of them) and Part 4",
    );
  });

  it("gives a gear spacing problem its numbers and a next step, and keeps the agent's names", () => {
    const s = scene();
    s.add("7T Vortex Shaft (20DP Gear - 7T) <1>", pinionShaft(), along("y", [0, 0, 0]));
    s.add(
      '40t Pocketed Steel Spur Gear (20 DP, 1/2" Hex Bore) <1>',
      gear(40),
      along("y", [1.152, 0, 0]),
    );
    const [finding] = ofKind(s.analyze(), "gear-mesh");
    expect(readable(finding)).toBe(
      "The 7T gear and the 40T gear are 1.152 in apart, but these 20 DP gears need 1.175 in. They are 0.023 in too close and will bind. The stage is 5.71:1. Move one shaft so the centers are 1.175 in apart.",
    );
    expect(title(finding)).toBe("7T and 40T gears are too close");
    expect(finding?.summary).toContain("7T Vortex Shaft (20DP Gear - 7T) <1>");
  });

  it("tells two gears with one tooth count apart, and words gears whose faces miss", () => {
    const s = scene();
    s.add('40t Steel Spur Gear (20 DP, 1/2" Hex Bore) <1>', gear(40), along("y", [0, 0, 0]));
    s.add('40t Steel Spur Gear (20 DP, 1/2" Hex Bore) <2>', gear(40), along("y", [2.2, 0, 0]));
    const [twin] = ofKind(s.analyze(), "gear-mesh");
    expect(readable(twin)).toMatch(
      /^The two 40T gears are 2\.200 in apart, .* too far apart and will skip\./,
    );
    expect(title(twin)).toBe("Two 40T gears are too far apart");
    const offset = scene();
    offset.add('20t Steel Spur Gear (20 DP, 1/2" Hex Bore) <1>', gear(20), along("y", [0, 0, 0]));
    offset.add(
      '40t Steel Spur Gear (20 DP, 1/2" Hex Bore) <1>',
      gear(40),
      along("y", [1.5, 0.55, 0]),
    );
    const [missed] = ofKind(offset.analyze(), "gear-mesh");
    expect(readable(missed)).toBe(
      "The 20T gear and the 40T gear are at mesh distance, but their faces miss each other by 0.050 in along the shaft, so they don't mesh. Move one gear along its shaft so the faces line up.",
    );
    expect(title(missed)).toBe("20T and 40T gears miss each other");
  });

  it("states both errors when gears are set at the wrong spacing and their faces miss", () => {
    const s = scene();
    s.add('20t Steel Spur Gear (20 DP, 1/2" Hex Bore) <1>', gear(20), along("y", [0, 0, 0]));
    s.add('40t Steel Spur Gear (20 DP, 1/2" Hex Bore) <1>', gear(40), along("y", [1.3, 0.55, 0]));
    const [finding] = ofKind(s.analyze(), "gear-mesh");
    expect(finding?.summary).toContain("1.300 in apart");
    expect(finding?.summary).toContain("miss each other by 0.050 in");
    expect(readable(finding)).toBe(
      "The 20T gear and the 40T gear are 1.300 in apart, but these 20 DP gears need 1.500 in, and their faces miss each other by 0.050 in along the shaft, so they don't mesh. Move one gear along its shaft so the faces line up, and move one shaft so the centers are 1.500 in apart.",
    );
    expect(title(finding)).toBe("20T and 40T gears do not mesh");
  });

  it("words a belt with no pulleys and a belt with one bare end", () => {
    // 70T HTD 5 mm on two 24T pulleys needs 115.1 mm centers.
    const centers = 115.1 / 1000 / INCH;
    const pitchRadius = (24 * 5) / (2 * Math.PI) / 1000;
    const belt = (pulleys: readonly number[]) => {
      const s = scene();
      s.add(
        "70T 5M 9mm Wide Belt <1>",
        beltLoop(centers * INCH, pitchRadius, 0.009),
        along("y", [0, 0, 0]),
      );
      for (const x of pulleys)
        s.add("HTD 24 Tooth Pulley <1>", cylinder(pitchRadius, 0.012), along("y", [x, 0, 0]));
      return ofKind(s.analyze(), "loop")[0];
    };
    expect(readable(belt([]))).toBe(
      "The 70T belt (350 mm) has no pulleys, so nothing turns it and it drives nothing. Add a pulley at each end, or remove the belt if it is left over, then check its length against the centers.",
    );
    expect(title(belt([]))).toBe("70T belt has no pulleys");
    expect(readable(belt([-centers / 2]))).toBe(
      "The 70T belt has no pulley at one end; it wraps only the 24T pulley. Add a pulley at the bare end, then check the belt's length against the centers.",
    );
    expect(title(belt([-centers / 2]))).toBe("70T belt has no pulley at one end");
  });

  it("words a controller docked in front of its motor", () => {
    const s = scene();
    s.add("NEO Vortex Brushless Motor <1>", vortex(), along("y", [0, 0, 0]));
    s.add("Vortex Shaft (20DP Gear - 7T) <1>", pinionShaft(), along("y", [0, -2.4, 0]));
    s.add(
      "SPARK Flex Brushless Motor Controller <1>",
      cylinder(1.45 * INCH, 1.17 * INCH),
      along("y", [0, -2.1, 0]),
    );
    expect(readable(ofKind(s.analyze(), "motor-mount")[0])).toBe(
      "The SPARK Flex sits in front of the NEO Vortex, on the side its shaft comes out of. That puts it between the motor face and the plate the motor bolts to, so the motor is not held. Controllers that dock to a motor go on the back. Move the controller to the back of the motor so the motor face bolts to its plate.",
    );
  });

  it("words rollers no motor reaches, one or several", () => {
    const unpowered = (rollers: number) => {
      const s = scene();
      s.add("NEO Vortex Brushless Motor <1>", vortex(), along("y", [0, 0, 0]));
      s.add("Vortex Shaft (20DP Gear - 7T) <1>", pinionShaft(), along("y", [0, -2.4, 0]));
      s.add(
        '40t Steel Spur Gear (20 DP, 1/2" Hex Bore) <1>',
        gear(40),
        along("y", [1.178, -2.4, 0]),
      );
      s.add("Driven Hex Shaft <1>", hexShaft(10), along("y", [1.178, -6, 0]));
      for (let i = 0; i < rollers; i++)
        s.add(
          `Deadaxle Tube_9.75_in <${i + 1}>`,
          cylinder(INCH, 9.75 * INCH),
          along("y", [6 + 3 * i, -6, 0]),
        );
      const [finding] = ofKind(s.analyze(), "unpowered");
      expect(finding?.problem).toBe(true);
      return finding;
    };
    // The draft says where power stops, the way a mentor would point at it.
    expect(readable(unpowered(2))).toBe(
      "None of the 2 rollers is driven: power from the motor stops at the Driven Hex Shaft, and no gear, belt, or chain carries it on to the rollers. Add a gear or belt stage from the Driven Hex Shaft to the rollers.",
    );
    expect(title(unpowered(2))).toBe("Motor does not reach the rollers");
    expect(readable(unpowered(1))).toBe(
      "The roller is not driven: power from the motor stops at the Driven Hex Shaft, and no gear, belt, or chain carries it on to the roller. Add a gear or belt stage from the Driven Hex Shaft to the roller.",
    );
    expect(title(unpowered(1))).toBe("Motor does not reach the roller");
  });

  it("keeps a long list of parts out of the comment, so it keeps its whole sentence and next step", () => {
    const s = scene();
    s.add("NEO Vortex Brushless Motor <1>", vortex(), along("y", [0, 0, 0]));
    s.add("Vortex Shaft (20DP Gear - 7T) <1>", pinionShaft(), along("y", [0, -2.4, 0]));
    s.add('40t Steel Spur Gear (20 DP, 1/2" Hex Bore) <1>', gear(40), along("y", [1.178, -2.4, 0]));
    s.add("Driven Hex Shaft <1>", hexShaft(10), along("y", [1.178, -6, 0]));
    for (let i = 0; i < 40; i++)
      s.add(
        `Roller ${i} ${"x".repeat(110)} <1>`,
        cylinder(INCH, 9.75 * INCH),
        along("y", [6 + 3 * i, -6, 0]),
      );
    const comment = readable(ofKind(s.analyze(), "unpowered")[0]);
    expect(comment.length).toBeLessThan(3950);
    expect(comment).toMatch(/^None of the 40 rollers is driven: /);
    expect(comment).not.toContain("xxxx");
    expect(comment.endsWith("from the Driven Hex Shaft to the rollers.")).toBe(true);
  });

  it("leaves facts and merged kinds to the agent's summary and the draft", () => {
    // A traced power path is not a problem, and a bearing draft is worded once for every shaft.
    const s = scene();
    s.add("NEO Vortex Brushless Motor <1>", vortex(), along("y", [0, 0, 0]));
    s.add("Vortex Shaft (20DP Gear - 7T) <1>", pinionShaft(), along("y", [0, -2.4, 0]));
    s.add('40t Steel Spur Gear (20 DP, 1/2" Hex Bore) <1>', gear(40), along("y", [1.178, -2.4, 0]));
    s.add("Driven Hex Shaft <1>", hexShaft(10), along("y", [1.178, -6, 0]));
    const findings = s.analyze();
    expect(ofKind(findings, "power-path")[0]?.comment).toBeUndefined();
    expect(ofKind(findings, "shaft-support")[0]?.comment).toBeUndefined();
  });
});
