// @effect-diagnostics nodeBuiltinImport:off
// Part identities are content hashes, like the rest of local CAD.
import * as NodeCrypto from "node:crypto";
import {
  OnshapeElementId,
  OnshapeWorkspaceId,
  type CadPartSource,
  type CadPartStudioSource,
  type CadSnapshotContext,
  type CadSnapshotNode,
  type CadSnapshotPart,
} from "@cadsense/contracts";
import { CadGeometryError } from "../cad/CadGeometry.ts";
import {
  snapshotGeometryKey,
  snapshotNodeId,
  snapshotPartStudioKey,
} from "../onshape/OnshapeSnapshotManifest.ts";
import type { SolidWorksNode } from "./SolidWorksBridge.ts";
import type { LocalCadMesh, Rgb } from "./LocalCadTessellation.ts";

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const MAX_NODES = 100_000;
const MAX_DEPTH = 128;
/** A part's `partId` is its SolidWorks key: the SHA-256 of its file and configuration. */
const PART_KEY = /^[0-9a-f]{64}$/;

/** What an import has for one SolidWorks part key. */
export type SolidWorksPartGeometry =
  | { readonly kind: "reused"; readonly part: CadSnapshotPart }
  | { readonly kind: "mesh"; readonly name: string; readonly mesh: LocalCadMesh }
  /** A part with no bodies, such as one holding only sketches. It is left out of the tree. */
  | { readonly kind: "empty" };

/**
 * SolidWorks `MathTransform.ArrayData` (a 3x3 rotation, a translation, then a scale, applied to row
 * vectors) as the manifest's absolute row-major matrix for column vectors. SolidWorks already
 * reports each component relative to the root assembly.
 */
export const solidWorksTransform = (data: readonly number[] | null): readonly number[] => {
  if (!data || data.length < 13) return IDENTITY;
  const [a, b, c, d, e, f, g, h, i, x, y, z, scale] = data as [
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const s = scale || 1;
  return [a * s, d * s, g * s, x, b * s, e * s, h * s, y, c * s, f * s, i * s, z, 0, 0, 0, 1];
};

/** One geometry per part: its meshes merged, each body's color kept on its own triangles. */
export function mergeLocalCadMeshes(meshes: readonly LocalCadMesh[]): LocalCadMesh | null {
  const usable = meshes.filter((mesh) => mesh.index.length >= 3 && mesh.position.length >= 9);
  if (usable.length <= 1) return usable[0] ?? null;
  const vertices = usable.reduce((total, mesh) => total + mesh.position.length, 0);
  const indices = usable.reduce((total, mesh) => total + mesh.index.length, 0);
  const position = new Float32Array(vertices);
  const normal = usable.every((mesh) => mesh.normal) ? new Float32Array(vertices) : null;
  const index = new Uint32Array(indices);
  const faces: { first: number; last: number; color: Rgb | null }[] = [];
  let vertexOffset = 0;
  let indexOffset = 0;
  for (const mesh of usable) {
    const first = indexOffset / 3;
    position.set(mesh.position, vertexOffset);
    if (normal && mesh.normal) normal.set(mesh.normal, vertexOffset);
    for (let k = 0; k < mesh.index.length; k++)
      index[indexOffset + k] = mesh.index[k]! + vertexOffset / 3;
    // Face colors first: the first range to claim a triangle colors it.
    for (const face of mesh.faces)
      if (face.color)
        faces.push({ first: face.first + first, last: face.last + first, color: face.color });
    if (mesh.color)
      faces.push({ first, last: first + mesh.index.length / 3 - 1, color: mesh.color });
    vertexOffset += mesh.position.length;
    indexOffset += mesh.index.length;
  }
  return { name: usable[0]!.name, color: null, faces, position, normal, index };
}

const id24 = (value: string) =>
  NodeCrypto.createHash("sha256").update(value).digest("hex").slice(0, 24);

/** The part studio slot for one SolidWorks part key, under the import's document. */
const studioFor = (context: CadSnapshotContext, key: string, configuration: string) => {
  const slot = id24(`solidworks-part:${key}`);
  return {
    host: context.root.host,
    documentId: context.root.documentId,
    documentMicroversion: OnshapeWorkspaceId.make(slot),
    documentVersion: null,
    elementId: OnshapeElementId.make(slot),
    configuration,
    fullConfiguration: configuration,
  } satisfies CadPartStudioSource;
};

const toSrgbByte = (linear: number) => {
  const value = Math.min(1, Math.max(0, linear));
  const srgb = value <= 0.0031308 ? value * 12.92 : 1.055 * value ** (1 / 2.4) - 0.055;
  return Math.round(srgb * 255);
};

/** The parts of a previous snapshot that came from SolidWorks, by key, for reuse. */
export const reusableSolidWorksParts = (
  parts: readonly CadSnapshotPart[],
  tessellationProfile: string,
) =>
  new Map(
    parts
      .filter(
        (part) =>
          PART_KEY.test(part.source.partId) &&
          part.source.tessellationProfile === tessellationProfile,
      )
      .map((part) => [part.source.partId, part] as const),
  );

/**
 * Maps the SolidWorks component tree onto snapshot occurrences under a root named for the file.
 * Every part component becomes one part node, placed by its SolidWorks transform, with geometry
 * shared by key. Suppressed components stay in the tree, suppressed. A part opened on its own is
 * the root's only child.
 */
export function buildSolidWorksDraft(
  context: CadSnapshotContext,
  tree: SolidWorksNode,
  rootName: string,
  geometry: ReadonlyMap<string, SolidWorksPartGeometry>,
) {
  const { rootId } = context;
  const nodes: CadSnapshotNode[] = [];
  const parts = new Map<string, CadSnapshotPart>();
  const dependencies = new Map<string, CadPartStudioSource>();
  const meshes = new Map<string, LocalCadMesh>();
  const occurrence = (path: readonly string[], parentId: string | null, name: string) => ({
    id: snapshotNodeId(rootId, path),
    parentId,
    occurrencePath: path,
    instanceId: null,
    name,
  });
  const rootNode: CadSnapshotNode = {
    ...occurrence([], null, rootName),
    kind: "assembly",
    suppressed: false,
    defaultVisible: true,
    transform: IDENTITY,
    sourcePartKey: null,
  };
  nodes.push(rootNode);

  /** The geometry key for a part component, or null when the part has no geometry. */
  const partKey = (node: SolidWorksNode) => {
    const found = node.key === null ? undefined : geometry.get(node.key);
    if (!found || found.kind === "empty" || node.key === null) return null;
    if (found.kind === "reused") {
      parts.set(found.part.geometryKey, found.part);
      const { partId: _, tessellationProfile: __, ...studio } = found.part.source;
      dependencies.set(snapshotPartStudioKey(studio), studio);
      return found.part.geometryKey;
    }
    const studio = studioFor(context, node.key, node.configuration);
    const source: CadPartSource = {
      ...studio,
      partId: node.key,
      tessellationProfile: context.root.tessellationProfile,
    };
    const geometryKey = snapshotGeometryKey(source);
    if (!parts.has(geometryKey)) {
      const { mesh } = found;
      const color = mesh.color ?? mesh.faces.find((face) => face.color)?.color ?? null;
      parts.set(geometryKey, {
        geometryKey,
        source,
        geometryRequired: true,
        metadata: {
          name: found.name,
          bodyType: "solid",
          isHidden: false,
          isMesh: false,
          partIdentity: null,
          configurationId: null,
          appearance: color
            ? {
                color: {
                  red: toSrgbByte(color[0]),
                  green: toSrgbByte(color[1]),
                  blue: toSrgbByte(color[2]),
                },
                opacity: 255,
              }
            : null,
          material: null,
        },
      });
      dependencies.set(snapshotPartStudioKey(studio), studio);
      meshes.set(geometryKey, mesh);
    }
    return geometryKey;
  };

  const walk = (
    children: readonly SolidWorksNode[],
    parentPath: readonly string[],
    parentId: string,
    parentVisible: boolean,
  ) => {
    const seen = new Map<string, number>();
    for (const child of children) {
      const name = child.name.trim() || "Component";
      const count = (seen.get(name) ?? 0) + 1;
      seen.set(name, count);
      const path = [...parentPath, count === 1 ? name : `${name}#${count}`];
      if (path.length > MAX_DEPTH || nodes.length >= MAX_NODES)
        throw new CadGeometryError({ reason: "too-large" });
      const base = {
        ...occurrence(path, parentId, name),
        transform: solidWorksTransform(child.transform),
      };
      const visible = parentVisible && child.visible;
      if (child.suppressed) {
        nodes.push({
          ...base,
          kind: child.kind,
          suppressed: true,
          defaultVisible: false,
          sourcePartKey: null,
        });
        continue;
      }
      if (child.kind === "assembly") {
        nodes.push({
          ...base,
          kind: "assembly",
          suppressed: false,
          defaultVisible: visible,
          sourcePartKey: null,
        });
        walk(child.children, path, base.id, visible);
        continue;
      }
      const sourcePartKey = partKey(child);
      if (sourcePartKey)
        nodes.push({
          ...base,
          kind: "part",
          suppressed: false,
          defaultVisible: visible,
          sourcePartKey,
        });
    }
  };
  walk(
    tree.kind === "part" ? [{ ...tree, transform: null }] : tree.children,
    [],
    rootNode.id,
    true,
  );
  return {
    draft: {
      schemaVersion: 1 as const,
      ...context,
      nodes,
      parts: [...parts.values()],
      dependencies: [...dependencies.values()],
    },
    meshes,
  };
}
