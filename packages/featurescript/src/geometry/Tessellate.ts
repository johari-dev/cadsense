import { ordered, topology, type Entity, type GeometryState } from "./Model.ts";
import { subShapes, type Oc, type Shape } from "./occt.ts";

/** 0 is the plain material, 1 the highlight (the feature's faces), 2 errors (`setErrorEntities`). */
export type MeshMaterial = 0 | 1 | 2;

/** A point in meters. */
export type Point = readonly [number, number, number];

/**
 * Triangles of one body split by material, in meters. Each face's vertices appear once, shared by
 * its triangles through `indices`, with normals smoothed within the face and not across its edges.
 */
export interface BodyMesh {
  readonly bodyId: string;
  readonly name: string;
  /** Material index to triangle data. */
  readonly groups: readonly {
    readonly material: MeshMaterial;
    readonly positions: Float32Array;
    readonly normals: Float32Array;
    /** Three vertex indices per triangle, wound counterclockwise seen from outside. */
    readonly indices: Uint32Array;
    /** The face each vertex is on, by its index in the body's faces (see `probes`). */
    readonly faces: Float32Array;
  }[];
  /**
   * A drawn body's faces' probes, in the order the groups' `faces` number them: a point inside the
   * face, on its true surface and away from its edges, so the face is the one nearest it (null for
   * a face with no triangles). The drawn triangles sit on chords up to the deflection inside a
   * curved face, where a point by an edge can be nearer the next face.
   */
  readonly probes?: readonly (Point | null)[];
  /** Error edges as line segments, two points (six numbers) each, in the error material. */
  readonly edges?: Float32Array;
  /** Error vertices as points, three numbers each, in the error material. */
  readonly vertices?: Float32Array;
  /** Drawn over the model (error entities that aren't in it), not part of it: nothing to pick. */
  readonly overlay?: true;
  /**
   * A drawn body's B-rep edges as line segments (six numbers each) through the nodes its faces'
   * triangles have on them, and its vertices as points: what a viewer outlines the body with and
   * snaps clicks to. Every edge, tangent ones too, as Onshape draws them; seams aren't edges. The
   * error overlay's has the edges of the faces it draws, and no vertices.
   */
  readonly outline?: {
    readonly edges: Float32Array;
    /** The edge each segment end draws, by its index in `midpoints`. */
    readonly edgeOf: Float32Array;
    /** Each edge's middle (by parameter), on its true curve rather than a chord. */
    readonly midpoints: readonly Point[];
    readonly vertices: Float32Array;
  };
}

export interface TessellateOptions {
  /** Faces drawn in the highlight material, e.g. the ones the previewed feature created. */
  readonly highlight?: (face: Entity) => boolean;
  /** Faces drawn in the error material; it wins over the highlight. */
  readonly error?: (face: Entity) => boolean;
  /** Linear deflection in meters. Default 0.05 mm. */
  readonly deflection?: number;
}

/** The mesher's default linear deflection: 0.05 mm. */
const DEFLECTION = 5e-5;

/**
 * Whether a preview draws `body`: solids and sheets. Wire and point bodies have no faces to draw,
 * and sketch regions and construction planes aren't drawn as surfaces (they'd hide what's under
 * them).
 */
export const isDrawnBody = (state: GeometryState, body: Entity): boolean =>
  body.type === "BODY" &&
  !body.construction &&
  (body.bodyType === "SOLID" ||
    (body.bodyType === "SHEET" &&
      !ordered(state, (entity) => entity.body === body.id && entity.type === "FACE").every(
        (face) => face.sketch !== null,
      )));

/** One material's growing share of a body's mesh. */
interface Bucket {
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
  faces: Float32Array;
  vertices: number;
  triangles: number;
}
const bucket = (): Bucket => ({
  positions: new Float32Array(0),
  normals: new Float32Array(0),
  indices: new Uint32Array(0),
  faces: new Float32Array(0),
  vertices: 0,
  triangles: 0,
});
/** `array` with room for `length` entries, doubled when it grows, keeping its contents. */
function room<T extends Float32Array | Uint32Array>(array: T, length: number): T {
  if (array.length >= length) return array;
  const grown = new (array.constructor as new (length: number) => T)(
    Math.max(length, array.length * 2),
  );
  grown.set(array);
  return grown;
}

/** Meshes `shape` (a body or a face) so its faces have triangulations to read. */
const mesh = (oc: Oc, shape: Shape, deflection: number) =>
  new oc.BRepMesh_IncrementalMesh(shape, deflection, false, 0.35, false).delete();

/** The triangle groups of `buckets`, by material, leaving out empty ones. */
const groupsOf = (buckets: readonly Bucket[]): BodyMesh["groups"] =>
  buckets.flatMap((group, material) =>
    group.triangles > 0
      ? [
          {
            material: material as MeshMaterial,
            positions: group.positions.slice(0, group.vertices * 3),
            normals: group.normals.slice(0, group.vertices * 3),
            indices: group.indices.slice(0, group.triangles * 3),
            faces: group.faces.slice(0, group.vertices),
          },
        ]
      : [],
  );

/**
 * Meshes every body {@link isDrawnBody} accepts. OpenCascade objects made per vertex and triangle
 * are freed as soon as they're read, so meshing doesn't grow the WASM heap by the triangle count.
 */
export function tessellate(
  oc: Oc,
  state: GeometryState,
  options: TessellateOptions = {},
): BodyMesh[] {
  const deflection = options.deflection ?? DEFLECTION;
  return ordered(state, (body) => isDrawnBody(state, body)).map((body) => {
    mesh(oc, body.shape, deflection);
    const placed = placements(oc);
    try {
      const buckets: [Bucket, Bucket, Bucket] = [bucket(), bucket(), bucket()];
      const probes = ordered(
        state,
        (entity) => entity.body === body.id && entity.type === "FACE",
      ).map((face, i) =>
        appendFace(
          oc,
          face.shape,
          buckets[options.error?.(face) ? 2 : options.highlight?.(face) ? 1 : 0],
          placed,
          i,
        ),
      );
      return {
        bodyId: body.id,
        name: `${body.createdBy.join(".")} (${body.id})`,
        groups: groupsOf(buckets),
        probes,
        outline: outlineOf(oc, state, body, placed),
      };
    } finally {
      placed.delete();
    }
  });
}

/** A meshed body's {@link BodyMesh.outline}, from its EDGE and VERTEX entities. */
function outlineOf(
  oc: Oc,
  state: GeometryState,
  body: Entity,
  placed: Placements,
): NonNullable<BodyMesh["outline"]> {
  const outline = outlineOfEdges(
    oc,
    ordered(state, (entity) => entity.body === body.id && entity.type === "EDGE").map(
      (edge) => edge.shape,
    ),
    placed,
  );
  const vertices = ordered(
    state,
    (entity) => entity.body === body.id && entity.type === "VERTEX",
  ).flatMap((vertex) => pointOf(oc, vertex.shape));
  return { ...outline, vertices: new Float32Array(vertices) };
}

/** The outline of `edges` of meshed faces: their segments, which edge each draws, their middles. */
function outlineOfEdges(oc: Oc, edges: readonly Shape[], placed: Placements) {
  const segments: number[] = [];
  const edgeOf: number[] = [];
  const midpoints = edges.map((edge, i) => {
    const drawn = meshedSegments(oc, edge, placed);
    segments.push(...drawn);
    for (let end = 0; end < drawn.length / 3; end++) edgeOf.push(i);
    return middleOf(oc, edge);
  });
  return { edges: new Float32Array(segments), edgeOf: new Float32Array(edgeOf), midpoints };
}

/**
 * Error entities a body mesh doesn't already show (see {@link TessellateOptions.error}), as one
 * extra mesh, all in the error material: faces and bodies (a rolled-back one, say) as triangles,
 * outlined by their edges as a body is, edges as segments and vertices as points. A body with no
 * faces is drawn by its edges (a wire), or else its vertices (a point or mate connector). `drawn`
 * counts the entities that gave something to draw; `mesh` is null when none did.
 */
export function errorOverlay(
  oc: Oc,
  entities: readonly Entity[],
  shown: (entity: Entity) => boolean,
  deflection = DEFLECTION,
): { readonly mesh: BodyMesh | null; readonly drawn: number } {
  const faces = bucket();
  let faceCount = 0;
  const outlined: Shape[] = [];
  const edges: number[] = [];
  const vertices: number[] = [];
  let drawn = 0;
  const addVertex = (vertex: Shape) => vertices.push(...pointOf(oc, vertex));
  const placed = placements(oc);
  for (const entity of entities) {
    if (shown(entity)) continue;
    const before = faces.triangles + edges.length + vertices.length;
    const bodyFaces =
      entity.type === "FACE" || entity.type === "BODY" ? subShapes(oc, entity.shape, "FACE") : [];
    if (bodyFaces.length > 0) {
      mesh(oc, entity.shape, deflection);
      for (const face of bodyFaces) appendFace(oc, face, faces, placed, faceCount++);
      outlined.push(...topology(oc, entity.shape).edges);
    } else if (entity.type === "EDGE") edges.push(...segments(oc, entity.shape));
    else if (entity.type === "VERTEX") addVertex(entity.shape);
    else if (entity.type === "BODY") {
      const bodyEdges = subShapes(oc, entity.shape, "EDGE");
      for (const edge of bodyEdges) edges.push(...segments(oc, edge));
      if (bodyEdges.length === 0)
        for (const vertex of subShapes(oc, entity.shape, "VERTEX")) addVertex(vertex);
    }
    if (faces.triangles + edges.length + vertices.length > before) drawn++;
  }
  const outline = { ...outlineOfEdges(oc, outlined, placed), vertices: new Float32Array(0) };
  placed.delete();
  if (drawn === 0) return { mesh: null, drawn };
  return {
    mesh: {
      bodyId: "errors",
      name: "Error entities",
      overlay: true,
      groups: groupsOf([bucket(), bucket(), faces]),
      outline,
      ...(edges.length ? { edges: new Float32Array(edges) } : {}),
      ...(vertices.length ? { vertices: new Float32Array(vertices) } : {}),
    },
    drawn,
  };
}

/** An edge's middle by parameter, on its curve. */
function middleOf(oc: Oc, edge: Shape): Point {
  const curve = new oc.BRepAdaptor_Curve(oc.TopoDS.Edge(edge));
  const point = curve.EvalD0((curve.FirstParameter() + curve.LastParameter()) / 2);
  const xyz: Point = [point.X(), point.Y(), point.Z()];
  point.delete();
  curve.delete();
  return xyz;
}

/** Where a vertex is. */
function pointOf(oc: Oc, vertex: Shape): [number, number, number] {
  const point = oc.BRep_Tool.Pnt(oc.TopoDS.Vertex(vertex));
  const xyz: [number, number, number] = [point.X(), point.Y(), point.Z()];
  point.delete();
  return xyz;
}

/**
 * Segments along an edge of a meshed face, through the nodes the face's triangulation has on it,
 * so they lie on the drawn triangles; {@link segments} if no triangulation has the edge.
 */
function meshedSegments(oc: Oc, edge: Shape, placed: Placements): number[] {
  const location = new oc.TopLoc_Location();
  const topoEdge = oc.TopoDS.Edge(edge);
  const found = oc.BRep_Tool.PolygonOnTriangulation(topoEdge, location);
  topoEdge.delete();
  // Plain null when no triangulation has the edge, though the binding's types don't say so.
  const polygon: InstanceType<Oc["Poly_PolygonOnTriangulation"]> | null = found.P;
  const triangulation: InstanceType<Oc["Poly_Triangulation"]> | null = found.T;
  if (polygon === null || triangulation === null || polygon.isNull() || triangulation.isNull()) {
    polygon?.delete();
    triangulation?.delete();
    location.delete();
    return segments(oc, edge);
  }
  const matrix = placed.matrixOf(location);
  location.delete();
  const points = Array.from({ length: polygon.NbNodes() }, (_, i) => {
    const node = triangulation.Node(polygon.Node(i + 1));
    const [x, y, z] = [node.X(), node.Y(), node.Z()];
    node.delete();
    return matrix
      ? [
          matrix[0]! * x + matrix[1]! * y + matrix[2]! * z + matrix[3]!,
          matrix[4]! * x + matrix[5]! * y + matrix[6]! * z + matrix[7]!,
          matrix[8]! * x + matrix[9]! * y + matrix[10]! * z + matrix[11]!,
        ]
      : [x, y, z];
  });
  polygon.delete();
  triangulation.delete();
  return points.slice(1).flatMap((point, i) => [...points[i]!, ...point]);
}

type Location = InstanceType<Oc["TopLoc_Location"]>;

/**
 * The matrices of the locations one body's faces and edges are placed at, each read once. A body
 * has one or a few (a STEP assembly part's placement), kept as copies `delete` frees.
 */
function placements(oc: Oc) {
  const seen: { readonly location: Location; readonly matrix: number[] }[] = [];
  return {
    /** `location`'s 3x4 matrix, row by row; null when it doesn't move anything. */
    matrixOf(location: Location): number[] | null {
      if (location.IsIdentity()) return null;
      const known = seen.find((entry) => entry.location.IsEqual(location));
      if (known) return known.matrix;
      // Transformation() returns a copy, which nothing else frees.
      const transform = location.Transformation();
      const matrix = [1, 2, 3].flatMap((row) =>
        [1, 2, 3, 4].map((column) => transform.Value(row, column)),
      );
      transform.delete();
      seen.push({ location: new oc.TopLoc_Location(location), matrix });
      return matrix;
    },
    delete() {
      for (const { location } of seen.splice(0)) location.delete();
    },
  };
}
type Placements = ReturnType<typeof placements>;

/** Segments along an edge: one for a line, otherwise 64 of equal parameter length. */
function segments(oc: Oc, edge: Shape): number[] {
  const curve = new oc.BRepAdaptor_Curve(oc.TopoDS.Edge(edge));
  const [first, last] = [curve.FirstParameter(), curve.LastParameter()];
  const count = String(curve.GetType()) === "GeomAbs_Line" ? 1 : 64;
  const points = Array.from({ length: count + 1 }, (_, i) => {
    const point = curve.EvalD0(first + ((last - first) * i) / count);
    const xyz = [point.X(), point.Y(), point.Z()];
    point.delete();
    return xyz;
  });
  curve.delete();
  return points.slice(1).flatMap((point, i) => [...points[i]!, ...point]);
}

/**
 * Appends one meshed face's triangles to `target`, placed by its location, wound outward, its
 * vertices marked as face number `face`. Returns its probe (see {@link BodyMesh.probes}), or null
 * when it has no triangles.
 */
function appendFace(
  oc: Oc,
  faceShape: Shape,
  target: Bucket,
  placed: Placements,
  face: number,
): Point | null {
  const location = new oc.TopLoc_Location();
  const topoFace = oc.TopoDS.Face(faceShape);
  // Plain null when the face has none (one the mesher couldn't mesh, a sliver say), though the
  // binding's types don't say so.
  const triangulation: InstanceType<Oc["Poly_Triangulation"]> | null = oc.BRep_Tool.Triangulation(
    topoFace,
    location,
    0,
  );
  if (triangulation === null || triangulation.isNull()) {
    triangulation?.delete();
    topoFace.delete();
    location.delete();
    return null;
  }
  const matrix = placed.matrixOf(location);
  location.delete();
  const reversed = String(faceShape.Orientation()) === "TopAbs_REVERSED";
  const nodes = triangulation.NbNodes();
  const count = triangulation.NbTriangles();
  const first = target.vertices;
  target.positions = room(target.positions, (first + nodes) * 3);
  target.normals = room(target.normals, (first + nodes) * 3);
  target.indices = room(target.indices, (target.triangles + count) * 3);
  target.faces = room(target.faces, first + nodes);
  target.faces.fill(face, first, first + nodes);
  const { positions, normals, indices } = target;
  // The triangle whose middle is furthest from its sides, and so from the face's edges: twice its
  // area over its longest side, which is three times that distance.
  let best: { readonly score: number; readonly corners: readonly number[] } | null = null;
  for (let i = 0; i < nodes; i++) {
    const node = triangulation.Node(i + 1);
    const [x, y, z] = [node.X(), node.Y(), node.Z()];
    node.delete();
    const o = (first + i) * 3;
    if (matrix) {
      const m = matrix;
      positions[o] = m[0]! * x + m[1]! * y + m[2]! * z + m[3]!;
      positions[o + 1] = m[4]! * x + m[5]! * y + m[6]! * z + m[7]!;
      positions[o + 2] = m[8]! * x + m[9]! * y + m[10]! * z + m[11]!;
    } else {
      positions[o] = x;
      positions[o + 1] = y;
      positions[o + 2] = z;
    }
    normals[o] = normals[o + 1] = normals[o + 2] = 0;
  }
  for (let t = 0; t < count; t++) {
    const triangle = triangulation.Triangle(t + 1);
    // A reversed face's triangles are wound against its outward side.
    const a = first + triangle.Value(1) - 1;
    const b = first + triangle.Value(reversed ? 3 : 2) - 1;
    const c = first + triangle.Value(reversed ? 2 : 3) - 1;
    triangle.delete();
    const o = (target.triangles + t) * 3;
    indices[o] = a;
    indices[o + 1] = b;
    indices[o + 2] = c;
    // Each corner gathers the triangle's area-weighted normal; normalized below.
    const ux = positions[b * 3]! - positions[a * 3]!;
    const uy = positions[b * 3 + 1]! - positions[a * 3 + 1]!;
    const uz = positions[b * 3 + 2]! - positions[a * 3 + 2]!;
    const vx = positions[c * 3]! - positions[a * 3]!;
    const vy = positions[c * 3 + 1]! - positions[a * 3 + 1]!;
    const vz = positions[c * 3 + 2]! - positions[a * 3 + 2]!;
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    const longest = Math.max(
      ux * ux + uy * uy + uz * uz,
      vx * vx + vy * vy + vz * vz,
      (vx - ux) ** 2 + (vy - uy) ** 2 + (vz - uz) ** 2,
    );
    const score = Math.hypot(nx, ny, nz) / Math.sqrt(longest);
    if (score > (best?.score ?? 0)) best = { score, corners: [a, b, c] };
    for (const corner of [a, b, c]) {
      normals[corner * 3] = normals[corner * 3]! + nx;
      normals[corner * 3 + 1] = normals[corner * 3 + 1]! + ny;
      normals[corner * 3 + 2] = normals[corner * 3 + 2]! + nz;
    }
  }
  const probe =
    best === null ? null : probeOf(oc, topoFace, triangulation, best.corners, first, positions);
  triangulation.delete();
  topoFace.delete();
  for (let i = first; i < first + nodes; i++) {
    const o = i * 3;
    const length = Math.hypot(normals[o]!, normals[o + 1]!, normals[o + 2]!) || 1;
    normals[o] = normals[o]! / length;
    normals[o + 1] = normals[o + 1]! / length;
    normals[o + 2] = normals[o + 2]! / length;
  }
  target.vertices += nodes;
  target.triangles += count;
  return probe;
}

/**
 * A face's probe: the middle of one of its triangles (`corners`, as `target` numbers them from
 * `first`), on the true surface through the triangle's surface parameters, or on the chord when
 * the triangulation has none.
 */
function probeOf(
  oc: Oc,
  face: InstanceType<Oc["TopoDS_Face"]>,
  triangulation: InstanceType<Oc["Poly_Triangulation"]>,
  corners: readonly number[],
  first: number,
  positions: Float32Array,
): Point {
  if (!triangulation.HasUVNodes()) {
    const middle = (k: number) =>
      corners.reduce((sum, corner) => sum + positions[corner * 3 + k]!, 0) / 3;
    return [middle(0), middle(1), middle(2)];
  }
  let [u, v] = [0, 0];
  for (const corner of corners) {
    const uv = triangulation.UVNode(corner - first + 1);
    u += uv.X() / 3;
    v += uv.Y() / 3;
    uv.delete();
  }
  // Placed by the face's location, as the triangles are.
  const surface = new oc.BRepAdaptor_Surface(face, true);
  const point = surface.EvalD0(u, v);
  const xyz: Point = [point.X(), point.Y(), point.Z()];
  point.delete();
  surface.delete();
  return xyz;
}
