import {
  addBodies,
  historyOf,
  nameTopology,
  replaceBodies,
  type Entity,
  type TopologyName,
} from "../geometry/Model.ts";
import { distance } from "../geometry/Query.ts";
import type { Vec3 } from "../geometry/Sketch.ts";
import {
  fromList,
  ShapeSet,
  subShapes,
  toList,
  xyz,
  type Oc,
  type Shape,
} from "../geometry/occt.ts";
import type { BuiltinCall, BuiltinImpl } from "../runtime/Interpreter.ts";
import { equals, FsMap, FsTagged, untag, type FsValue } from "../runtime/Value.ts";
import { array, map } from "./args.ts";
import { idOf, kernel, magnitude, normalized, resolve, vector } from "./geometryArgs.ts";
import { regenError, stdType } from "./std.ts";
import { requireValid } from "./validity.ts";
import type { StdBuiltinName } from "./stdBuiltinNames.generated.ts";

/**
 * `opHole`: revolved hole tools placed along each axis by std's `HolePositionReference`s, measured
 * where an infinite cylinder of the hole's largest radius meets the targets, then subtracted.
 */

/** std's `TOLERANCE.zeroLength`, in meters. */
const TOLERANCE = 1e-8;

const REFERENCES = [
  "AXIS_POINT",
  "TARGET_START",
  "LAST_TARGET_START",
  "LAST_TARGET_END",
  "UP_TO_ENTITY",
  "UP_TO_NEXT",
  "LAST_TARGET_START_IN_DEPTH",
] as const;
type Reference = (typeof REFERENCES)[number];
const isReference = (value: unknown): value is Reference =>
  REFERENCES.some((reference) => reference === value);

/** One `HoleProfile`, lengths in meters. */
interface Profile {
  readonly reference: Reference;
  readonly before: boolean;
  readonly matched: boolean;
  readonly position: number;
  readonly radius: number;
  readonly mustDiffer: boolean;
  readonly notForFirst: boolean;
  readonly name: string | null;
}

function profileOf(call: BuiltinCall, value: FsValue, i: number): Profile {
  const profile = map(call, value, `profiles[${i}]`);
  const field = (name: string) => untag(profile.getField(name));
  const reference = field("positionReference");
  if (!isReference(reference))
    return call.fail(`profiles[${i}].positionReference must be a HolePositionReference.`);
  const matched = field("profileType") === "MATCHED";
  const name = field("name");
  return {
    reference,
    matched,
    before: field("beforeReference") === true,
    position: matched
      ? 0
      : magnitude(call, profile.getField("position"), `profiles[${i}].position`),
    radius: magnitude(call, profile.getField("radius"), `profiles[${i}].radius`),
    mustDiffer: field("targetMustDifferFromPrevious") === true,
    notForFirst: field("notApplicableForFirstTarget") === true,
    name: typeof name === "string" ? name : null,
  };
}

/** A hole axis with a unit direction and a unit x perpendicular to it. */
interface Axis {
  readonly origin: Vec3;
  readonly direction: Vec3;
  readonly x: Vec3;
}
const along = ({ origin, direction, x }: Axis, radius: number, t: number): Vec3 => [
  origin[0] + direction[0] * t + x[0] * radius,
  origin[1] + direction[1] * t + x[1] * radius,
  origin[2] + direction[2] * t + x[2] * radius,
];
/** Any unit vector perpendicular to `d`. */
function perpendicular(d: Vec3): Vec3 {
  const [x, y, z] = d.map(Math.abs) as unknown as Vec3;
  const other: Vec3 = x <= y && x <= z ? [1, 0, 0] : y <= z ? [0, 1, 0] : [0, 0, 1];
  return normalized([
    d[1] * other[2] - d[2] * other[1],
    d[2] * other[0] - d[0] * other[2],
    d[0] * other[1] - d[1] * other[0],
  ]);
}

/**
 * Where the hole cylinder passes through a target, as distances along the axis: it starts entering
 * at `firstEntrance` and is fully in at `fullEntrance` (equal on a face square to the axis), then
 * starts leaving at `firstExit` and is out at `fullExit`.
 */
interface Passage {
  readonly firstEntrance: number;
  readonly fullEntrance: number;
  readonly firstExit: number;
  readonly fullExit: number;
}

/** Lowest and highest z of a shape. */
function zRange(oc: Oc, shape: Shape): [number, number] {
  const box = new oc.Bnd_Box();
  oc.BRepBndLib.AddOptimal(shape, box, false, false);
  return [box.GetZMin(), box.GetZMax()];
}

/**
 * The passages of a cylinder of `radius` around `axis` through `body`, in axis order, skipping any
 * wholly behind the axis point. Measured in the axis frame (z along the axis), on the edges where
 * the cylinder's wall meets the body: the material lies above an entering edge and below a leaving
 * one. The first entrance is the cylinder's first contact anywhere (a dome inside the radius comes
 * before the wall's rim); a body the cylinder swallows whole uses its own extent.
 */
function passages(oc: Oc, body: Shape, axis: Axis, radius: number, reach: number): Passage[] {
  const frame = new oc.gp_Trsf();
  frame.SetTransformation(
    new oc.gp_Ax3(
      new oc.gp_Pnt(...axis.origin),
      new oc.gp_Dir(...axis.direction),
      new oc.gp_Dir(...axis.x),
    ),
  );
  const local = new oc.BRepBuilderAPI_Transform(body, frame, true, false).Shape();
  const cylinder = new oc.BRepPrimAPI_MakeCylinder(
    new oc.gp_Ax2(new oc.gp_Pnt(0, 0, -reach), new oc.gp_Dir(0, 0, 1)),
    radius,
    2 * reach,
  ).Shape();
  const common = new oc.BRepAlgoAPI_Common(local, cylinder, new oc.Message_ProgressRange());
  if (common.HasErrors()) return [];
  const found: Passage[] = [];
  for (const piece of subShapes(oc, common.Shape(), "SOLID")) {
    const entering: number[] = [];
    const leaving: number[] = [];
    for (const face of subShapes(oc, piece, "FACE")) {
      const surface = new oc.BRepAdaptor_Surface(oc.TopoDS.Face(face), true);
      if (String(surface.GetType()) !== "GeomAbs_Cylinder") continue;
      const wall = surface.Cylinder();
      const [ax, ay] = xyz(wall.Location());
      if (Math.abs(wall.Radius() - radius) > TOLERANCE || Math.hypot(ax, ay) > TOLERANCE) continue;
      for (
        const explorer = new oc.TopExp_Explorer(face, oc.TopAbs_ShapeEnum.TopAbs_EDGE);
        explorer.More();
        explorer.Next()
      ) {
        const edge = oc.TopoDS.Edge(explorer.Current());
        if (oc.BRep_Tool.Degenerated(edge) || oc.BRep_Tool.IsClosed(edge, oc.TopoDS.Face(face)))
          continue;
        // The material is to the left of an edge walked in its face's direction, seen from
        // outside; the wall's outside faces away from the axis.
        const curve = new oc.BRepAdaptor_Curve(edge);
        const { Point, D1 } = curve.EvalD1((curve.FirstParameter() + curve.LastParameter()) / 2);
        const [px, py] = xyz(Point);
        const sign = String(explorer.Current().Orientation()) === "TopAbs_REVERSED" ? -1 : 1;
        const [tx, ty] = xyz(D1).map((c) => c * sign);
        const up = px * ty! - py * tx!;
        if (Math.abs(up) < 1e-9 * Math.hypot(tx!, ty!) * radius) continue;
        (up > 0 ? entering : leaving).push(...zRange(oc, edge));
      }
    }
    const [low, high] = zRange(oc, piece);
    found.push({
      // Where the cylinder first meets the target: the piece's own top, which inside the radius
      // (a dome) lies above the rim where the wall cuts in.
      firstEntrance: Math.min(low, ...entering),
      fullEntrance: entering.length ? Math.max(...entering) : low,
      firstExit: leaving.length ? Math.min(...leaving) : high,
      fullExit: leaving.length ? Math.max(...leaving) : high,
    });
  }
  return found
    .filter((passage) => passage.fullExit > -TOLERANCE)
    .sort((a, b) => a.firstEntrance - b.firstEntrance || a.fullEntrance - b.fullEntrance);
}

/** Where a `HolePositionReference` lies along the axis, and the target that defines it. */
interface Root {
  readonly start: number;
  readonly end: number;
  readonly target: Entity | null;
}
interface Hit {
  readonly target: Entity;
  readonly passages: readonly Passage[];
}

/**
 * Roots of the position references for one axis. `endBound` places UP_TO_ENTITY;
 * LAST_TARGET_START_IN_DEPTH needs the hole's depth (`limit`).
 */
function rootFinder(hits: readonly Hit[], endBound: () => number | null) {
  // Entrances wholly behind the axis point don't count.
  const firstEntries = hits.flatMap((hit) => {
    const passage = hit.passages.find((p) => p.fullEntrance > -TOLERANCE);
    return passage ? [{ target: hit.target, passage }] : [];
  });
  const earliest = firstEntries.reduce<(typeof firstEntries)[number] | null>(
    (best, entry) =>
      !best || entry.passage.firstEntrance < best.passage.firstEntrance - TOLERANCE ? entry : best,
    null,
  );
  const entryRoot = (entry: (typeof firstEntries)[number] | null | undefined): Root | null =>
    entry
      ? {
          start: entry.passage.firstEntrance,
          end: entry.passage.fullEntrance,
          target: entry.target,
        }
      : null;
  const furthestEntry = (limit: number) =>
    firstEntries
      .filter((entry) => entry.passage.firstEntrance < limit - TOLERANCE)
      .reduce<(typeof firstEntries)[number] | null>(
        (best, entry) =>
          !best || entry.passage.firstEntrance > best.passage.firstEntrance + TOLERANCE
            ? entry
            : best,
        null,
      );
  return (reference: Reference, limit = Number.POSITIVE_INFINITY): Root | null => {
    switch (reference) {
      case "AXIS_POINT":
        return { start: 0, end: 0, target: null };
      case "TARGET_START":
        return entryRoot(earliest);
      case "LAST_TARGET_START":
        return entryRoot(furthestEntry(Number.POSITIVE_INFINITY));
      case "LAST_TARGET_START_IN_DEPTH":
        return entryRoot(furthestEntry(limit));
      case "LAST_TARGET_END": {
        const last = hits
          .flatMap((hit) => hit.passages.map((passage) => ({ target: hit.target, passage })))
          .reduce<{ target: Entity; passage: Passage } | null>(
            (best, exit) =>
              !best || exit.passage.fullExit > best.passage.fullExit + TOLERANCE ? exit : best,
            null,
          );
        return last
          ? { start: last.passage.firstExit, end: last.passage.fullExit, target: last.target }
          : null;
      }
      case "UP_TO_NEXT":
        // The next face along the hole: where it leaves the first target it enters.
        return earliest
          ? {
              start: earliest.passage.firstExit,
              end: earliest.passage.fullExit,
              target: earliest.target,
            }
          : null;
      case "UP_TO_ENTITY": {
        const t = endBound();
        return t === null ? null : { start: t, end: t, target: null };
      }
    }
  };
}

/** A profile at its final place along the axis. */
interface Placed {
  readonly index: number;
  readonly profile: Profile;
  readonly t: number;
  readonly root: Root;
}

type Placement =
  | { readonly ok: true; readonly placed: readonly Placed[]; readonly roots: Map<Reference, Root> }
  | { readonly ok: false; readonly error: string };

/**
 * Places the profiles: each at its reference's root (its start for `beforeReference`) plus
 * `position`. A `notApplicableForFirstTarget` profile whose target is the first target is skipped:
 * its radius change happens where the previous profile is, so a clearance step in a single part
 * leaves a tap-drill hole, the size std then reports. A profile whose target repeats the previous
 * one fails the hole when it must differ.
 */
function place(
  call: BuiltinCall,
  profiles: readonly Profile[],
  root: ReturnType<typeof rootFinder>,
): Placement {
  const firstTarget = root("TARGET_START")?.target ?? null;
  const at = (profile: Profile, found: Root) =>
    profile.matched ? found.end : (profile.before ? found.start : found.end) + profile.position;
  // LAST_TARGET_START_IN_DEPTH looks only as deep as the rest of the hole goes before its tip.
  let limit = Number.NEGATIVE_INFINITY;
  for (const profile of profiles) {
    if (profile.reference === "LAST_TARGET_START_IN_DEPTH" || profile.radius <= TOLERANCE) continue;
    const found = root(profile.reference);
    if (found) limit = at(profile, found);
  }
  const placed: Placed[] = [];
  const roots = new Map<Reference, Root>();
  for (const [index, profile] of profiles.entries()) {
    const found = root(profile.reference, limit);
    const previous = placed.at(-1);
    if (profile.notForFirst && (!found || found.target === firstTarget)) {
      if (previous) placed.push({ index, profile, t: previous.t, root: previous.root });
      continue;
    }
    if (!found)
      return {
        ok: false,
        error: profile.reference === "UP_TO_ENTITY" ? "HOLE_NO_END_BOUNDS" : "HOLE_NO_HITS",
      };
    if (profile.mustDiffer && previous?.root.target === found.target)
      return { ok: false, error: "HOLE_TARGETS_DO_NOT_DIFFER" };
    if (profile.matched && found.end - found.start > TOLERANCE)
      return call.unsupported(
        "opHole: a matched hole profile on a face that isn't perpendicular to the hole axis is not supported locally yet.",
      );
    placed.push({ index, profile, t: at(profile, found), root: found });
    roots.set(profile.reference, found);
  }
  if (placed.length < 2 || placed.at(-1)!.profile.radius > TOLERANCE)
    return { ok: false, error: "HOLE_TOOL_CONSTRUCTION_FAILED" };
  for (let i = 1; i < placed.length; i++)
    if (placed[i]!.t < placed[i - 1]!.t - TOLERANCE)
      return { ok: false, error: "HOLE_TOOL_CONSTRUCTION_FAILED" };
  return { ok: true, placed: simplified(placed), roots };
}

/**
 * Profiles that land on each other collapse into the first, which keeps its name. Of several radii
 * at one position only the first and last matter (one flat step), and at the top only the last,
 * since the cap already starts at the axis.
 */
function simplified(placed: readonly Placed[]): Placed[] {
  const same = (a: number, b: number) => Math.abs(a - b) <= TOLERANCE;
  const distinct = placed.filter(
    (p, i) =>
      i === 0 ||
      !same(p.t, placed[i - 1]!.t) ||
      !same(p.profile.radius, placed[i - 1]!.profile.radius),
  );
  return distinct.filter((p, i) => {
    const before = distinct[i - 1];
    const after = distinct[i + 1];
    const runContinues = after !== undefined && same(after.t, p.t);
    if (!before || !same(before.t, p.t)) return !(runContinues && i === 0);
    return !runContinues;
  });
}

/** A hole tool and the names std gave its faces and profiles. */
interface Tool {
  readonly solid: Shape;
  readonly names: readonly { readonly shape: Shape; readonly name: TopologyName }[];
}

/**
 * Revolves the profile polyline (radius against axial position) about the axis. `faceNames[i]` names
 * the face before profile `i`; `faceNames[0]` the top cap.
 */
function buildTool(
  oc: Oc,
  axis: Axis,
  placed: readonly Placed[],
  faceNames: readonly (string | null)[],
  naming: Omit<TopologyName, "kind" | "name">,
): Tool | null {
  const top = placed[0]!;
  const bottom = placed.at(-1)!;
  if (bottom.t - top.t <= TOLERANCE) return null;
  const vertex = (radius: number, t: number) =>
    new oc.BRepBuilderAPI_MakeVertex(new oc.gp_Pnt(...along(axis, radius, t))).Vertex();
  const corners = placed.map((p) => vertex(p.profile.radius, p.t));
  const start = top.profile.radius > TOLERANCE ? vertex(0, top.t) : corners[0]!;
  const edge = (a: Shape, b: Shape) =>
    new oc.BRepBuilderAPI_MakeEdge(oc.TopoDS.Vertex(a), oc.TopoDS.Vertex(b)).Edge();
  const sides: { edge: Shape; name: string | null }[] = [];
  if (start !== corners[0])
    sides.push({ edge: edge(start, corners[0]!), name: faceNames[0] ?? null });
  for (let i = 1; i < placed.length; i++)
    sides.push({
      edge: edge(corners[i - 1]!, corners[i]!),
      name: faceNames[placed[i]!.index] ?? null,
    });
  const wire = new oc.BRepBuilderAPI_MakeWire();
  for (const side of sides) wire.Add(oc.TopoDS.Edge(side.edge));
  wire.Add(oc.TopoDS.Edge(edge(corners.at(-1)!, start)));
  const face = new oc.BRepBuilderAPI_MakeFace(wire.Wire(), true).Face();
  const revol = new oc.BRepPrimAPI_MakeRevol(
    face,
    new oc.gp_Ax1(new oc.gp_Pnt(...axis.origin), new oc.gp_Dir(...axis.direction)),
    2 * Math.PI,
    false,
  );
  revol.Build(new oc.Message_ProgressRange());
  if (!revol.IsDone()) return null;
  let solid = subShapes(oc, revol.Shape(), "SOLID")[0];
  if (!solid) return null;
  if (!new oc.BRepCheck_Analyzer(solid).IsValid()) return null;
  const props = new oc.GProp_GProps();
  oc.BRepGProp.VolumeProperties(solid, props, false, false, false);
  if (props.Mass() < 0) solid = solid.Reversed();
  const generated = (shape: Shape, kind: "FACE" | "EDGE") =>
    fromList(oc, revol.Generated(shape)).flatMap((made) => subShapes(oc, made, kind));
  // Generated misses the flat faces a radial edge sweeps (caps and steps); each is the only face
  // through its edge's midpoint.
  const solidFaces = subShapes(oc, solid, "FACE");
  const faceOf = (edge: Shape) => {
    const made = generated(edge, "FACE");
    if (made.length) return made;
    const curve = new oc.BRepAdaptor_Curve(oc.TopoDS.Edge(edge));
    const middle = new oc.BRepBuilderAPI_MakeVertex(
      curve.Value((curve.FirstParameter() + curve.LastParameter()) / 2),
    ).Vertex();
    return solidFaces.filter((face) => distance(oc, middle, face) < TOLERANCE);
  };
  const names: { shape: Shape; name: TopologyName }[] = [];
  for (const side of sides)
    for (const shape of faceOf(side.edge))
      names.push({ shape, name: { ...naming, kind: "HOLE_FACE", name: side.name } });
  const solidVertices = subShapes(oc, solid, "VERTEX");
  placed.forEach((p, i) => {
    const name: TopologyName = { ...naming, kind: "HOLE_PROFILE", name: p.profile.name };
    if (p.profile.radius > TOLERANCE)
      for (const shape of generated(corners[i]!, "EDGE")) names.push({ shape, name });
    else {
      // A point profile (the tip) is the vertex on the axis.
      const point = along(axis, 0, p.t);
      const tipVertex = solidVertices.find(
        (v) =>
          Math.hypot(...xyz(oc.BRep_Tool.Pnt(oc.TopoDS.Vertex(v))).map((c, k) => c - point[k]!)) <
          TOLERANCE,
      );
      if (tipVertex) names.push({ shape: tipVertex, name });
    }
  });
  return { solid, names };
}

/**
 * Distance along `axis` to an up-to entity: where it crosses a planar face or a mate connector's XY
 * plane, or a vertex's plane square to the axis (as std's own up-to depth does).
 */
function endBoundDistance(call: BuiltinCall, oc: Oc, entity: Entity | undefined, axis: Axis) {
  if (!entity) return null;
  const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const crossing = (origin: Vec3, normal: Vec3) => {
    const across = dot(normal, axis.direction);
    if (Math.abs(across) < 1e-12) return null;
    return (
      dot(normal, [0, 1, 2].map((k) => origin[k]! - axis.origin[k]!) as unknown as Vec3) / across
    );
  };
  if (entity.frame) return crossing(entity.frame.origin, entity.frame.zAxis);
  if (entity.type === "FACE") {
    const surface = new oc.BRepAdaptor_Surface(oc.TopoDS.Face(entity.shape), true);
    if (String(surface.GetType()) !== "GeomAbs_Plane")
      return call.unsupported("opHole up to a non-planar face is not supported locally yet.");
    const plane = surface.Plane().Position();
    return crossing(xyz(plane.Location()), xyz(plane.Direction()));
  }
  if (entity.type === "VERTEX" || entity.bodyType === "POINT")
    return crossing(
      xyz(oc.BRep_Tool.Pnt(oc.TopoDS.Vertex(subShapes(oc, entity.shape, "VERTEX")[0]!))),
      axis.direction,
    );
  return call.unsupported(
    `opHole up to an ${entity.type.toLowerCase()} is not supported locally yet.`,
  );
}

/** The return value for one hole, in the raw form std's `opHole` wrapper converts. */
function holeResult(hits: readonly Hit[], placement: Extract<Placement, { ok: true }>): FsMap {
  // std: "the distance, along the axis from the first entrance of the intersected targets to the
  // termination entity". The hole ends at its last full-width profile: for an up-to hole that's the
  // bound plus std's offset, which hole.fs reads back as |holeDepth - offset - referenceRootEnd|
  // = first entrance.
  const entrances = hits.flatMap((hit) => hit.passages.map((passage) => passage.firstEntrance));
  const entrance = entrances.length ? Math.min(...entrances) : 0;
  const termination = placement.placed.findLast((p) => p.profile.radius > TOLERANCE)?.t ?? 0;
  return FsMap.fromEntries([
    ["success", true],
    ["holeDepth", termination - entrance],
    [
      "targetToDepthExtremes",
      FsMap.fromEntries(
        hits.map(({ target, passages: [first, ...rest] }) => [
          target.id,
          FsMap.fromEntries([
            ["firstEntrance", first!.firstEntrance],
            ["fullEntrance", first!.fullEntrance],
            ["firstExit", (rest.at(-1) ?? first)!.firstExit],
            ["fullExit", (rest.at(-1) ?? first)!.fullExit],
          ]),
        ]),
      ),
    ],
    [
      "positionReferenceInfo",
      FsMap.fromEntries(
        [...placement.roots].map(([reference, found]) => [
          reference,
          FsMap.fromEntries([
            ["referenceRootStart", found.start],
            ["referenceRootEnd", found.end],
            ...(found.target ? [["target", found.target.id] as const] : []),
          ]),
        ]),
      ),
    ],
  ]);
}

export const HOLE_BUILTINS = {
  /**
   * Builds one hole tool per axis and subtracts them from the targets (minus any excluded), keeping
   * them as solids when `keepTools` is set or when not subtracting. Hole faces and profile edges get
   * std's names for `qOpHoleFace` and `qOpHoleProfile`. A hole that can't be placed reports
   * `success : false`; the operation fails only when none can.
   */
  opHole: ([ctx, id, value], call) => {
    const { model, oc } = kernel(call, ctx);
    const definition = map(call, value, "definition");
    const field = (name: string) => definition.getField(name);
    if (untag(field("useSMDefinitionTopologyId")) === true)
      return call.unsupported("opHole on sheet metal is not supported locally yet.");
    const holeDefinition = map(call, field("holeDefinition"), "holeDefinition");
    const profiles = array(call, holeDefinition.getField("profiles"), "profiles").map((p, i) =>
      profileOf(call, p, i),
    );
    const faceNamesValue = holeDefinition.getField("faceNames");
    const faceNames =
      faceNamesValue === undefined
        ? []
        : array(call, faceNamesValue, "faceNames").map((name) => {
            const text = untag(name);
            return typeof text === "string" ? text : null;
          });
    const axes = array(call, field("axes"), "axes").map((value, i): Axis => {
      const line = map(call, value, `axes[${i}]`);
      const direction = normalized(
        vector(call, line.getField("direction"), 3, `axes[${i}].direction`),
      );
      return {
        origin: vector(call, line.getField("origin"), 3, `axes[${i}].origin`),
        direction,
        x: perpendicular(direction),
      };
    });
    const identityValues = field("identities");
    const identities =
      identityValues === undefined
        ? axes.map(() => null)
        : array(call, identityValues, "identities").map(
            (query) => resolve(call, model, oc, query)[0]?.id ?? null,
          );
    if (identities.length !== axes.length) return call.fail("opHole needs one identity per axis.");
    const solidBodies = (name: string) => {
      const query = field(name);
      if (query === undefined) return [];
      const ids = new Set(resolve(call, model, oc, query).map((entity) => entity.body));
      return [...ids]
        .map((bodyId) => model.geometry.entities.get(bodyId)!)
        .filter((body) => body.bodyType === "SOLID");
    };
    const targets = solidBodies("targets");
    const excluded = new Set(solidBodies("targetsToExcludeFromSubtraction").map((body) => body.id));
    const subtract = untag(field("subtractFromTargets")) !== false;
    const keepTools = !subtract || untag(field("keepTools")) === true;
    const endBounds = field("endBoundEntity");
    const endBound = endBounds === undefined ? undefined : resolve(call, model, oc, endBounds)[0];
    const radius = Math.max(...profiles.map((profile) => profile.radius));
    if (!(radius > TOLERANCE)) return regenError(call, "HOLE_TOOL_CONSTRUCTION_FAILED");

    // The cylinder only needs to reach past every target.
    const box = new oc.Bnd_Box();
    for (const target of targets) oc.BRepBndLib.Add(target.shape, box, false);
    const corners = box.IsVoid()
      ? []
      : [box.GetXMin(), box.GetXMax()].flatMap((x) =>
          [box.GetYMin(), box.GetYMax()].flatMap((y) =>
            [box.GetZMin(), box.GetZMax()].map((z): Vec3 => [x, y, z]),
          ),
        );

    const results: FsValue[] = [];
    const tools: { tool: Tool }[] = [];
    let firstError: string | null = null;
    axes.forEach((axis, i) => {
      const reach =
        1.5 *
          Math.max(0, ...corners.map((c) => Math.hypot(...c.map((v, k) => v - axis.origin[k]!)))) +
        radius +
        1e-3;
      const hits = targets.flatMap((target): Hit[] => {
        const found = passages(oc, target.shape, axis, radius, reach);
        return found.length ? [{ target, passages: found }] : [];
      });
      const placement = place(
        call,
        profiles,
        rootFinder(hits, () => endBoundDistance(call, oc, endBound, axis)),
      );
      const naming = { operation: idOf(id), identity: identities[i] ?? null };
      const tool = placement.ok ? buildTool(oc, axis, placement.placed, faceNames, naming) : null;
      if (!placement.ok || !tool) {
        firstError ??= placement.ok ? "HOLE_TOOL_CONSTRUCTION_FAILED" : placement.error;
        results.push(FsMap.fromEntries([["success", false]]));
        return;
      }
      tools.push({ tool });
      results.push(holeResult(hits, placement));
    });
    if (tools.length === 0) return regenError(call, firstError ?? "HOLE_NO_HITS");

    // Tools become bodies only when kept; otherwise they exist just for the subtraction.
    const named = tools.flatMap(({ tool }) => tool.names);
    if (keepTools) {
      model.geometry = addBodies(
        oc,
        model.geometry,
        tools.map(({ tool }) => ({
          shape: tool.solid,
          bodyType: "SOLID" as const,
          createdBy: idOf(id),
        })),
      ).state;
      for (const { shape, name } of named) nameTopology(oc, shape, name);
    }
    const cutTargets = subtract ? targets.filter((target) => !excluded.has(target.id)) : [];
    if (cutTargets.length === 0) return results;

    const cut = new oc.BRepAlgoAPI_Cut();
    cut.SetArguments(
      toList(
        oc,
        cutTargets.map((target) => target.shape),
      ),
    );
    cut.SetTools(
      toList(
        oc,
        tools.map(({ tool }) => tool.solid),
      ),
    );
    cut.Build(new oc.Message_ProgressRange());
    if (cut.HasErrors()) return regenError(call, "HOLE_CUT_FAIL");
    const history = historyOf(oc, cut);
    const solids = subShapes(oc, cut.Shape(), "SOLID").map((solid) =>
      requireValid(call, oc, solid, "HOLE_CUT_FAIL"),
    );
    model.geometry = replaceBodies(oc, model.geometry, {
      consumed: cutTargets.map((target) => target.id),
      keepIds: cutTargets.map((target) => target.id),
      results: solids.map((shape) => ({ shape, bodyType: "SOLID" as const })),
      history,
      createdBy: idOf(id),
    }).state;
    // Hole faces and profiles carry their names into the targets, except where they merged into a
    // target's own face (a cap lying on the part's top face is still the part's top face).
    const inResult = new ShapeSet<true>(oc);
    for (const solid of solids)
      for (const kind of ["FACE", "EDGE", "VERTEX"] as const)
        for (const shape of subShapes(oc, solid, kind)) inResult.set(shape, true);
    const fromTargets = new ShapeSet<true>(oc);
    for (const target of cutTargets)
      for (const kind of ["FACE", "EDGE", "VERTEX"] as const)
        for (const shape of subShapes(oc, target.shape, kind))
          for (const result of [shape, ...history.modified(shape)]) fromTargets.set(result, true);
    for (const { shape, name } of named) {
      const continued = new ShapeSet<true>(oc);
      for (const result of [shape, ...history.modified(shape)])
        if (inResult.has(result) && !fromTargets.has(result) && !continued.has(result)) {
          continued.set(result, true);
          nameTopology(oc, result, name);
        }
    }
    return results;
  },

  /** The hole attributes (`HoleAttribute`-tagged, as std's Hole feature sets them) on `entities`. */
  getHoleAttributes: ([ctx, value], call) => {
    const { model, oc } = kernel(call, ctx);
    const definition = map(call, value, "definition");
    const holeAttribute = stdType(call, "holeAttribute.fs", "HoleAttribute");
    const found = resolve(call, model, oc, definition.getField("entities")).flatMap((entity) =>
      entity.attributes
        .filter(
          (attribute) =>
            attribute.name === null &&
            attribute.value instanceof FsTagged &&
            attribute.value.tag === holeAttribute,
        )
        .map((attribute) => attribute.value),
    );
    return found.filter((v, i) => found.findIndex((other) => equals(other, v)) === i);
  },
} satisfies Partial<Record<StdBuiltinName, BuiltinImpl>>;
