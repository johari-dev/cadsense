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
  /** Picked by its own occurrence, not found under an assembly: kept whatever its route. */
  readonly named: boolean;
}

export const partName = (node: Pick<CadSnapshotNode, "name">) => node.name.replace(/ <\d+>$/, "");

/**
 * Candidate sheets for a selection. A part occurrence draws that part with its assembly-wide
 * quantity. An assembly occurrence offers every part under it that is not bought, counted once
 * across all the selected assemblies however they overlap; callers keep the named parts and the
 * ones `shopRoute` sends to them.
 */
export const resolveDrawingSheets = (
  manifest: CadSnapshotManifest,
  occurrenceIds: readonly string[],
): DrawingSheetEntry[] => {
  const nodes = new Map(manifest.nodes.map((node) => [node.id, node]));
  const children = new Map<string, CadSnapshotNode[]>();
  for (const node of manifest.nodes) {
    if (node.parentId === null) continue;
    const siblings = children.get(node.parentId);
    if (siblings) siblings.push(node);
    else children.set(node.parentId, [node]);
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
  // Part occurrences under the selected assemblies, each counted once even when the selection
  // names an assembly twice or one inside another.
  const named = new Map<string, CadSnapshotNode>();
  const grouped = new Map<string, CadSnapshotNode>();
  const examples = new Map<string, CadSnapshotNode>();
  for (const id of new Set(occurrenceIds)) {
    const node = nodes.get(id);
    if (!node) continue;
    if (node.kind === "part") {
      if (!node.suppressed && node.sourcePartKey) named.set(node.sourcePartKey, node);
      continue;
    }
    for (const part of partsUnder(id)) {
      if (isBoughtPart(partName(part))) continue;
      grouped.set(part.id, part);
      if (part.sourcePartKey && !examples.has(part.sourcePartKey))
        examples.set(part.sourcePartKey, part);
    }
  }
  const groupCounts = counts([...grouped.values()]);
  const entries = new Map<string, DrawingSheetEntry>();
  for (const geometryKey of new Set([...groupCounts.keys(), ...named.keys()])) {
    const asset = assets.get(geometryKey);
    const part = metadata.get(geometryKey);
    if (!asset || !part) continue;
    const example = named.get(geometryKey) ?? examples.get(geometryKey)!;
    const isNamed = named.has(geometryKey);
    entries.set(geometryKey, {
      geometryKey,
      sha256: asset.sha256,
      name: part.metadata?.name.replace(/ <\d+>$/, "") ?? partName(example),
      material: part.metadata?.material?.displayName ?? "",
      partId: part.source.partId,
      qty: isNamed ? (wholeAssembly.get(geometryKey) ?? 1) : groupCounts.get(geometryKey)!,
      triangles: asset.complexity?.triangles ?? 0,
      named: isNamed,
    });
  }
  return [...entries.values()].sort((a, b) => a.name.localeCompare(b.name));
};

// Bought parts never get a drawing. A part number always means bought: vendor and McMaster
// numbers, pack sizes, and vendor spacer naming ("x 2\" WD)", "Acetal"). A gearbox family is bought unless the
// name says it mounts one. Otherwise the last hardware or made-part word decides, the way names
// read: "Pillow Block Bearing" is a bearing, "Bearing Block" a block, "Motor Mount Plate" a plate.
// Shafts and tubes cut from vendor stock name neither, so they are made.
const PART_NUMBER =
  /\b(?:WCP|217|am|TTB|SDS|VEX)-\d{3,}|\bREV-\d{2}-\d{4}|\(\d+-pack\)|\bWD\)|\bacetal\b|\bNFS-|\borigin cube\b/i;
// McMaster numbers ("91251A540"), not alloy tempers ("6061T6") or year codes ("2024R1").
const MCMASTER =
  /(?:^|[\s_])(?!20\d\d|6061|6063|7075|5052|6082|3003)\d{4,5}[A-Z]\d{1,4}(?=[\s_]|$)/;
const GEARBOX_FAMILY = /\b(?:max|ultra|versa)planetary\b/i;
const MOUNTS = /\b(?:mounts?|brackets?|adapters?)\b/i;
const HARDWARE =
  "[SBF]HCS|\\w*bearings?|\\w*screws?|\\w*bolts?|\\w*nuts?|\\w*washers?|\\w*rivets?|motors?|falcon\\w*|kraken\\w*|neo\\w*|vortex|sprockets?|pulleys?|belts?|chains?|collars?|couplers?|encoders?|spark\\w*|talon\\w*|hubs?|gears?|gearbox(?:es)?|\\w*wheels?|battery|batteries|radio|roborio|limelight|pigeon\\w*|cancoder|mk\\d\\w*|bushings?|pinions?|clevis|power distribution|switch(?:es)?|breakers?|wires?|grommets?|inserts?|springs?|magnets?|tread|heat sinks?|shims?|signal light";
const MADE =
  "plates?|mounts?|brackets?|trays?|guards?|blocks?|tensioners?|holders?|retainers?|clamps?|housings?|cases?|covers?|guides?|arms?|spacers?|gussets?|bellypan";
const KEYWORD = new RegExp(
  `(?<!\\w)(?:(?<made>${MADE})|(?<hardware>${HARDWARE}))\\d*(?!\\w)`,
  "gi",
);

export const isBoughtPart = (name: string) => {
  // Underscores separate words in exported names ("Brass Insert_94459A230").
  const words = name.replace(/_/g, " ");
  if (PART_NUMBER.test(words) || MCMASTER.test(name)) return true;
  if (GEARBOX_FAMILY.test(words) && !MOUNTS.test(words)) return true;
  // Parentheses hold sizes and fits ("(#25, MAXSpline Bore)"), not what the part is.
  const last = [...words.replace(/\([^)]*\)/g, " ").matchAll(KEYWORD)].at(-1);
  return last?.groups?.hardware !== undefined;
};

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
  // The JSON is untrusted: anything not shaped like glTF bounds means no bounds.
  try {
    for (const mesh of json.meshes ?? [])
      for (const primitive of mesh.primitives ?? []) {
        const accessor = json.accessors?.[primitive.attributes?.POSITION ?? -1];
        if (!accessor?.min || !accessor.max) continue;
        for (let k = 0; k < 3; k++) {
          min[k] = Math.min(min[k]!, accessor.min[k]!);
          max[k] = Math.max(max[k]!, accessor.max[k]!);
        }
      }
  } catch {
    return null;
  }
  const extents = [max[0]! - min[0]!, max[1]! - min[1]!, max[2]! - min[2]!] as const;
  return extents.every((size) => Number.isFinite(size) && size >= 0) ? [...extents] : null;
};
