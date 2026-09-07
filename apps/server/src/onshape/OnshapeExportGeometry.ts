import type { CadSnapshotDraft } from "@cadsense/contracts";
import * as Schema from "effect/Schema";
import { CadGeometryError } from "../cad/CadGeometry.ts";

const ObjectValue = Schema.Record(Schema.String, Schema.Unknown);
const isObject = Schema.is(ObjectValue);
const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(ObjectValue));
const encodeJson = Schema.encodeSync(Schema.fromJsonString(ObjectValue));
const decodeObjects = Schema.decodeUnknownSync(Schema.Array(ObjectValue));
const decodeNumbers = Schema.decodeUnknownSync(
  Schema.Array(Schema.Number.check(Schema.isFinite())),
);
const decodeIds = Schema.decodeUnknownSync(Schema.Array(Schema.String));
const pathKey = (path: readonly string[]) => path.map((id) => `${id.length}:${id}`).join("");
const invalid = () => new CadGeometryError({ reason: "invalid-geometry" });
const isGeometryError = Schema.is(CadGeometryError);
const index = (value: unknown): number => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw invalid();
  return value;
};
const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const multiply = (a: readonly number[], b: readonly number[]) =>
  Array.from({ length: 16 }, (_, i) => {
    const row = i % 4,
      column = Math.floor(i / 4);
    return [0, 1, 2, 3].reduce((sum, k) => sum + a[k * 4 + row]! * b[column * 4 + k]!, 0);
  });
function nodeMatrix(node: Record<string, unknown>) {
  if (node.matrix !== undefined) {
    const matrix = decodeNumbers(node.matrix);
    if (matrix.length !== 16) throw invalid();
    return matrix;
  }
  const translation = decodeNumbers(node.translation ?? [0, 0, 0]);
  const rotation = decodeNumbers(node.rotation ?? [0, 0, 0, 1]);
  const scale = decodeNumbers(node.scale ?? [1, 1, 1]);
  if (translation.length !== 3 || rotation.length !== 4 || scale.length !== 3) throw invalid();
  const [x, y, z, w] = rotation as [number, number, number, number];
  const [sx, sy, sz] = scale as [number, number, number];
  return [
    (1 - 2 * (y * y + z * z)) * sx,
    2 * (x * y + z * w) * sx,
    2 * (x * z - y * w) * sx,
    0,
    2 * (x * y - z * w) * sy,
    (1 - 2 * (x * x + z * z)) * sy,
    2 * (y * z + x * w) * sy,
    0,
    2 * (x * z + y * w) * sz,
    2 * (y * z - x * w) * sz,
    (1 - 2 * (x * x + y * y)) * sz,
    0,
    translation[0]!,
    translation[1]!,
    translation[2]!,
    1,
  ];
}
const metadataIds = (node: Record<string, unknown>) => {
  const extension = isObject(node.extensions) ? node.extensions.PTC_onshape_metadata : undefined;
  if (!isObject(extension) || extension.id === undefined) return [];
  return typeof extension.id === "string" ? [extension.id] : decodeIds(extension.id);
};
const equalTransform = (columnMajor: readonly number[], rowMajor: readonly number[]) =>
  columnMajor.every((value, i) => {
    const expected = rowMajor[(i % 4) * 4 + Math.floor(i / 4)]!;
    return Math.abs(value - expected) <= 1e-5 * Math.max(1, Math.abs(expected));
  });

/** Read one validated bulk GLB and split only the resources each source part actually uses. */
export function readOnshapeExportGeometry(draft: CadSnapshotDraft, bytes: Uint8Array) {
  try {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (bytes.length < 20 || view.getUint32(0, true) !== 0x46546c67) throw invalid();
    const end = 20 + view.getUint32(12, true);
    const document = decodeJson(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(20, end)),
    );
    const bin = end + 8 <= bytes.length ? bytes.subarray(end + 8) : new Uint8Array();
    if (document.animations !== undefined || document.skins !== undefined) throw invalid();
    const nodes = decodeObjects(document.nodes ?? []);
    const scenes = decodeObjects(document.scenes ?? []);
    const scene = scenes[index(document.scene ?? 0)];
    if (!scene || !Array.isArray(scene.nodes)) throw invalid();
    const byPath = new Map(draft.nodes.map((node) => [pathKey(node.occurrencePath), node]));
    const parts = new Map(draft.parts.map((part) => [part.geometryKey, part]));
    const studioParts = new Map(draft.parts.map((part) => [part.source.partId, part.geometryKey]));
    const matched = new Set<string>();
    const roots = new Map<string, { node: number; stripTransform: boolean; name: string }>();
    const stack = scene.nodes.map((node: unknown) => ({
      node: index(node),
      matrix: identity,
      path: [] as readonly string[],
      ancestors: new Set<number>(),
    }));
    let visits = 0;
    while (stack.length > 0) {
      const frame = stack.pop()!;
      if (++visits > 100_000 || frame.ancestors.has(frame.node)) throw invalid();
      const node = nodes[frame.node];
      if (!node) throw invalid();
      const matrix = multiply(frame.matrix, nodeMatrix(node));
      const ids = metadataIds(node);
      let path = frame.path;
      if (draft.root.kind === "assembly") {
        const occurrence =
          ids.length === 0
            ? undefined
            : (byPath.get(pathKey([...frame.path, ...ids])) ?? byPath.get(pathKey(ids)));
        if (occurrence) {
          if (
            occurrence.suppressed ||
            matched.has(occurrence.id) ||
            !equalTransform(matrix, occurrence.transform)
          )
            throw invalid();
          matched.add(occurrence.id);
          path = occurrence.occurrencePath;
          if (occurrence.sourcePartKey !== null) {
            const part = parts.get(occurrence.sourcePartKey);
            if (!part) throw invalid();
            if (!roots.has(occurrence.sourcePartKey))
              roots.set(occurrence.sourcePartKey, {
                node: frame.node,
                stripTransform: true,
                name: occurrence.name,
              });
            // The subtree is in source-part coordinates. The manifest owns occurrence placement.
            continue;
          }
        }
      } else if (ids.length === 1) {
        const key = studioParts.get(ids[0]!);
        if (key !== undefined) {
          if (roots.has(key)) throw invalid();
          roots.set(key, {
            node: frame.node,
            stripTransform: false,
            name: typeof node.name === "string" ? node.name : "Part",
          });
          continue;
        }
      }
      // Every mesh must belong to an identified source part. Names are never an identity fallback.
      if (node.mesh !== undefined) throw invalid();
      const children = node.children ?? [];
      if (!Array.isArray(children)) throw invalid();
      for (const child of children)
        stack.push({
          node: index(child),
          matrix,
          path,
          ancestors: new Set([...frame.ancestors, frame.node]),
        });
    }
    if (draft.parts.some((part) => part.geometryRequired && !roots.has(part.geometryKey)))
      throw invalid();
    if (
      draft.root.kind === "assembly" &&
      draft.nodes.some(
        (node) => !node.suppressed && node.sourcePartKey !== null && !matched.has(node.id),
      )
    )
      throw invalid();

    const tables = new Map<string, readonly Readonly<Record<string, unknown>>[]>();
    const table = (name: string) => {
      let values = tables.get(name);
      if (!values) {
        values = decodeObjects(document[name] ?? []);
        tables.set(name, values);
      }
      return values;
    };
    const extract = (key: string) => {
      const root = roots.get(key);
      if (!root) throw invalid();
      const output: Record<string, unknown> = { asset: { version: "2.0" }, scene: 0 };
      if (document.extensionsUsed !== undefined) output.extensionsUsed = document.extensionsUsed;
      if (document.extensionsRequired !== undefined)
        output.extensionsRequired = document.extensionsRequired;
      const copied = new Map<string, Map<number, number>>();
      const chunks: Uint8Array[] = [];
      let binLength = 0;
      const copy = (name: string, value: unknown): number => {
        const original = index(value);
        let mapping = copied.get(name);
        if (!mapping) {
          mapping = new Map();
          copied.set(name, mapping);
        }
        const existing = mapping.get(original);
        if (existing !== undefined) return existing;
        const row = table(name)[original];
        if (!row) throw invalid();
        const values = output[name] ?? [];
        if (!Array.isArray(values)) throw invalid();
        output[name] = values;
        const result: Record<string, unknown> = { ...row };
        const mapped = values.length;
        values.push(result);
        mapping.set(original, mapped);
        if (name === "nodes") {
          if (row.skin !== undefined || row.weights !== undefined) throw invalid();
          if (row.mesh !== undefined) result.mesh = copy("meshes", row.mesh);
          if (row.children !== undefined) {
            if (!Array.isArray(row.children)) throw invalid();
            result.children = row.children.map((child: unknown) => copy("nodes", child));
          }
        } else if (name === "meshes") {
          if (!Array.isArray(row.primitives)) throw invalid();
          result.primitives = row.primitives.map((primitive: unknown) => {
            if (
              !isObject(primitive) ||
              !isObject(primitive.attributes) ||
              primitive.targets !== undefined
            )
              throw invalid();
            return {
              ...primitive,
              attributes: Object.fromEntries(
                Object.entries(primitive.attributes).map(([attribute, accessor]) => [
                  attribute,
                  copy("accessors", accessor),
                ]),
              ),
              ...(primitive.indices === undefined
                ? {}
                : { indices: copy("accessors", primitive.indices) }),
              ...(primitive.material === undefined
                ? {}
                : { material: copy("materials", primitive.material) }),
            };
          });
        } else if (name === "accessors") {
          if (row.bufferView !== undefined) result.bufferView = copy("bufferViews", row.bufferView);
          if (row.sparse !== undefined) {
            if (
              !isObject(row.sparse) ||
              !isObject(row.sparse.indices) ||
              !isObject(row.sparse.values)
            )
              throw invalid();
            result.sparse = {
              ...row.sparse,
              indices: {
                ...row.sparse.indices,
                bufferView: copy("bufferViews", row.sparse.indices.bufferView),
              },
              values: {
                ...row.sparse.values,
                bufferView: copy("bufferViews", row.sparse.values.bufferView),
              },
            };
          }
        } else if (name === "bufferViews") {
          if (row.buffer !== 0 || row.extensions !== undefined) throw invalid();
          const start = index(row.byteOffset ?? 0),
            size = index(row.byteLength);
          if (start + size > bin.length) throw invalid();
          result.buffer = 0;
          result.byteOffset = binLength;
          chunks.push(bin.subarray(start, start + size));
          binLength += Math.ceil(size / 4) * 4;
        } else if (name === "materials") {
          const textures = (value: unknown): unknown => {
            if (Array.isArray(value)) return value.map(textures);
            if (!isObject(value)) return value;
            return Object.fromEntries(
              Object.entries(value).map(([field, item]) => [
                field,
                field.endsWith("Texture") && isObject(item)
                  ? { ...item, index: copy("textures", item.index) }
                  : textures(item),
              ]),
            );
          };
          Object.assign(result, textures(row));
        } else if (name === "textures") {
          if (row.extensions !== undefined) throw invalid();
          if (row.source !== undefined) result.source = copy("images", row.source);
          if (row.sampler !== undefined) result.sampler = copy("samplers", row.sampler);
        } else if (name === "images" && row.bufferView !== undefined)
          result.bufferView = copy("bufferViews", row.bufferView);
        return mapped;
      };
      const rootIndex = copy("nodes", root.node);
      if (root.stripTransform) {
        const outputNodes = decodeObjects(output.nodes).map((node) => ({ ...node }));
        const result = outputNodes[rootIndex]!;
        for (const field of ["matrix", "rotation", "translation", "scale"]) delete result[field];
        output.nodes = outputNodes;
      }
      output.scenes = [{ nodes: [rootIndex] }];
      if (binLength > 0) output.buffers = [{ byteLength: binLength }];
      const json = new TextEncoder().encode(encodeJson(output));
      const jsonLength = Math.ceil(json.length / 4) * 4;
      const result = new Uint8Array(20 + jsonLength + (binLength > 0 ? 8 + binLength : 0));
      const header = new DataView(result.buffer);
      header.setUint32(0, 0x46546c67, true);
      header.setUint32(4, 2, true);
      header.setUint32(8, result.length, true);
      header.setUint32(12, jsonLength, true);
      header.setUint32(16, 0x4e4f534a, true);
      result.fill(0x20, 20, 20 + jsonLength);
      result.set(json, 20);
      if (binLength > 0) {
        header.setUint32(20 + jsonLength, binLength, true);
        header.setUint32(24 + jsonLength, 0x004e4942, true);
        let offset = 28 + jsonLength;
        for (const chunk of chunks) {
          result.set(chunk, offset);
          offset += Math.ceil(chunk.length / 4) * 4;
        }
      }
      return result;
    };
    return { extract };
  } catch (error) {
    if (isGeometryError(error)) throw error;
    throw invalid();
  }
}
