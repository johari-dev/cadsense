import {
  CadMeasureInput,
  CadViewError,
  type CadMeasureGeometryProvenance,
  type CadMeasurePointInput,
  type CadMeasureResult,
  type CadSnapshotManifest,
  type CadViewState,
} from "@cadsense/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  CAD_MESH_MAX_BYTES,
  CadMeshGeometryError,
  readCadMeshTriangles,
  transformCadMeshPoint,
  type CadMeshPoint,
} from "./CadMeshGeometry.ts";
import { CAD_DISTANCE_LIMITS, cadSurfaceDistance } from "./CadSurfaceDistance.ts";

const decode = Schema.decodeUnknownEffect(CadMeasureInput);
type UnknownReason = Extract<CadMeasureResult, { status: "unknown" }>["reason"];
const pointLimitations = [
  "Input points are caller-specified and are not verified surface locations.",
  "Part points are in the part's CAD coordinates before the occurrence transform. World points must already use the original assembled placement, never exploded display coordinates.",
  "Float64 arithmetic has no certified error bound and does not establish manufacturing tolerance.",
];
const surfaceLimitations = [
  "Unsigned minimum separation between tessellated triangle surfaces. This is not a signed solid clearance or penetration depth.",
  "Positive separation does not exclude one solid containing another. Zero separation does not distinguish contact from intersecting surfaces.",
  "Mesh approximation error is unknown. Float64 arithmetic has no certified error bound and does not establish manufacturing tolerance.",
];

/** Reads only the pinned snapshot. Display visibility, explosion, and camera never enter geometry. */
export const measureCad = Effect.fn("measureCad")(function* <E>(
  snapshot: CadSnapshotManifest,
  state: CadViewState,
  input: unknown,
  readAsset: (hash: string) => Effect.Effect<Uint8Array, E>,
) {
  const request = yield* decode(input).pipe(
    Effect.mapError(() => new CadViewError({ reason: "invalid-operation" })),
  );
  if (
    request.expectedRevision !== state.revision ||
    request.snapshotId !== snapshot.snapshotId ||
    state.snapshotId !== snapshot.snapshotId
  )
    return yield* new CadViewError({ reason: "revision-conflict" });
  const nodes = new Map(snapshot.nodes.map((node) => [node.id, node]));
  const assets = new Map(snapshot.assets.map((asset) => [asset.geometryKey, asset]));
  const parts = new Map(snapshot.parts.map((part) => [part.geometryKey, part]));
  const ids =
    request.mode === "surface-clearance"
      ? [request.fromOccurrenceId, request.toOccurrenceId]
      : [request.from, request.to].flatMap((point) =>
          point.space === "part" ? [point.occurrenceId] : [],
        );
  const geometry: (typeof CadMeasureGeometryProvenance.Type)[] = [...new Set(ids)].map(
    (occurrenceId) => {
      const geometryKey = nodes.get(occurrenceId)?.sourcePartKey ?? null;
      return {
        occurrenceId,
        geometryKey,
        assetSha256: geometryKey === null ? null : (assets.get(geometryKey)?.sha256 ?? null),
        tessellationProfile:
          geometryKey === null
            ? null
            : (parts.get(geometryKey)?.source.tessellationProfile ?? null),
      };
    },
  );
  const common = {
    snapshotId: snapshot.snapshotId,
    revision: state.revision,
    rootId: snapshot.rootId,
    microversionId: snapshot.root.microversionId,
    mode: request.mode,
    units: "meters" as const,
    coordinateConvention: "assembled-world-z-up" as const,
    placement: "original-assembled" as const,
    geometry,
    pointInputs: request.mode === "point-distance" ? ([request.from, request.to] as const) : null,
    accuracy: {
      source:
        request.mode === "point-distance"
          ? ("caller-specified-points" as const)
          : ("tessellated-triangle-surfaces" as const),
      numericMethod: "float64" as const,
      certifiedErrorBoundMeters: null,
      limitations: request.mode === "point-distance" ? pointLimitations : surfaceLimitations,
    },
  };
  const unknown = (reason: UnknownReason): CadMeasureResult => ({
    ...common,
    status: "unknown",
    reason,
    distanceMeters: null,
    closestPoints: null,
  });
  if (ids.some((id) => !nodes.has(id))) return unknown("missing-occurrence");
  if (
    ids.some((id) => {
      const node = nodes.get(id)!;
      return node.kind !== "part" || node.suppressed || node.sourcePartKey === null;
    })
  )
    return unknown("missing-geometry");
  if (request.mode === "point-distance") {
    const resolved = yield* Effect.try({
      try: () => {
        const world = (point: CadMeasurePointInput): CadMeshPoint =>
          point.space === "world"
            ? [...point.point]
            : transformCadMeshPoint([...point.point], nodes.get(point.occurrenceId)!.transform);
        const from = world(request.from),
          to = world(request.to);
        return {
          from,
          to,
          distance: Math.hypot(from[0] - to[0], from[1] - to[1], from[2] - to[2]),
        };
      },
      catch: () => "numeric-failure" as const,
    }).pipe(Effect.result);
    if (resolved._tag === "Failure" || !Number.isFinite(resolved.success.distance))
      return unknown("numeric-failure");
    return {
      ...common,
      status: "measured" as const,
      distanceMeters: resolved.success.distance,
      closestPoints: [resolved.success.from, resolved.success.to] as const,
    } satisfies CadMeasureResult;
  }
  const assetBytes = new Map<string, Uint8Array>();
  const load = Effect.fn("measureCad.load")(function* (id: string) {
    const node = nodes.get(id)!;
    const asset = assets.get(node.sourcePartKey!);
    if (!asset) return yield* Effect.fail("missing-geometry" as const);
    if (
      asset.byteLength > CAD_MESH_MAX_BYTES ||
      (asset.complexity &&
        (asset.complexity.triangles > CAD_DISTANCE_LIMITS.trianglesPerPart ||
          asset.complexity.nodeCount > 10_000 ||
          asset.complexity.decodedBytes > CAD_MESH_MAX_BYTES))
    )
      return yield* Effect.fail("budget-exceeded" as const);
    let bytes = assetBytes.get(asset.sha256);
    if (!bytes) {
      bytes = yield* readAsset(asset.sha256).pipe(
        Effect.mapError(() => "missing-geometry" as const),
      );
      assetBytes.set(asset.sha256, bytes);
    }
    return yield* Effect.try({
      try: () => readCadMeshTriangles(bytes, node.transform),
      catch: (error): UnknownReason =>
        error instanceof CadMeshGeometryError
          ? error.reason === "too-large"
            ? "budget-exceeded"
            : error.reason
          : "invalid-geometry",
    });
  });
  const result = yield* Effect.gen(function* () {
    const from = yield* load(request.fromOccurrenceId);
    const to =
      request.fromOccurrenceId === request.toOccurrenceId
        ? from
        : yield* load(request.toOccurrenceId);
    return yield* cadSurfaceDistance(from, to).pipe(
      Effect.mapError(() => "numeric-failure" as const),
    );
  }).pipe(Effect.result);
  if (result._tag === "Failure") return unknown(result.failure);
  if (result.success === null) return unknown("budget-exceeded");
  if (!Number.isFinite(result.success.distance)) return unknown("numeric-failure");
  return {
    ...common,
    status: "measured" as const,
    distanceMeters: result.success.distance,
    closestPoints: result.success.points,
  } satisfies CadMeasureResult;
});
