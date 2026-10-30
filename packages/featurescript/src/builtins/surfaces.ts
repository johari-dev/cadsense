import { addBodies, type Entity } from "../geometry/Model.ts";
import { ShapeSet, subShapes, type Oc, type Shape } from "../geometry/occt.ts";
import type { BuiltinCall, BuiltinImpl } from "../runtime/Interpreter.ts";
import type { ModelContext } from "../runtime/ModelContext.ts";
import { FsMap, FsTagged, untag, type FsValue } from "../runtime/Value.ts";
import { array, map, number } from "./args.ts";
import { doubles, peakOf, readSpline, runs, type Spline } from "./bspline.ts";
import { idOf, kernel, magnitude, resolve } from "./geometryArgs.ts";
import { length, regenError, stdTagged, stdType } from "./std.ts";
import { requireValid } from "./validity.ts";
import type { StdBuiltinName } from "./stdBuiltinNames.generated.ts";

/**
 * Surfaces: B-spline sheets between std's `BSplineSurface` and OpenCascade, fills bounded by edges,
 * and solids enclosed by sheets.
 */

type Point = readonly number[];

/** std's `BSplineSurface`, lengths in meters. Rows of control points run in u, columns in v. */
interface SurfaceData {
  readonly uDegree: number;
  readonly vDegree: number;
  readonly uPeriodic: boolean;
  readonly vPeriodic: boolean;
  readonly points: readonly (readonly Point[])[];
  readonly weights: readonly (readonly number[])[] | null;
  readonly uKnots: readonly number[];
  readonly vKnots: readonly number[];
}

function readSurface(call: BuiltinCall, value: FsValue): SurfaceData {
  const surface = map(call, value, "bSplineSurface");
  const field = (name: string) => surface.getField(name);
  const grid = <T>(name: string, read: (cell: FsValue, at: string) => T) =>
    array(call, field(name), name).map((row, i) =>
      array(call, row, `${name}[${i}]`).map((cell, j) => read(cell, `${name}[${i}][${j}]`)),
    );
  const knots = (name: string) =>
    array(call, field(name), name).map((k, i) => number(call, k, `${name}[${i}]`));
  return {
    uDegree: number(call, field("uDegree"), "uDegree"),
    vDegree: number(call, field("vDegree"), "vDegree"),
    uPeriodic: untag(field("isUPeriodic")) === true,
    vPeriodic: untag(field("isVPeriodic")) === true,
    points: grid("controlPoints", (cell, at) =>
      array(call, cell, at).map((c) => magnitude(call, c, at)),
    ),
    weights:
      untag(field("isRational")) === true
        ? grid("weights", (cell, at) => number(call, cell, at))
        : null,
    uKnots: knots("uKnots"),
    vKnots: knots("vKnots"),
  };
}

/**
 * The OpenCascade surface for std's `BSplineSurface`. A periodic direction drops its repeated
 * control points and padded knots, as for curves.
 */
function occtSurface(call: BuiltinCall, oc: Oc, surface: SurfaceData) {
  const rows = surface.points.length;
  const columns = surface.points[0]?.length ?? 0;
  const { uDegree, vDegree, uKnots, vKnots } = surface;
  if (
    rows <= uDegree ||
    columns <= vDegree ||
    surface.points.some((row) => row.length !== columns || row.some((p) => p.length !== 3)) ||
    uKnots.length !== rows + uDegree + 1 ||
    vKnots.length !== columns + vDegree + 1
  )
    return regenError(call, "CANNOT_MAKE_BSPLINESURFACE");
  if (uDegree > 25 || vDegree > 25) return regenError(call, "BSPLINE_DEGREE_TOO_HIGH");
  const uCount = surface.uPeriodic ? rows - uDegree : rows;
  const vCount = surface.vPeriodic ? columns - vDegree : columns;
  const same = (a: Point, b: Point) => Math.hypot(...a.map((c, k) => c - b[k]!)) < 1e-10;
  if (
    surface.uPeriodic &&
    surface.points
      .slice(0, uDegree)
      .some((row, i) => row.some((p, j) => !same(p, surface.points[uCount + i]![j]!)))
  )
    return regenError(call, "PERIODIC_BSPLINESURFACE_NOT_CLOSED");
  if (
    surface.vPeriodic &&
    surface.points.some((row) => row.slice(0, vDegree).some((p, j) => !same(p, row[vCount + j]!)))
  )
    return regenError(call, "PERIODIC_BSPLINESURFACE_NOT_CLOSED");
  const direction = (
    knots: readonly number[],
    degree: number,
    periodic: boolean,
    count: number,
  ) => {
    const { knots: distinct, mults } = runs(
      periodic ? knots.slice(degree, degree + count + 1) : knots,
    );
    // As for curves: both seam ends carry the seam knot's multiplicity.
    if (periodic) mults[mults.length - 1] = mults[0]!;
    const multArray = new oc.NCollection_Array1_int(1, mults.length);
    mults.forEach((m, i) => multArray.SetValue(i + 1, m));
    return { knots: doubles(oc, distinct), mults: multArray };
  };
  const u = direction(uKnots, uDegree, surface.uPeriodic, uCount);
  const v = direction(vKnots, vDegree, surface.vPeriodic, vCount);
  const poles = new oc.NCollection_Array2_gp_Pnt(1, uCount, 1, vCount);
  for (let i = 0; i < uCount; i++)
    for (let j = 0; j < vCount; j++) {
      const [x, y, z] = surface.points[i]![j]!;
      poles.SetValue(i + 1, j + 1, new oc.gp_Pnt(x!, y!, z!));
    }
  try {
    if (!surface.weights)
      return new oc.Geom_BSplineSurface(
        poles,
        u.knots,
        v.knots,
        u.mults,
        v.mults,
        uDegree,
        vDegree,
        surface.uPeriodic,
        surface.vPeriodic,
      );
    const weights = new oc.NCollection_Array2_double(1, uCount, 1, vCount);
    for (let i = 0; i < uCount; i++)
      for (let j = 0; j < vCount; j++) {
        const w = surface.weights[i]![j]!;
        if (!(w > 0)) return regenError(call, "CANNOT_MAKE_BSPLINESURFACE");
        weights.SetValue(i + 1, j + 1, w);
      }
    return new oc.Geom_BSplineSurface(
      poles,
      weights,
      u.knots,
      v.knots,
      u.mults,
      v.mults,
      uDegree,
      vDegree,
      surface.uPeriodic,
      surface.vPeriodic,
    );
  } catch {
    return regenError(call, "CANNOT_MAKE_BSPLINESURFACE");
  }
}

/** A distinct-knot list with multiplicities, flattened the way std writes knots. */
function flatKnots(count: number, knot: (i: number) => number, mult: (i: number) => number) {
  return Array.from({ length: count }, (_, i) =>
    Array<number>(mult(i + 1)).fill(knot(i + 1)),
  ).flat();
}

/** An OpenCascade B-spline surface as std's `BSplineSurface`. Periodic surfaces aren't read back yet. */
function stdSurface(call: BuiltinCall, surface: InstanceType<Oc["Geom_BSplineSurface"]>): FsTagged {
  if (surface.IsUPeriodic() || surface.IsVPeriodic())
    return call.unsupported("Reading a periodic B-spline surface is not supported locally yet.");
  const [rows, columns] = [surface.NbUPoles(), surface.NbVPoles()];
  const rational = surface.IsURational() || surface.IsVRational();
  const vectorType = stdType(call, "vector.fs", "Vector");
  const cells = <T>(read: (i: number, j: number) => T) =>
    Array.from({ length: rows }, (_, i) =>
      Array.from({ length: columns }, (_, j) => read(i + 1, j + 1)),
    );
  return stdTagged(call, "surfaceGeometry.fs", "BSplineSurface", [
    ["uDegree", surface.UDegree()],
    ["vDegree", surface.VDegree()],
    ["isRational", rational],
    ["isUPeriodic", false],
    ["isVPeriodic", false],
    [
      "controlPoints",
      new FsTagged(
        stdType(call, "surfaceGeometry.fs", "ControlPointMatrix"),
        cells((i, j) => {
          const p = surface.Pole(i, j);
          return new FsTagged(
            vectorType,
            [p.X(), p.Y(), p.Z()].map((c) => length(call, c)),
          );
        }),
      ),
    ],
    ...(rational ? [["weights", cells((i, j) => surface.Weight(i, j))] as const] : []),
    [
      "uKnots",
      new FsTagged(
        stdType(call, "curveGeometry.fs", "KnotArray"),
        flatKnots(
          surface.NbUKnots(),
          (i) => surface.UKnot(i),
          (i) => surface.UMultiplicity(i),
        ),
      ),
    ],
    [
      "vKnots",
      new FsTagged(
        stdType(call, "curveGeometry.fs", "KnotArray"),
        flatKnots(
          surface.NbVKnots(),
          (i) => surface.VKnot(i),
          (i) => surface.VMultiplicity(i),
        ),
      ),
    ],
  ]);
}

/** A 2D parameter-space spline in OpenCascade. */
function occtCurve2d(call: BuiltinCall, oc: Oc, spline: Spline) {
  if (spline.dimension !== 2 || spline.periodic)
    return regenError(call, "BAD_2D_BOUNDARY_BSPLINECURVE_DEFINITION");
  const poles = new oc.NCollection_Array1_gp_Pnt2d(1, spline.points.length);
  spline.points.forEach(([x, y], i) => poles.SetValue(i + 1, new oc.gp_Pnt2d(x!, y!)));
  const { knots, mults } = runs(spline.knots);
  const multArray = new oc.NCollection_Array1_int(1, mults.length);
  mults.forEach((m, i) => multArray.SetValue(i + 1, m));
  try {
    return spline.weights
      ? new oc.Geom2d_BSplineCurve(
          poles,
          doubles(oc, spline.weights),
          doubles(oc, knots),
          multArray,
          spline.degree,
          false,
        )
      : new oc.Geom2d_BSplineCurve(poles, doubles(oc, knots), multArray, spline.degree, false);
  } catch {
    return regenError(call, "BAD_2D_BOUNDARY_BSPLINECURVE_DEFINITION");
  }
}

/** An OpenCascade 2D B-spline as a unitless `Spline`. */
function spline2dOf(curve: InstanceType<Oc["Geom2d_BSplineCurve"]>): Spline {
  return {
    degree: curve.Degree(),
    dimension: 2,
    periodic: false,
    points: Array.from({ length: curve.NbPoles() }, (_, i) => {
      const p = curve.Pole(i + 1);
      return [p.X(), p.Y()];
    }),
    weights: curve.IsRational()
      ? Array.from({ length: curve.NbPoles() }, (_, i) => curve.Weight(i + 1))
      : null,
    knots: flatKnots(
      curve.NbKnots(),
      (i) => curve.Knot(i),
      (i) => curve.Multiplicity(i),
    ),
  };
}

/** A unitless 2D std spline (std writes UV boundaries without units). */
function stdUvSpline(call: BuiltinCall, spline: Spline): FsTagged {
  const vectorType = stdType(call, "vector.fs", "Vector");
  return stdTagged(call, "curveGeometry.fs", "BSplineCurve", [
    ["degree", spline.degree],
    ["dimension", 2],
    ["isRational", spline.weights !== null],
    ["isPeriodic", false],
    ["controlPoints", spline.points.map((p) => new FsTagged(vectorType, [...p]))],
    ...(spline.weights ? [["weights", [...spline.weights]] as const] : []),
    ["knots", new FsTagged(stdType(call, "curveGeometry.fs", "KnotArray"), [...spline.knots])],
  ]);
}

/**
 * The face's underlying surface as a B-spline in the face's own parameters, so its pcurves are
 * the boundary: spline faces as they are, planes as the bilinear patch over the face's UV range.
 * Always a copy, so callers may change it without changing the model.
 */
function faceSpline(call: BuiltinCall, oc: Oc, face: Shape) {
  const adaptor = new oc.BRepAdaptor_Surface(oc.TopoDS.Face(face), false);
  const kind = String(adaptor.GetType());
  // BSpline() hands back the face's own surface: copy it so callers can't change the model.
  if (kind === "GeomAbs_BSplineSurface") return new oc.Geom_BSplineSurface(adaptor.BSpline());
  if (kind === "GeomAbs_Plane") {
    const bounds = oc.BRepTools.UVBounds(oc.TopoDS.Face(face));
    const poles = new oc.NCollection_Array2_gp_Pnt(1, 2, 1, 2);
    [bounds.UMin, bounds.UMax].forEach((u, i) =>
      [bounds.VMin, bounds.VMax].forEach((v, j) =>
        poles.SetValue(i + 1, j + 1, adaptor.Value(u, v)),
      ),
    );
    const mults = new oc.NCollection_Array1_int(1, 2);
    mults.SetValue(1, 2);
    mults.SetValue(2, 2);
    return new oc.Geom_BSplineSurface(
      poles,
      doubles(oc, [bounds.UMin, bounds.UMax]),
      doubles(oc, [bounds.VMin, bounds.VMax]),
      mults,
      mults,
      1,
      1,
      false,
      false,
    );
  }
  return call.unsupported(
    `Reading a ${kind.replace("GeomAbs_", "").toLowerCase()} face as a B-spline surface is not supported locally yet.`,
  );
}

/** An edge's curve on a face (its pcurve), as a 2D spline in the face's parameters. */
function pcurveSpline(call: BuiltinCall, oc: Oc, edge: Shape, face: Shape): Spline {
  const pcurve = new oc.BRepAdaptor_Curve2d(oc.TopoDS.Edge(edge), oc.TopoDS.Face(face));
  const [first, last] = [pcurve.FirstParameter(), pcurve.LastParameter()];
  const kind = String(pcurve.GetType());
  let curve: InstanceType<Oc["Geom2d_BSplineCurve"]>;
  if (kind === "GeomAbs_Line") {
    const [a, b] = [pcurve.Value(first), pcurve.Value(last)];
    const ends = new oc.NCollection_Array1_gp_Pnt2d(1, 2);
    ends.SetValue(1, a);
    ends.SetValue(2, b);
    const mults = new oc.NCollection_Array1_int(1, 2);
    mults.SetValue(1, 2);
    mults.SetValue(2, 2);
    curve = new oc.Geom2d_BSplineCurve(ends, doubles(oc, [first, last]), mults, 1, false);
  } else if (kind === "GeomAbs_Circle")
    curve = oc.Geom2dConvert.CurveToBSplineCurve(
      new oc.Geom2d_TrimmedCurve(new oc.Geom2d_Circle(pcurve.Circle()), first, last, true, true),
    );
  else if (kind === "GeomAbs_BSplineCurve") {
    // BSpline() hands back the edge's own pcurve: copy it before segmenting or reversing.
    curve = new oc.Geom2d_BSplineCurve(pcurve.BSpline());
    if (
      Math.abs(curve.FirstParameter() - first) > 1e-12 ||
      Math.abs(curve.LastParameter() - last) > 1e-12
    )
      curve.Segment(first, last);
  } else
    return call.unsupported(
      `A ${kind.replace("GeomAbs_", "").toLowerCase()} trim curve is not supported locally yet.`,
    );
  if (String(edge.Orientation()) === "TopAbs_REVERSED") curve.Reverse();
  return spline2dOf(curve);
}

/** A face's loops as 2D splines in its surface's parameters: outer first, then each inner loop. */
function faceLoops(call: BuiltinCall, oc: Oc, face: Shape): Spline[][] {
  const outer = oc.BRepTools.OuterWire(oc.TopoDS.Face(face));
  const wires = subShapes(oc, face, "WIRE");
  return [outer, ...wires.filter((w) => !w.IsSame(outer))].map((wire) => {
    const loop: Spline[] = [];
    for (
      const explorer = new oc.TopExp_Explorer(wire, oc.TopAbs_ShapeEnum.TopAbs_EDGE);
      explorer.More();
      explorer.Next()
    ) {
      if (oc.BRep_Tool.Degenerated(oc.TopoDS.Edge(explorer.Current()))) continue;
      loop.push(pcurveSpline(call, oc, explorer.Current(), face));
    }
    return loop;
  });
}

/**
 * What `evSurfaceDefinition` returns for a B-spline face: std's `BSplineSurface`. For
 * evaluators.ts, which owns `evSurfaceDefinition`.
 */
export const faceSurfaceDefinition = (call: BuiltinCall, oc: Oc, face: Shape): FsTagged =>
  stdSurface(call, faceSpline(call, oc, face));

/** The faces a query names, with every face of the bodies it names. */
function facesNamed(model: ModelContext, entities: readonly Entity[]): Entity[] {
  const bodies = new Set(entities.filter((e) => e.type === "BODY").map((e) => e.id));
  return [...model.geometry.entities.values()].filter(
    (e) => e.type === "FACE" && (entities.includes(e) || bodies.has(e.body)),
  );
}

/** The edges a query names, with every edge of the bodies it names. */
function edgesNamed(model: ModelContext, entities: readonly Entity[]): Entity[] {
  const bodies = new Set(entities.filter((e) => e.type === "BODY").map((e) => e.id));
  return [...model.geometry.entities.values()].filter(
    (e) => e.type === "EDGE" && (entities.includes(e) || bodies.has(e.body)),
  );
}

/**
 * Where a surface may fold: at an interior knot (or a periodic seam) with multiplicity of at least
 * the degree, only position is continuous. std requires G1, so the tangent planes on either side
 * must agree all along such a knot, including over a fold that only one pole's short reach makes.
 */
function creaseError(oc: Oc, surface: InstanceType<Oc["Geom_BSplineSurface"]>): string | null {
  const bounds = surface.Bounds(0, 0, 0, 0);
  const normal = (u: number, v: number) => {
    const { D1U, D1V } = surface.EvalD1(u, v);
    return D1U.Crossed(D1V);
  };
  const across = (direction: "u" | "v") => {
    const inU = direction === "u";
    const [low, high] = inU ? [bounds.U1, bounds.U2] : [bounds.V1, bounds.V2];
    const count = inU ? surface.NbUKnots() : surface.NbVKnots();
    const degree = inU ? surface.UDegree() : surface.VDegree();
    const periodic = inU ? surface.IsUPeriodic() : surface.IsVPeriodic();
    const knot = (i: number) => (inU ? surface.UKnot(i) : surface.VKnot(i));
    const mult = (i: number) => (inU ? surface.UMultiplicity(i) : surface.VMultiplicity(i));
    // Along the knot line, the other direction's knots and degree set how finely to look.
    const alongKnots = Array.from(
      { length: inU ? surface.NbVKnots() : surface.NbUKnots() },
      (_, i) => (inU ? surface.VKnot(i + 1) : surface.UKnot(i + 1)),
    );
    const alongDegree = inU ? surface.VDegree() : surface.UDegree();
    const step = (high - low) * 1e-9;
    for (let i = periodic ? 1 : 2; i < count; i++) {
      if (mult(i) < degree) continue;
      const k = knot(i);
      // A periodic seam is approached from the end of the period on one side.
      const [before, after] =
        periodic && i === 1 ? [high - step, low + step] : [k - step, k + step];
      const fold = (w: number) => {
        const [a, b] = inU
          ? [normal(before, w), normal(after, w)]
          : [normal(w, before), normal(w, after)];
        return a.Magnitude() < 1e-15 || b.Magnitude() < 1e-15 ? 0 : a.Angle(b);
      };
      if (peakOf(alongKnots, alongDegree, fold).value > 1e-6)
        return periodic && i === 1 ? "PERIODIC_BSPLINESURFACE_NOT_SMOOTH" : "BSPLINESURFACE_NOT_G1";
    }
    return null;
  };
  return across("u") ?? across("v");
}

/**
 * Checks that 2D boundary curves form one closed loop, end to end in some order, and returns them
 * in walking order (each the right way round). Null when they don't.
 */
function singleLoop(
  curves: readonly InstanceType<Oc["Geom2d_BSplineCurve"]>[],
): InstanceType<Oc["Geom2d_BSplineCurve"]>[] | null {
  if (curves.length === 0) return null;
  const near = (a: InstanceType<Oc["gp_Pnt2d"]>, b: InstanceType<Oc["gp_Pnt2d"]>) =>
    a.Distance(b) < 1e-9;
  const loop = [curves[0]!];
  const left = curves.slice(1);
  while (left.length) {
    const tip = loop.at(-1)!.EndPoint();
    const next = left.findIndex((c) => near(c.StartPoint(), tip) || near(c.EndPoint(), tip));
    if (next < 0) return null;
    const [curve] = left.splice(next, 1);
    if (!near(curve!.StartPoint(), tip)) curve!.Reverse();
    loop.push(curve!);
  }
  return near(loop.at(-1)!.EndPoint(), loop[0]!.StartPoint()) ? loop : null;
}

export const SURFACE_BUILTINS = {
  /**
   * A sheet on a B-spline surface: the whole parameter range, or trimmed to a loop of 2D boundary
   * splines in its UV space. With `makeSolid`, a surface that closes on itself becomes a solid.
   */
  opCreateBSplineSurface: ([ctx, id, value], call) => {
    const { model, oc } = kernel(call, ctx);
    const definition = map(call, value, "definition");
    const surface = occtSurface(call, oc, readSurface(call, definition.getField("bSplineSurface")));
    const boundaryValue = definition.getField("boundaryBSplineCurves");
    const boundary =
      boundaryValue === undefined
        ? []
        : array(call, boundaryValue, "boundaryBSplineCurves").map((c, i) =>
            occtCurve2d(call, oc, readSpline(call, c, `boundaryBSplineCurves[${i}]`)),
          );
    const crease = creaseError(oc, surface);
    if (crease) return regenError(call, crease);
    let face: Shape;
    if (boundary.length === 0) {
      const bounds = surface.Bounds(0, 0, 0, 0);
      face = new oc.BRepBuilderAPI_MakeFace(
        surface,
        bounds.U1,
        bounds.U2,
        bounds.V1,
        bounds.V2,
        1e-7,
      ).Face();
    } else {
      const loop = singleLoop(boundary);
      if (!loop) return regenError(call, "BSPLINESURFACE_BOUNDARY_NOT_SINGLE_CLOSED_LOOP");
      const wire = new oc.BRepBuilderAPI_MakeWire();
      for (const curve of loop) wire.Add(new oc.BRepBuilderAPI_MakeEdge(curve, surface).Edge());
      if (!wire.IsDone()) return regenError(call, "BSPLINESURFACE_BOUNDARY_NOT_SINGLE_CLOSED_LOOP");
      const made = new oc.BRepBuilderAPI_MakeFace(surface, wire.Wire(), true);
      if (!made.IsDone()) return regenError(call, "BSPLINESURFACE_BOUNDARY_NOT_SINGLE_CLOSED_LOOP");
      oc.BRepLib.BuildCurves3d(made.Face());
      // Wound the wrong way, the loop would bound everything but itself.
      const fix = new oc.ShapeFix_Face(made.Face());
      fix.Perform();
      face = fix.Face();
    }
    if (untag(definition.getField("makeSolid")) === true)
      return call.unsupported(
        "opCreateBSplineSurface with makeSolid is not supported locally yet.",
      );
    model.geometry = addBodies(oc, model.geometry, [
      {
        shape: requireValid(
          call,
          oc,
          face,
          boundary.length
            ? "BSPLINESURFACE_BOUNDARY_NOT_SINGLE_CLOSED_LOOP"
            : "CANNOT_MAKE_BSPLINESURFACE",
        ),
        bodyType: "SHEET",
        createdBy: idOf(id),
      },
    ]).state;
    return undefined;
  },

  /**
   * A face as a B-spline surface with its trim loops in the surface's UV space. B-spline faces
   * come back exactly and planes as bilinear patches; other surfaces aren't approximated yet.
   */
  evApproximateBSplineSurface: ([ctx, value], call) => {
    const { model, oc } = kernel(call, ctx);
    const definition = map(call, value, "definition");
    const face = resolve(call, model, oc, definition.getField("face")).find(
      (e) => e.type === "FACE",
    );
    if (!face) return regenError(call, "CANNOT_RESOLVE_ENTITIES");
    const surface = faceSpline(call, oc, face.shape);
    const cubic = untag(definition.getField("forceCubic")) === true;
    if (
      cubic &&
      !(surface.IsURational() || surface.IsVRational()) &&
      surface.UDegree() <= 3 &&
      surface.VDegree() <= 3
    )
      surface.IncreaseDegree(3, 3);
    if (
      (cubic && (surface.UDegree() !== 3 || surface.VDegree() !== 3)) ||
      (untag(definition.getField("forceNonRational")) === true &&
        (surface.IsURational() || surface.IsVRational()))
    )
      return call.unsupported(
        "Approximating a face as a cubic or non-rational surface is not supported locally yet.",
      );
    // A face that is its whole surface has no trim loops.
    const natural = oc.BRep_Tool.NaturalRestriction(oc.TopoDS.Face(face.shape));
    const [outer = [], ...inner] = natural ? [] : faceLoops(call, oc, face.shape);
    return FsMap.fromEntries([
      ["bSplineSurface", stdSurface(call, surface)],
      ["boundaryBSplineCurves", outer.map((spline) => stdUvSpline(call, spline))],
      [
        "innerLoopBSplineCurves",
        inner.map((loop) => loop.map((spline) => stdUvSpline(call, spline))),
      ],
    ]);
  },

  /**
   * A sheet filling a loop of edges: through G0 edges, tangent (G1) or curvature-continuous (G2)
   * to the face beside a boundary edge, and through guide vertices and curves. A G1 or G2 edge
   * needs exactly one face beside it (a sheet's boundary, or one given in `adjacentFaces`).
   */
  opFillSurface: ([ctx, id, value], call) => {
    const { model, oc } = kernel(call, ctx);
    const definition = map(call, value, "definition");
    const edgesOf = (name: string) => {
      const query = definition.getField(name);
      return query === undefined ? [] : edgesNamed(model, resolve(call, model, oc, query));
    };
    const adjacent = (
      definition.getField("adjacentFaces") === undefined
        ? []
        : array(call, definition.getField("adjacentFaces"), "adjacentFaces")
    ).map((entry, i) => {
      const fields = map(call, entry, `adjacentFaces[${i}]`);
      return {
        edges: new Set(resolve(call, model, oc, fields.getField("edges")).map((e) => e.id)),
        faces: facesNamed(model, resolve(call, model, oc, fields.getField("faces"))),
      };
    });
    const fill = new oc.BRepOffsetAPI_MakeFilling(3, 15, 2, false, 1e-5, 1e-6, 1e-2, 1e-1, 8, 9);
    const boundary = [
      ...edgesOf("edgesG0").map((edge) => ({ edge, order: "C0" as const })),
      ...edgesOf("edgesG1").map((edge) => ({ edge, order: "G1" as const })),
      ...edgesOf("edgesG2").map((edge) => ({ edge, order: "G2" as const })),
    ];
    if (boundary.length === 0) return regenError(call, "FILL_SURFACE_NO_EDGES");
    // The same curve twice (a sketch's wire edge and its region's edge, say) is a double selection.
    const mark = (edge: Shape) => {
      const curve = new oc.BRepAdaptor_Curve(oc.TopoDS.Edge(edge));
      const [a, b] = [curve.FirstParameter(), curve.LastParameter()];
      return [a, (a + b) / 2, b].map((u) => {
        const p = curve.Value(u);
        return [p.X(), p.Y(), p.Z()];
      });
    };
    const marks = boundary.map(({ edge }) => mark(edge.shape));
    const overlaps = (x: number[][], y: number[][]) =>
      Math.hypot(...x[1]!.map((c, k) => c - y[1]![k]!)) < 1e-7 &&
      [x[0]!, x[2]!].every((end) =>
        [y[0]!, y[2]!].some((other) => Math.hypot(...end.map((c, k) => c - other[k]!)) < 1e-7),
      );
    if (marks.some((m, i) => marks.some((other, j) => j > i && overlaps(m, other))))
      return regenError(call, "FILL_SURFACE_DOUBLE_SELECTION");
    for (const { edge, order } of boundary) {
      if (order === "C0") {
        fill.Add(oc.TopoDS.Edge(edge.shape), oc.GeomAbs_Shape.GeomAbs_C0, true);
        continue;
      }
      const given = adjacent.find((entry) => entry.edges.has(edge.id))?.faces;
      const beside = (given ?? facesNamed(model, [model.geometry.entities.get(edge.body)!])).filter(
        (face) => subShapes(oc, face.shape, "EDGE").some((e) => e.IsSame(edge.shape)),
      );
      if (beside.length !== 1)
        return call.unsupported(
          `opFillSurface ${order} needs exactly one adjacent face beside each edge; this edge has ${beside.length}.`,
        );
      fill.Add(
        oc.TopoDS.Edge(edge.shape),
        oc.TopoDS.Face(beside[0]!.shape),
        order === "G1" ? oc.GeomAbs_Shape.GeomAbs_G1 : oc.GeomAbs_Shape.GeomAbs_G2,
        true,
      );
    }
    for (const name of ["guideVertices", "guideEntities"]) {
      const query = definition.getField(name);
      if (query === undefined) continue;
      for (const entity of resolve(call, model, oc, query)) {
        if (entity.type === "EDGE")
          fill.Add(oc.TopoDS.Edge(entity.shape), oc.GeomAbs_Shape.GeomAbs_C0, false);
        else
          for (const vertex of subShapes(oc, entity.shape, "VERTEX"))
            fill.Add(oc.BRep_Tool.Pnt(oc.TopoDS.Vertex(vertex)));
      }
    }
    try {
      fill.Build(new oc.Message_ProgressRange());
    } catch {
      return regenError(call, "FILL_SURFACE_FAIL");
    }
    if (!fill.IsDone()) return regenError(call, "FILL_SURFACE_FAIL");
    const faces = subShapes(oc, fill.Shape(), "FACE");
    if (faces.length !== 1) return regenError(call, "FILL_SURFACE_FAIL");
    model.geometry = addBodies(oc, model.geometry, [
      {
        shape: requireValid(call, oc, faces[0]!, "FILL_SURFACE_FAIL"),
        bodyType: "SHEET",
        createdBy: idOf(id),
      },
    ]).state;
    return undefined;
  },

  /**
   * Solids from sheets and faces that meet edge to edge into closed shells. Sheets that cross
   * each other would need trimming at the crossings first, which isn't done locally.
   */
  opEnclose: ([ctx, id, value], call) => {
    const { model, oc } = kernel(call, ctx);
    const faces = facesNamed(
      model,
      resolve(call, model, oc, map(call, value, "definition").getField("entities")),
    );
    if (faces.length === 0) return regenError(call, "ENCLOSE_NOTHING_SELECTED");
    const sewing = new oc.BRepBuilderAPI_Sewing(1e-6, true, true, true, false);
    for (const face of faces) sewing.Add(face.shape);
    sewing.Perform(new oc.Message_ProgressRange());
    const shells = subShapes(oc, sewing.SewedShape(), "SHELL");
    const closed = shells.filter((shell) => oc.BRep_Tool.IsClosed(shell));
    if (closed.length === 0 || closed.length !== shells.length)
      return call.unsupported(
        "opEnclose of sheets that cross or overlap (rather than meet edge to edge) is not supported locally yet.",
      );
    const solids = closed.map((shell) => {
      const solid = new oc.BRepBuilderAPI_MakeSolid(oc.TopoDS.Shell(shell)).Solid();
      const props = new oc.GProp_GProps();
      oc.BRepGProp.VolumeProperties(solid, props, false, false, false);
      return requireValid(
        call,
        oc,
        props.Mass() < 0 ? solid.Reversed() : solid,
        "ENCLOSE_CANNOT_CREATE_SOLID",
      );
    });
    model.geometry = addBodies(
      oc,
      model.geometry,
      solids.map((shape) => ({ shape, bodyType: "SOLID" as const, createdBy: idOf(id) })),
    ).state;
    return undefined;
  },
  /**
   * A ruled surface along `path`. Locally only rulings aligned with `ruledDirection` (angle 0, no
   * vertex overrides) are built: the path swept straight along the direction by `width`, which
   * may be negative. Frames for manipulator positions stop the run (std asks for them only for
   * normal-to-face rulings).
   */
  opRuledSurface: ([ctx, id, value], call) => {
    const { model, oc } = kernel(call, ctx);
    const definition = map(call, value, "definition");
    const field = (name: string) => definition.getField(name);
    const type = String(untag(field("ruledSurfaceType")));
    const angle = field("angle") === undefined ? 0 : magnitude(call, field("angle"), "angle");
    if (type !== "ALIGNED_WITH_VECTOR" || Math.abs(angle) > 1e-12)
      return call.unsupported(`opRuledSurface of type ${type} is not supported locally yet.`);
    // std reads frames only for normal-to-face rulings; for aligned ones their axes are undefined.
    const positions = field("manipulatorPositions");
    if (positions !== undefined && array(call, positions, "manipulatorPositions").length > 0)
      return call.unsupported(
        "opRuledSurface frames for manipulatorPositions are not supported locally yet.",
      );
    const overrides = field("vertexOverrides");
    if (overrides !== undefined && array(call, overrides, "vertexOverrides").length > 0)
      return call.unsupported("opRuledSurface with vertex overrides is not supported locally yet.");
    const edges = edgesNamed(model, resolve(call, model, oc, field("path")));
    if (edges.length === 0) return regenError(call, "RULED_SURFACE_SELECT_EDGES");
    const width = magnitude(call, field("width"), "width");
    if (Math.abs(width) < 1e-12) return regenError(call, "RULED_SURFACE_ZERO_LENGTH");
    const direction = array(call, field("ruledDirection"), "ruledDirection").map((c) =>
      magnitude(call, c, "ruledDirection"),
    );
    const size = Math.hypot(...direction);
    if (direction.length !== 3 || size < 1e-12)
      return regenError(call, "RULED_SURFACE_SELECT_DIRECTION");
    const along = direction.map((c) => (c / size) * width);
    const faces = edges.flatMap((edge) =>
      subShapes(
        oc,
        new oc.BRepPrimAPI_MakePrism(
          edge.shape,
          new oc.gp_Vec(along[0]!, along[1]!, along[2]!),
          true,
          true,
        ).Shape(),
        "FACE",
      ),
    );
    // Faces of edges that meet share their ruling, so sewing joins them into one sheet each.
    const sewing = new oc.BRepBuilderAPI_Sewing(1e-7, true, true, true, false);
    for (const face of faces) sewing.Add(face);
    sewing.Perform(new oc.Message_ProgressRange());
    const sewn = sewing.SewedShape();
    // A sheet for each sewn shell, and for each face of a path that joined nothing.
    const shells = subShapes(oc, sewn, "SHELL");
    const inShell = new ShapeSet<true>(oc);
    for (const shell of shells)
      for (const face of subShapes(oc, shell, "FACE")) inShell.set(face, true);
    const bodies = [...shells, ...subShapes(oc, sewn, "FACE").filter((face) => !inShell.has(face))];
    model.geometry = addBodies(
      oc,
      model.geometry,
      bodies.map((shape) => ({
        shape: requireValid(call, oc, shape, "RULED_SURFACE_FAILED"),
        bodyType: "SHEET" as const,
        createdBy: idOf(id),
      })),
    ).state;
    return [];
  },
} satisfies Partial<Record<StdBuiltinName, BuiltinImpl>>;
