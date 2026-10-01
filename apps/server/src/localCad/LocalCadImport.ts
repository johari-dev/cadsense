import type {
  CadCatalog,
  CadGeometryAsset,
  CadPartStudioSource,
  CadSnapshotContext,
  CadSnapshotManifest,
  CadSnapshotNode,
  CadSnapshotPart,
  CadSnapshotRoot,
  LocalCadError,
  ProjectId,
} from "@cadsense/contracts";
import {
  CadSceneBudgetError,
  createCadSceneBudget,
  measureCadGeometry,
} from "@cadsense/shared/cadSceneBudget";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { CadGeometryError, normalizeCadGeometry } from "../cad/CadGeometry.ts";
import { CadSnapshotStore, type CadSnapshotStoreError } from "../cad/CadSnapshotStore.ts";
import { ServerConfig } from "../config.ts";
import { prepareCadSnapshotTransfer } from "../onshape/OnshapeSnapshotAcquisition.ts";
import {
  completeSnapshotManifest,
  snapshotGeometryKey,
  snapshotNodeId,
  snapshotRootId,
  type OnshapeSnapshotManifestError,
} from "../onshape/OnshapeSnapshotManifest.ts";
import { WorkspacePaths } from "../workspace/WorkspacePaths.ts";
import {
  MAX_LOCAL_CAD_FILE_BYTES,
  localCadCatalog,
  localCadMicroversionId,
  localCadRootIdentity,
  resolveLocalCadFile,
  scanLocalCadFiles,
} from "./LocalCadFiles.ts";
import {
  LOCAL_CAD_TESSELLATION_PROFILE,
  LocalCadImportError,
  tessellateLocalCad,
  type LocalCadMesh,
  type LocalCadModel,
  type Rgb,
} from "./LocalCadTessellation.ts";
export { LocalCadImportError } from "./LocalCadTessellation.ts";

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const DEFAULT_COLOR: Rgb = [0.5, 0.5, 0.5];
const MAX_NODES = 100_000;
const MAX_DEPTH = 128;

export interface LocalCadImportInput {
  readonly projectId: ProjectId;
  readonly workspaceRoot: string;
  /** Workspace-relative path of the file to import. */
  readonly filePath: string;
}

export type LocalCadImportFailure =
  | LocalCadError
  | LocalCadImportError
  | CadGeometryError
  | CadSnapshotStoreError
  | OnshapeSnapshotManifestError;

export class LocalCadImport extends Context.Service<
  LocalCadImport,
  {
    /** Scans the project folder for CAD files. Free, so local syncs run it every time. */
    readonly catalog: (input: {
      readonly workspaceRoot: string;
      readonly defaultFilePath: string;
    }) => Effect.Effect<Omit<CadCatalog, "refreshedAt">, LocalCadError>;
    /** Imports one file as a published snapshot. Callers must hold a CAD operation reservation. */
    readonly acquire: (
      input: LocalCadImportInput,
    ) => Effect.Effect<CadSnapshotManifest, LocalCadImportFailure>;
  }
>()("@cadsense/server/localCad/LocalCadImport") {}

const toSrgbByte = (linear: number) => {
  const value = Math.min(1, Math.max(0, linear));
  const srgb = value <= 0.0031308 ? value * 12.92 : 1.055 * value ** (1 / 2.4) - 0.055;
  return Math.round(srgb * 255);
};

/** Triangle groups by color. Face colors win over the body color, which wins over gray. */
function colorGroups(mesh: LocalCadMesh) {
  const triangles = mesh.index.length / 3;
  const fallback = mesh.color ?? DEFAULT_COLOR;
  if (!mesh.faces.some((face) => face.color)) return [{ color: fallback, index: mesh.index }];
  const groups = new Map<string, { color: Rgb; triangles: number[] }>();
  const group = (color: Rgb) => {
    const key = color.map((channel) => channel.toFixed(4)).join(",");
    let entry = groups.get(key);
    if (!entry) groups.set(key, (entry = { color, triangles: [] }));
    return entry;
  };
  const assigned = new Uint8Array(triangles);
  for (const face of mesh.faces) {
    if (
      !face.color ||
      !Number.isSafeInteger(face.first) ||
      !Number.isSafeInteger(face.last) ||
      face.first < 0 ||
      face.last < face.first ||
      face.last >= triangles
    )
      continue;
    const target = group(face.color);
    for (let triangle = face.first; triangle <= face.last; triangle++) {
      if (assigned[triangle]) continue;
      assigned[triangle] = 1;
      target.triangles.push(triangle);
    }
  }
  for (let triangle = 0; triangle < triangles; triangle++)
    if (!assigned[triangle]) group(fallback).triangles.push(triangle);
  return [...groups.values()].map(({ color, triangles: list }) => {
    const index = new Uint32Array(list.length * 3);
    list.forEach((triangle, offset) =>
      index.set(mesh.index.subarray(triangle * 3, triangle * 3 + 3), offset * 3),
    );
    return { color, index };
  });
}

/** Unit normals from occt, or area-weighted vertex normals when occt omitted them. */
function unitNormals(mesh: LocalCadMesh) {
  const normals = mesh.normal
    ? Float32Array.from(mesh.normal)
    : new Float32Array(mesh.position.length);
  if (!mesh.normal)
    for (let i = 0; i < mesh.index.length; i += 3) {
      const [a, b, c] = [mesh.index[i]! * 3, mesh.index[i + 1]! * 3, mesh.index[i + 2]! * 3];
      const p = mesh.position;
      const u = [p[b]! - p[a]!, p[b + 1]! - p[a + 1]!, p[b + 2]! - p[a + 2]!];
      const v = [p[c]! - p[a]!, p[c + 1]! - p[a + 1]!, p[c + 2]! - p[a + 2]!];
      const n = [
        u[1]! * v[2]! - u[2]! * v[1]!,
        u[2]! * v[0]! - u[0]! * v[2]!,
        u[0]! * v[1]! - u[1]! * v[0]!,
      ];
      for (const vertex of [a, b, c]) for (let k = 0; k < 3; k++) normals[vertex + k]! += n[k]!;
    }
  for (let i = 0; i < normals.length; i += 3) {
    const length = Math.hypot(normals[i]!, normals[i + 1]!, normals[i + 2]!);
    if (length > 0) for (let k = 0; k < 3; k++) normals[i + k]! /= length;
    else normals.set([0, 0, 1], i);
  }
  return normals;
}

/** A self-contained GLB for one part: shared positions and normals, one primitive per color. */
export function localCadMeshGlb(mesh: LocalCadMesh, name: string): Uint8Array {
  const chunks: Uint8Array[] = [];
  const bufferViews: { buffer: 0; byteOffset: number; byteLength: number; target: number }[] = [];
  let byteLength = 0;
  const addView = (bytes: Uint8Array, target: number) => {
    bufferViews.push({ buffer: 0, byteOffset: byteLength, byteLength: bytes.byteLength, target });
    chunks.push(bytes);
    const padding = (4 - (bytes.byteLength % 4)) % 4;
    if (padding) chunks.push(new Uint8Array(padding));
    byteLength += bytes.byteLength + padding;
    return bufferViews.length - 1;
  };
  const asBytes = (array: Float32Array | Uint32Array) =>
    new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < mesh.position.length; i++) {
    min[i % 3] = Math.min(min[i % 3]!, mesh.position[i]!);
    max[i % 3] = Math.max(max[i % 3]!, mesh.position[i]!);
  }
  const vertexCount = mesh.position.length / 3;
  const accessors: object[] = [
    {
      bufferView: addView(asBytes(mesh.position), 34962),
      componentType: 5126,
      count: vertexCount,
      type: "VEC3",
      min,
      max,
    },
    {
      bufferView: addView(asBytes(unitNormals(mesh)), 34962),
      componentType: 5126,
      count: vertexCount,
      type: "VEC3",
    },
  ];
  const materials: object[] = [];
  const primitives: object[] = [];
  for (const { color, index } of colorGroups(mesh)) {
    primitives.push({
      attributes: { POSITION: 0, NORMAL: 1 },
      indices: accessors.length,
      material: materials.length,
    });
    accessors.push({
      bufferView: addView(asBytes(index), 34963),
      componentType: 5125,
      count: index.length,
      type: "SCALAR",
    });
    materials.push({
      pbrMetallicRoughness: {
        baseColorFactor: [...color, 1],
        metallicFactor: 0,
        roughnessFactor: 0.65,
      },
      doubleSided: true,
    });
  }
  const json = new TextEncoder().encode(
    JSON.stringify({
      asset: { version: "2.0", generator: "Cadsense local CAD import" },
      scene: 0,
      scenes: [{ nodes: [0] }],
      nodes: [{ name, mesh: 0 }],
      meshes: [{ primitives }],
      materials,
      accessors,
      bufferViews,
      buffers: [{ byteLength }],
    }),
  );
  const jsonLength = Math.ceil(json.byteLength / 4) * 4;
  const output = new Uint8Array(28 + jsonLength + byteLength);
  const view = new DataView(output.buffer);
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, output.byteLength, true);
  view.setUint32(12, jsonLength, true);
  view.setUint32(16, 0x4e4f534a, true);
  output.fill(0x20, 20, 20 + jsonLength);
  output.set(json, 20);
  view.setUint32(20 + jsonLength, byteLength, true);
  view.setUint32(24 + jsonLength, 0x004e4942, true);
  let offset = 28 + jsonLength;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

/**
 * Maps the occt product tree onto snapshot occurrences under a root named for the file. A
 * component holding exactly one mesh becomes that part, named by the component, since STEP mesh
 * names are often generic ("SOLID"). Repeated sibling names get `#2`, `#3` path segments.
 */
export function buildLocalCadDraft(
  context: CadSnapshotContext,
  model: LocalCadModel,
  rootName: string,
) {
  const { root } = context;
  const studio: CadPartStudioSource = {
    host: root.host,
    documentId: root.documentId,
    documentMicroversion: root.microversionId,
    documentVersion: null,
    elementId: root.elementId,
    configuration: root.configuration,
    fullConfiguration: root.configuration,
  };
  const occurrence = (path: readonly string[], parentId: string | null, name: string) => ({
    id: snapshotNodeId(context.rootId, path),
    parentId,
    occurrencePath: path,
    instanceId: null,
    name,
    suppressed: false,
    defaultVisible: true,
    transform: IDENTITY,
  });
  const rootNode: CadSnapshotNode = {
    ...occurrence([], null, rootName),
    kind: "assembly",
    sourcePartKey: null,
  };
  const nodes: CadSnapshotNode[] = [rootNode];
  const parts = new Map<string, CadSnapshotPart>();
  const meshes = new Map<string, LocalCadMesh>();
  const stack = [{ tree: model.root, path: [] as string[], parentId: rootNode.id }];
  while (stack.length > 0) {
    const frame = stack.pop()!;
    const seen = new Map<string, number>();
    const childPath = (name: string) => {
      const count = (seen.get(name) ?? 0) + 1;
      seen.set(name, count);
      const path = [...frame.path, count === 1 ? name : `${name}#${count}`];
      if (path.length > MAX_DEPTH || nodes.length >= MAX_NODES)
        throw new CadGeometryError({ reason: "too-large" });
      return path;
    };
    const addPart = (name: string, meshIndex: number) => {
      const mesh = model.meshes[meshIndex];
      if (!mesh || mesh.index.length < 3) return;
      const source = {
        ...studio,
        partId: String(meshIndex),
        tessellationProfile: root.tessellationProfile,
      };
      const geometryKey = snapshotGeometryKey(source);
      if (!parts.has(geometryKey)) {
        const color = mesh.color ?? mesh.faces.find((face) => face.color)?.color ?? null;
        parts.set(geometryKey, {
          geometryKey,
          source,
          geometryRequired: true,
          metadata: {
            name,
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
        meshes.set(geometryKey, mesh);
      }
      nodes.push({
        ...occurrence(childPath(name), frame.parentId, name),
        kind: "part",
        sourcePartKey: geometryKey,
      });
    };
    for (const child of frame.tree.children) {
      const name = child.name.trim() || "Component";
      if (child.children.length === 0 && child.meshes.length === 1) {
        addPart(name, child.meshes[0]!);
        continue;
      }
      const node: CadSnapshotNode = {
        ...occurrence(childPath(name), frame.parentId, name),
        kind: "assembly",
        sourcePartKey: null,
      };
      nodes.push(node);
      stack.push({ tree: child, path: [...node.occurrencePath], parentId: node.id });
    }
    for (const meshIndex of frame.tree.meshes)
      addPart(model.meshes[meshIndex]?.name.trim() || "Part", meshIndex);
  }
  return {
    draft: {
      schemaVersion: 1 as const,
      ...context,
      nodes,
      parts: [...parts.values()],
      dependencies: [studio],
    },
    meshes,
  };
}

const isCadGeometryError = Schema.is(CadGeometryError);
const geometryFailure = (error: unknown) =>
  isCadGeometryError(error)
    ? error
    : new CadGeometryError({
        reason: error instanceof CadSceneBudgetError ? error.reason : "invalid-geometry",
      });

export const make = Effect.gen(function* () {
  const store = yield* CadSnapshotStore;
  const config = yield* Effect.serviceOption(ServerConfig);
  const crypto = yield* Crypto.Crypto;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const workspacePaths = yield* WorkspacePaths;
  const withFiles = <A, E>(
    effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path | WorkspacePaths>,
  ) =>
    effect.pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
      Effect.provideService(WorkspacePaths, workspacePaths),
    );

  const run = Effect.fn("LocalCadImport.acquire")(function* (input: LocalCadImportInput) {
    const file = yield* withFiles(resolveLocalCadFile(input));
    if (file.byteLength > MAX_LOCAL_CAD_FILE_BYTES)
      return yield* new LocalCadImportError({ reason: "too-large" });
    yield* store.checkReserve(file.byteLength);
    const bytes = yield* fileSystem
      .readFile(file.absolutePath)
      .pipe(Effect.mapError(() => new LocalCadImportError({ reason: "unreadable" })));
    const root: CadSnapshotRoot = {
      ...localCadRootIdentity(input.projectId, file.relativePath),
      kind: "assembly",
      microversionId: localCadMicroversionId(bytes),
      tessellationProfile: LOCAL_CAD_TESSELLATION_PROFILE,
    };
    const context: CadSnapshotContext = {
      root,
      rootId: snapshotRootId(root),
      projectId: input.projectId,
      snapshotId: yield* crypto.randomUUIDv4.pipe(
        Effect.mapError(() => new LocalCadImportError({ reason: "unreadable" })),
      ),
      createdAt: DateTime.formatIso(yield* DateTime.now),
    };
    const model = yield* tessellateLocalCad(bytes, file.format);
    const { draft, meshes } = yield* Effect.try({
      try: () => buildLocalCadDraft(context, model, path.basename(file.relativePath)),
      catch: geometryFailure,
    });
    if (draft.parts.length === 0) return yield* new LocalCadImportError({ reason: "no-geometry" });
    const budget = yield* Effect.try({
      try: () => createCadSceneBudget(draft.nodes),
      catch: geometryFailure,
    });
    const assets: CadGeometryAsset[] = [];
    for (const part of draft.parts) {
      const mesh = meshes.get(part.geometryKey)!;
      const glb = yield* normalizeCadGeometry(localCadMeshGlb(mesh, part.metadata?.name ?? ""));
      const complexity = yield* Effect.try({
        try: () => measureCadGeometry(glb),
        catch: geometryFailure,
      });
      const asset = {
        geometryKey: part.geometryKey,
        ...(yield* store.putAsset(glb)),
        complexity,
      };
      yield* Effect.try({ try: () => budget.add(asset, complexity), catch: geometryFailure });
      assets.push(asset);
    }
    const manifest = yield* completeSnapshotManifest(draft, assets);
    yield* store.publish(manifest);
    return manifest;
  });

  return LocalCadImport.of({
    catalog: ({ workspaceRoot, defaultFilePath }) =>
      withFiles(scanLocalCadFiles(workspaceRoot)).pipe(
        Effect.map(({ files }) => localCadCatalog(files, defaultFilePath)),
      ),
    acquire: (input) =>
      store.withAcquisition(
        run(input).pipe(
          Effect.tap((manifest) =>
            Option.isSome(config)
              ? prepareCadSnapshotTransfer(manifest, store, config.value.stateDir)
              : Effect.void,
          ),
        ),
      ),
  });
});

export const layer = Layer.effect(LocalCadImport, make);
