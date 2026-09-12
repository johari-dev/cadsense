import * as Schema from "effect/Schema";
import { SaxesParser, type SaxesTagNS } from "saxes";
import type { CadSnapshotDraft } from "@cadsense/contracts";
import { CAD_SCENE_LIMITS } from "@cadsense/shared/cadSceneBudget";
import { CadGeometryError } from "../cad/CadGeometry.ts";
import { readOnshapeZip } from "./OnshapeExportBundle.ts";

const CORE = "http://schemas.microsoft.com/3dmanufacturing/core/2015/02";
const MATERIAL = "http://schemas.microsoft.com/3dmanufacturing/material/2015/02";
const REL = "http://schemas.openxmlformats.org/package/2006/relationships";
export class OnshapeThreeMfIdentityError extends Schema.TaggedErrorClass<OnshapeThreeMfIdentityError>()(
  "OnshapeThreeMfIdentityError",
  {},
) {}
const identityUnavailable = () => new OnshapeThreeMfIdentityError({});
const invalid = () => new CadGeometryError({ reason: "invalid-geometry" });
const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const attr = (tag: SaxesTagNS, name: string) => tag.attributes[name]?.value;
const integer = (value: string | undefined) => {
  if (value === undefined || !/^\d+$/.test(value)) throw invalid();
  const result = Number(value);
  if (!Number.isSafeInteger(result)) throw invalid();
  return result;
};
const number = (value: string | undefined) => {
  if (!value?.trim() || !Number.isFinite(Number(value))) throw invalid();
  return Number(value);
};
function xml(
  bytes: Uint8Array,
  open: (tag: SaxesTagNS, parent: string | undefined) => void,
  close: (tag: SaxesTagNS) => void = () => {},
) {
  const parser = new SaxesParser({ xmlns: true });
  const parents: string[] = [];
  parser.on("doctype", () => {
    throw invalid();
  });
  parser.on("error", () => {
    throw invalid();
  });
  parser.on("opentag", (tag) => {
    if (parents.length > 128) throw invalid();
    open(tag, parents.at(-1));
    parents.push(`${tag.uri}:${tag.local}`);
  });
  parser.on("closetag", (tag) => {
    close(tag);
    parents.pop();
  });
  parser.write(new TextDecoder("utf-8", { fatal: true }).decode(bytes)).close();
}
type Object3mf = {
  id: string;
  name: string;
  positions: number[];
  triangles: Map<string, number[]>;
  components: { id: string; matrix: number[] }[];
  pid?: string;
  pindex?: string;
};
const multiply = (a: readonly number[], b: readonly number[]) =>
  Array.from({ length: 16 }, (_, i) =>
    [0, 1, 2, 3].reduce((s, k) => s + a[k * 4 + (i % 4)]! * b[Math.floor(i / 4) * 4 + k]!, 0),
  );
const transform = (value: string | undefined) => {
  if (value === undefined) return [...identity];
  const v = value.trim().split(/\s+/).map(Number);
  if (v.length !== 12 || v.some((x) => !Number.isFinite(x))) throw invalid();
  return [
    v[0]!,
    v[1]!,
    v[2]!,
    0,
    v[3]!,
    v[4]!,
    v[5]!,
    0,
    v[6]!,
    v[7]!,
    v[8]!,
    0,
    v[9]!,
    v[10]!,
    v[11]!,
    1,
  ];
};
const color = (value: string | undefined) => {
  if (!value || !/^#[a-f\d]{6}([a-f\d]{2})?$/i.test(value)) throw invalid();
  const c = [1, 3, 5].map((i) => parseInt(value.slice(i, i + 2), 16) / 255);
  return [
    ...c.map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)),
    value.length === 9 ? parseInt(value.slice(7, 9), 16) / 255 : 1,
  ];
};
function glb(object: Object3mf, palettes: Map<string, number[][]>) {
  const positions = new Float32Array(object.positions);
  const normals = new Float32Array(positions.length);
  for (const indices of object.triangles.values())
    for (let i = 0; i < indices.length; i += 3) {
      const a = indices[i]! * 3,
        b = indices[i + 1]! * 3,
        c = indices[i + 2]! * 3;
      const ux = positions[b]! - positions[a]!,
        uy = positions[b + 1]! - positions[a + 1]!,
        uz = positions[b + 2]! - positions[a + 2]!;
      const vx = positions[c]! - positions[a]!,
        vy = positions[c + 1]! - positions[a + 1]!,
        vz = positions[c + 2]! - positions[a + 2]!;
      const n = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
      for (const j of [a, b, c])
        for (let k = 0; k < 3; k++) normals[j + k] = normals[j + k]! + n[k]!;
    }
  for (let i = 0; i < normals.length; i += 3) {
    const length = Math.hypot(normals[i]!, normals[i + 1]!, normals[i + 2]!);
    if (length) for (let k = 0; k < 3; k++) normals[i + k] = normals[i + k]! / length;
  }
  const chunks: Uint8Array[] = [],
    views: { buffer: number; byteOffset: number; byteLength: number }[] = [];
  let offset = 0;
  const add = (bytes: Uint8Array) => {
    const id = views.length;
    views.push({ buffer: 0, byteOffset: offset, byteLength: bytes.length });
    chunks.push(bytes);
    const padding = (4 - (bytes.length % 4)) % 4;
    if (padding) chunks.push(new Uint8Array(padding));
    offset += bytes.length + padding;
    return id;
  };
  const accessors: {
    bufferView: number;
    componentType: number;
    count: number;
    type: string;
    min?: number[];
    max?: number[];
  }[] = [];
  const min = [Infinity, Infinity, Infinity],
    max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i++) {
    min[i % 3] = Math.min(min[i % 3]!, positions[i]!);
    max[i % 3] = Math.max(max[i % 3]!, positions[i]!);
  }
  accessors.push({
    bufferView: add(new Uint8Array(positions.buffer)),
    componentType: 5126,
    count: positions.length / 3,
    type: "VEC3",
    min,
    max,
  });
  accessors.push({
    bufferView: add(new Uint8Array(normals.buffer)),
    componentType: 5126,
    count: positions.length / 3,
    type: "VEC3",
  });
  const materials: unknown[] = [],
    primitives: unknown[] = [];
  for (const [key, indices] of object.triangles) {
    const [pid, pindex] = key.split(":");
    const rgba = pid ? palettes.get(pid)?.[Number(pindex)] : [0.5, 0.5, 0.5, 1];
    if (!rgba) throw invalid();
    const values = new Uint32Array(indices),
      accessor = accessors.length;
    accessors.push({
      bufferView: add(new Uint8Array(values.buffer)),
      componentType: 5125,
      count: values.length,
      type: "SCALAR",
    });
    primitives.push({
      attributes: { POSITION: 0, NORMAL: 1 },
      indices: accessor,
      material: materials.length,
    });
    materials.push({
      name: `3MF color ${key}`,
      pbrMetallicRoughness: { baseColorFactor: rgba, metallicFactor: 0, roughnessFactor: 0.65 },
      ...(rgba[3]! < 1 ? { alphaMode: "BLEND" } : {}),
      doubleSided: true,
    });
  }
  const json = new TextEncoder().encode(
    JSON.stringify({
      asset: { version: "2.0" },
      scene: 0,
      scenes: [{ nodes: [0] }],
      nodes: [{ name: object.name, mesh: 0 }],
      meshes: [{ primitives }],
      materials,
      accessors,
      bufferViews: views,
      buffers: [{ byteLength: offset }],
    }),
  );
  const jsonLength = Math.ceil(json.length / 4) * 4,
    bytes = new Uint8Array(28 + jsonLength + offset),
    view = new DataView(bytes.buffer);
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, bytes.length, true);
  view.setUint32(12, jsonLength, true);
  view.setUint32(16, 0x4e4f534a, true);
  bytes.fill(32, 20, 20 + jsonLength);
  bytes.set(json, 20);
  view.setUint32(20 + jsonLength, offset, true);
  view.setUint32(24 + jsonLength, 0x004e4942, true);
  let cursor = 28 + jsonLength;
  for (const chunk of chunks) {
    bytes.set(chunk, cursor);
    cursor += chunk.length;
  }
  return bytes;
}

/** Match all exported occurrences uniquely before publishing any source geometry. No UUID or array-order identity inference. */
export function readOnshapeThreeMf(
  draft: CadSnapshotDraft,
  bytes: Uint8Array,
  references?: ReadonlySet<string>,
) {
  const files = readOnshapeZip(bytes),
    relationships = files.get("_rels/.rels");
  if (!relationships) throw invalid();
  let target: string | undefined;
  xml(relationships(), (tag) => {
    if (
      tag.uri === REL &&
      tag.local === "Relationship" &&
      attr(tag, "Type") === "http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"
    ) {
      if (target || attr(tag, "TargetMode") === "External") throw invalid();
      target = attr(tag, "Target");
    }
  });
  if (!target || target.includes("..") || target.includes("\\") || target.includes("%"))
    throw invalid();
  const model = files.get(target.replace(/^\//, ""));
  if (!model) throw invalid();
  const objects = new Map<string, Object3mf>(),
    palettes = new Map<string, number[][]>(),
    build: { id: string; matrix: number[] }[] = [];
  let current: Object3mf | undefined,
    palette: number[][] | undefined,
    vertices = 0,
    triangles = 0,
    rootSeen = false;
  xml(
    model(),
    (tag, parent) => {
      const a = (name: string) => attr(tag, name);
      if (tag.uri === CORE) {
        switch (tag.local) {
          case "model":
            if (rootSeen || a("unit") !== "meter") throw invalid();
            rootSeen = true;
            break;
          case "object": {
            if (parent !== `${CORE}:resources` || current || objects.size >= 100_000)
              throw invalid();
            const id = a("id");
            if (!id || objects.has(id)) throw invalid();
            current = {
              id,
              name: a("name") ?? "",
              positions: [],
              triangles: new Map(),
              components: [],
              ...(a("pid") ? { pid: a("pid")! } : {}),
              ...(a("pindex") ? { pindex: a("pindex")! } : {}),
            };
            objects.set(id, current);
            break;
          }
          case "vertex":
            if (
              !current ||
              parent !== `${CORE}:vertices` ||
              ++vertices > CAD_SCENE_LIMITS.triangles * 3
            )
              throw invalid();
            current.positions.push(number(a("x")), number(a("y")), number(a("z")));
            break;
          case "triangle": {
            if (
              !current ||
              parent !== `${CORE}:triangles` ||
              ++triangles > CAD_SCENE_LIMITS.triangles
            )
              throw invalid();
            const indices = [integer(a("v1")), integer(a("v2")), integer(a("v3"))];
            if (
              indices.some((i) => i >= current!.positions.length / 3) ||
              new Set(indices).size !== 3
            )
              throw invalid();
            const pid = a("pid") ?? current.pid ?? "",
              p1 = a("p1") ?? current.pindex ?? "0";
            // Onshape emits flat per-face colors. Reject interpolated/unsupported properties rather than silently discard them.
            if ((a("p2") ?? p1) !== p1 || (a("p3") ?? p1) !== p1) throw invalid();
            integer(p1);
            const key = `${pid}:${p1}`,
              group = current.triangles.get(key) ?? [];
            group.push(...indices);
            current.triangles.set(key, group);
            break;
          }
          case "component":
            if (!current || parent !== `${CORE}:components` || !a("objectid")) throw invalid();
            current.components.push({ id: a("objectid")!, matrix: transform(a("transform")) });
            break;
          case "item":
            if (parent !== `${CORE}:build` || !a("objectid")) throw invalid();
            build.push({ id: a("objectid")!, matrix: transform(a("transform")) });
            break;
        }
      } else if (tag.uri === MATERIAL && tag.local === "colorgroup") {
        const id = a("id");
        if (!id || palettes.has(id)) throw invalid();
        palette = [];
        palettes.set(id, palette);
      } else if (tag.uri === MATERIAL && tag.local === "color") {
        if (!palette) throw invalid();
        palette.push(color(a("color")));
      } else if (
        [
          "texture2d",
          "texture2dgroup",
          "multiproperties",
          "compositematerials",
          "basematerials",
          "beam",
          "slice",
        ].includes(tag.local)
      )
        throw invalid();
    },
    (tag) => {
      if (tag.uri === CORE && tag.local === "object") current = undefined;
      if (tag.uri === MATERIAL && tag.local === "colorgroup") palette = undefined;
    },
  );
  if (!rootSeen || !build.length) throw invalid();
  const parts = new Map(draft.parts.map((p) => [p.geometryKey, p]));
  const candidates = draft.nodes.filter((n) => !n.suppressed && n.sourcePartKey !== null);
  const matched = new Map<string, Set<string>>();
  const rejected = new Set<string>();
  let visits = 0;
  const visit = (id: string, matrix: number[], ancestors: Set<string>) => {
    const object = objects.get(id);
    if (!object || ancestors.has(id) || ++visits > 100_000 || ancestors.size > 128) throw invalid();
    if (object.positions.length) {
      if (!object.triangles.size || object.components.length) throw invalid();
      const atPose = candidates.filter((n) =>
        matrix.every(
          (v, i) =>
            Math.abs(v - n.transform[(i % 4) * 4 + Math.floor(i / 4)]!) <=
            1e-5 * Math.max(1, Math.abs(v)),
        ),
      );
      const named = atPose.filter(
        (n) =>
          parts.get(n.sourcePartKey!)?.metadata?.name === object.name ||
          n.name.replace(/\s*<\d+>$/, "").trim() === object.name,
      );
      // Composite exports flatten their member bodies and retain the member names.
      // Accept only a unique composite at this placement. Coincident/renamed solids
      // require source-ID geometry; never pick an arbitrary repeated instance.
      const matches = named.length
        ? named
        : atPose.length === 1 &&
            parts.get(atPose[0]!.sourcePartKey!)?.metadata?.bodyType === "composite"
          ? atPose
          : [];
      if (matches.length !== 1) {
        if (!references) throw identityUnavailable();
        for (const n of named.length ? named : atPose) rejected.add(n.sourcePartKey!);
      } else {
        const match = matches[0]!,
          ids = matched.get(match.id) ?? new Set<string>();
        if (
          ids.has(id) ||
          (ids.size && parts.get(match.sourcePartKey!)?.metadata?.bodyType !== "composite")
        )
          rejected.add(match.sourcePartKey!);
        ids.add(id);
        matched.set(match.id, ids);
      }
    }
    for (const component of object.components)
      visit(component.id, multiply(matrix, component.matrix), new Set([...ancestors, id]));
  };
  for (const item of build) visit(item.id, item.matrix, new Set());
  const keys = new Map<string, string[]>();
  for (const n of candidates) {
    const ids = [...(matched.get(n.id) ?? [])].sort();
    const previous = keys.get(n.sourcePartKey!);
    if (!ids.length || (previous && previous.join(",") !== ids.join(",")))
      rejected.add(n.sourcePartKey!);
    keys.set(n.sourcePartKey!, ids);
  }
  for (const p of draft.parts)
    if (p.geometryRequired && (!keys.get(p.geometryKey)?.length || rejected.has(p.geometryKey))) {
      keys.delete(p.geometryKey);
      if (!references?.has(p.geometryKey)) throw identityUnavailable();
    }
  return {
    has: (key: string) => keys.has(key) || (references?.has(key) ?? false),
    usesReference: (key: string) => !keys.has(key) && (references?.has(key) ?? false),
    extract: (key: string) => {
      const ids = keys.get(key);
      if (!ids) throw invalid();
      if (ids.length === 1) return glb(objects.get(ids[0]!)!, palettes);
      const merged: Object3mf = {
        id: key,
        name: parts.get(key)?.metadata?.name ?? "Composite",
        positions: [],
        triangles: new Map(),
        components: [],
      };
      for (const id of ids) {
        const body = objects.get(id)!,
          offset = merged.positions.length / 3;
        for (const value of body.positions) merged.positions.push(value);
        for (const [color, indices] of body.triangles) {
          const group = merged.triangles.get(color) ?? [];
          for (const index of indices) group.push(index + offset);
          merged.triangles.set(color, group);
        }
      }
      return glb(merged, palettes);
    },
  };
}
