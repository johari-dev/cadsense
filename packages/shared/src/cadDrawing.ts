// Which parts get a shop drawing, shared by the web drawing panel and the agent's
// cad_part_drawing tool so both count the same sheets and skip the same parts.
import type { CadSnapshotManifest, CadSnapshotNode } from "@cadsense/contracts";

/** One sheet: a distinct part mesh and how many of it the selection uses. */
export interface DrawingSheetEntry {
  readonly geometryKey: string;
  readonly sha256: string;
  readonly name: string;
  readonly material: string;
  readonly partId: string;
  /** Instances inside the selection (the whole assembly for a single part). */
  readonly qty: number;
  readonly triangles: number;
}

export const partName = (node: Pick<CadSnapshotNode, "name">) => node.name.replace(/ <\d+>$/, "");

/**
 * Candidate sheets for a selection. A part occurrence draws that part with its assembly-wide
 * quantity. An assembly occurrence offers every part under it that is not bought, counted inside
 * the assembly; callers keep the ones `shopRoute` sends to a drawing.
 */
export const resolveDrawingSheets = (
  manifest: CadSnapshotManifest,
  occurrenceIds: readonly string[],
): DrawingSheetEntry[] => {
  const nodes = new Map(manifest.nodes.map((node) => [node.id, node]));
  const children = new Map<string, CadSnapshotNode[]>();
  for (const node of manifest.nodes) {
    if (node.parentId === null) continue;
    children.set(node.parentId, [...(children.get(node.parentId) ?? []), node]);
  }
  const partsUnder = (id: string): CadSnapshotNode[] => {
    const node = nodes.get(id);
    if (!node || node.suppressed) return [];
    if (node.kind === "part") return [node];
    return (children.get(id) ?? []).flatMap((child) => partsUnder(child.id));
  };
  const counts = (parts: readonly CadSnapshotNode[]) => {
    const result = new Map<string, number>();
    for (const part of parts) {
      if (part.sourcePartKey)
        result.set(part.sourcePartKey, (result.get(part.sourcePartKey) ?? 0) + 1);
    }
    return result;
  };
  const wholeAssembly = counts(
    manifest.nodes.filter((node) => node.kind === "part" && !node.suppressed),
  );
  const assets = new Map(manifest.assets.map((asset) => [asset.geometryKey, asset]));
  const metadata = new Map(manifest.parts.map((part) => [part.geometryKey, part]));
  const entries = new Map<string, DrawingSheetEntry>();
  for (const id of occurrenceIds) {
    const node = nodes.get(id);
    if (!node) continue;
    const single = node.kind === "part";
    const parts = partsUnder(id).filter((part) => single || !isBoughtPart(partName(part)));
    for (const [geometryKey, qty] of counts(parts)) {
      const asset = assets.get(geometryKey);
      const part = metadata.get(geometryKey);
      if (!asset || !part) continue;
      const example = parts.find((candidate) => candidate.sourcePartKey === geometryKey)!;
      const existing = entries.get(geometryKey);
      entries.set(geometryKey, {
        geometryKey,
        sha256: asset.sha256,
        name: part.metadata?.name.replace(/ <\d+>$/, "") ?? partName(example),
        material: part.metadata?.material?.displayName ?? "",
        partId: part.source.partId,
        qty: single ? (wholeAssembly.get(geometryKey) ?? qty) : (existing?.qty ?? 0) + qty,
        triangles: asset.complexity?.triangles ?? 0,
      });
    }
  }
  return [...entries.values()].sort((a, b) => a.name.localeCompare(b.name));
};

// Bought parts never get a drawing: vendor part numbers, pack sizes, vendor spacer naming
// ("x 2\" WD)"), and common hardware. Shafts and tubes cut from vendor stock are not listed.
const BOUGHT_PART =
  /\b(WCP|217|am|REV|TTB|SDS|VEX)-\d|\(\d+-pack\)|\bWD\)|\bacetal\b|\b[SBF]HCS\b|NFS-|origin cube|bearing|screw|bolt|nut\b|washer|rivet|motor|falcon|kraken|neo\b|vortex|maxplanetary|sprocket|pulley|belt|chain|collar|coupler|encoder|spark|talon|hub\b|gear|wheel|battery|radio|roborio|limelight|pigeon|cancoder|mk4|bushing|pinion|clevis|power distribution/i;

export const isBoughtPart = (name: string) => BOUGHT_PART.test(name);

/**
 * Where a made part goes in the shop. Tubing, shafts, and other stock parts get a drawing;
 * plates are cut on the router from a DXF; printed parts are sliced from the model.
 */
export type ShopRoute = "drawing" | "cnc" | "print";

const INCH = 0.0254;

/** `extents` are the part's own bounding-box sizes in meters, any order. */
export const shopRoute = (material: string, extents: readonly number[] | null): ShopRoute => {
  if (/3d print|pla\b|petg|onyx|nylon|tpu/i.test(material)) return "print";
  if (!extents) return "drawing";
  const [thin, middle] = [...extents].sort((a, b) => a - b);
  return thin! <= 0.5 * INCH && thin! <= 0.25 * middle! ? "cnc" : "drawing";
};

/**
 * Part-space bounding box sizes from a GLB's POSITION accessors, read from the JSON chunk only.
 * Null when the file is not a GLB or carries no bounds.
 */
export const glbExtents = (bytes: Uint8Array): [number, number, number] | null => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength < 20 || view.getUint32(0, true) !== 0x46546c67) return null;
  const length = view.getUint32(12, true);
  let json: {
    meshes?: { primitives?: { attributes?: { POSITION?: number } }[] }[];
    accessors?: { min?: number[]; max?: number[] }[];
  };
  try {
    json = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + length)));
  } catch {
    return null;
  }
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const mesh of json.meshes ?? [])
    for (const primitive of mesh.primitives ?? []) {
      const accessor = json.accessors?.[primitive.attributes?.POSITION ?? -1];
      if (!accessor?.min || !accessor.max) continue;
      for (let k = 0; k < 3; k++) {
        min[k] = Math.min(min[k]!, accessor.min[k]!);
        max[k] = Math.max(max[k]!, accessor.max[k]!);
      }
    }
  if (!Number.isFinite(min[0]!)) return null;
  return [max[0]! - min[0]!, max[1]! - min[1]!, max[2]! - min[2]!];
};
