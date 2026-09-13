import {
  CadPartInfoInput,
  CadViewError,
  type CadPartInfoResult,
  type CadSnapshotManifest,
  type CadViewState,
} from "@cadsense/contracts";
import { indexCadSnapshot } from "@cadsense/shared/cadScene";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  CAD_MESH_MAX_BYTES,
  CadMeshGeometryError,
  readCadMeshTriangles,
} from "./CadMeshGeometry.ts";

const decodeInput = Schema.decodeUnknownEffect(CadPartInfoInput);
const invalid = () => new CadViewError({ reason: "invalid-operation" });
const text = (value: string | undefined) => value?.slice(0, 512) ?? null;

/** Read one occurrence against the caller's pinned revision. Display explosion and visibility
 * never alter the original assembled transform or mesh bounds. No source API calls are made.
 */
export const readCadPartInfo = Effect.fn("readCadPartInfo")(function* <E>(
  snapshot: CadSnapshotManifest,
  state: CadViewState,
  readAsset: (sha256: string) => Effect.Effect<Uint8Array, E>,
  rawInput: unknown,
): Effect.fn.Return<CadPartInfoResult, CadViewError> {
  const input = yield* decodeInput(rawInput).pipe(Effect.mapError(invalid));
  if (
    input.expectedRevision !== state.revision ||
    input.snapshotId !== state.snapshotId ||
    snapshot.snapshotId !== state.snapshotId ||
    snapshot.rootId !== state.rootId
  )
    return yield* new CadViewError({ reason: "revision-conflict" });
  const index = indexCadSnapshot(snapshot),
    node = index.nodes.get(input.occurrenceId);
  if (!node) return yield* invalid();
  const part =
    node.sourcePartKey === null
      ? undefined
      : snapshot.parts.find((part) => part.geometryKey === node.sourcePartKey);
  const metadata = part?.metadata;
  const material = metadata?.material;
  const properties = material?.properties ?? [];
  const materialSummary: CadPartInfoResult["material"] = material
    ? {
        status: "available",
        displayName: text(material.displayName),
        id: text(material.id),
        libraryName: text(material.libraryName),
        libraryReference: material.libraryReference
          ? {
              documentId: text(material.libraryReference.documentId),
              elementId: text(material.libraryReference.elementId),
              elementMicroversionId: text(material.libraryReference.elementMicroversionId),
              versionId: text(material.libraryReference.versionId),
            }
          : null,
        properties: properties.slice(0, 16).map((property) => ({
          name: text(property.name),
          displayName: text(property.displayName),
          units: text(property.units),
          value: text(property.value),
          category: text(property.category),
          description: text(property.description),
          type: text(property.type),
        })),
        propertyCount: properties.length,
        truncated:
          properties.length > 16 ||
          [
            material.displayName,
            material.id,
            material.libraryName,
            ...Object.values(material.libraryReference ?? {}),
            ...properties
              .slice(0, 16)
              .flatMap((property) => [
                property.name,
                property.displayName,
                property.units,
                property.value,
                property.category,
                property.description,
                property.type,
              ]),
          ].some((value) => value !== undefined && value.length > 512),
      }
    : { status: "unavailable", reason: metadata ? "not-in-metadata" : "not-in-snapshot" };
  const occurrences: string[] = [];
  let total = 0;
  let suppressedCount = 0;
  if (part)
    for (const candidate of snapshot.nodes) {
      if (candidate.sourcePartKey !== part.geometryKey) continue;
      total++;
      if (candidate.suppressed) suppressedCount++;
      if (occurrences.length < (input.repeatedOccurrenceLimit ?? 20))
        occurrences.push(candidate.id);
    }
  let geometry: CadPartInfoResult["geometry"] = {
    status: "unavailable",
    reason: node.suppressed ? "suppressed" : node.kind !== "part" ? "not-part" : "not-cached",
  };
  const asset = part && snapshot.assets.find((asset) => asset.geometryKey === part.geometryKey);
  if (!node.suppressed && node.kind === "part" && asset && asset.byteLength > CAD_MESH_MAX_BYTES) {
    geometry = { status: "unavailable", reason: "too-large" };
  } else if (!node.suppressed && node.kind === "part" && asset && part) {
    geometry = yield* readAsset(asset.sha256).pipe(
      Effect.mapError(() => "asset-unavailable" as const),
      Effect.flatMap((bytes) =>
        Effect.try({
          try: (): CadPartInfoResult["geometry"] => {
            const triangles = readCadMeshTriangles(bytes, node.transform);
            const min: [number, number, number] = [Infinity, Infinity, Infinity],
              max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
            for (const triangle of triangles)
              for (const point of triangle)
                for (const axis of [0, 1, 2] as const) {
                  min[axis] = Math.min(min[axis], point[axis]);
                  max[axis] = Math.max(max[axis], point[axis]);
                }
            const dimensions: [number, number, number] = [
              max[0] - min[0],
              max[1] - min[1],
              max[2] - min[2],
            ];
            if (dimensions.some((value) => !Number.isFinite(value)))
              throw new CadMeshGeometryError("invalid-geometry");
            return {
              status: "available",
              units: "meters",
              coordinateFrame: "assembled-world",
              upAxis: "Z",
              approximation: "tessellated-mesh",
              boundsKind: "axis-aligned",
              min,
              max,
              dimensions,
              triangleCount: triangles.length,
              assetSha256: asset.sha256,
              tessellationProfile: part.source.tessellationProfile,
            };
          },
          catch: (error) =>
            error instanceof CadMeshGeometryError ? error.reason : ("invalid-geometry" as const),
        }),
      ),
      Effect.catch((reason) => Effect.succeed({ status: "unavailable" as const, reason })),
    );
  }
  return {
    rootId: snapshot.rootId,
    snapshotId: snapshot.snapshotId,
    revision: state.revision,
    occurrence: {
      occurrenceId: node.id,
      parentOccurrenceId: node.parentId,
      name: node.name,
      kind: node.kind,
      instanceId: node.instanceId,
      occurrencePath: node.occurrencePath,
      suppressed: node.suppressed,
      visible: index.visible(state).get(node.id) ?? false,
    },
    assembledTransform: node.suppressed
      ? { status: "unavailable", reason: "suppressed" }
      : {
          status: "available",
          matrix: node.transform,
          storage: "row-major",
          from: "source-node",
          to: "assembled-world",
          translationUnits: "meters",
          upAxis: "Z",
        },
    source: part ? { sourcePartKey: part.geometryKey, ...part.source } : null,
    metadata: metadata
      ? {
          name: metadata.name,
          bodyType: metadata.bodyType,
          isMesh: metadata.isMesh,
          isHidden: metadata.isHidden,
          partIdentity: metadata.partIdentity,
          configurationId: metadata.configurationId,
          appearance: metadata.appearance,
        }
      : null,
    material: materialSummary,
    repeatedOccurrences: {
      match: "source-part-key",
      occurrenceIds: occurrences,
      total,
      suppressedCount,
      truncated: occurrences.length < total,
    },
    geometry,
  };
});
