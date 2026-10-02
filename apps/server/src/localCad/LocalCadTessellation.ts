import * as NodeModule from "node:module";
import * as NodeWorkerThreads from "node:worker_threads";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export type Rgb = readonly [number, number, number];

/** One occt mesh in world coordinates and meters. Colors are linear RGB in 0..1. */
export interface LocalCadMesh {
  readonly name: string;
  readonly color: Rgb | null;
  /** Inclusive triangle ranges for each B-rep face, with the face's own color when it has one. */
  readonly faces: readonly {
    readonly first: number;
    readonly last: number;
    readonly color: Rgb | null;
  }[];
  readonly position: Float32Array;
  readonly normal: Float32Array | null;
  readonly index: Uint32Array;
}

/** A STEP product occurrence. `meshes` index into `LocalCadModel.meshes`. */
export interface LocalCadTreeNode {
  readonly name: string;
  readonly meshes: readonly number[];
  readonly children: readonly LocalCadTreeNode[];
}

export interface LocalCadModel {
  readonly root: LocalCadTreeNode;
  readonly meshes: readonly LocalCadMesh[];
}

export type LocalCadFormat = "step" | "iges";

export class LocalCadImportError extends Schema.TaggedErrorClass<LocalCadImportError>()(
  "LocalCadImportError",
  { reason: Schema.Literals(["too-large", "unreadable", "no-geometry"]) },
) {}

/**
 * Onshape's part export tolerances, so local and Onshape CAD look and measure alike. The
 * deflection is absolute: a bounding-box ratio would retessellate every part when one grows.
 */
const TESSELLATION_PARAMS = {
  linearUnit: "meter",
  linearDeflectionType: "absolute_value",
  linearDeflection: 0.0005,
  angularDeflection: 0.1,
} as const;
export const LOCAL_CAD_TESSELLATION_PROFILE = "occt-import-js-0.0.23-chord-0.0005-angle-0.1";

// Resolved here, not in the worker, so a bundled server still finds the external package on disk.
const OCCT_ENTRY = NodeModule.createRequire(import.meta.url).resolve("occt-import-js");

// Node also posts on a worker's parent port (watch mode reports every require there), so the
// result carries a type the listener filters on.
const RESULT_TYPE = "cadsense-local-cad-result";

// CommonJS because eval workers are scripts. Typed arrays are transferred, not copied.
const WORKER_SOURCE = String.raw`
const { parentPort, workerData } = require("node:worker_threads");
const type = ${JSON.stringify(RESULT_TYPE)};
const fail = (cause) =>
  parentPort.postMessage({
    type,
    ok: false,
    error: cause ? String(cause.stack || cause) : "occt rejected the file",
  });
require(workerData.entry)({ print() {}, printErr() {} })
  .then((occt) => {
    const read = workerData.format === "iges" ? occt.ReadIgesFile : occt.ReadStepFile;
    const result = read(workerData.bytes, workerData.params);
    if (!result || !result.success) return fail(null);
    const transfer = [];
    const meshes = result.meshes.map((mesh) => {
      const position = Float32Array.from(mesh.attributes.position.array);
      const normal = mesh.attributes.normal ? Float32Array.from(mesh.attributes.normal.array) : null;
      const index = Uint32Array.from(mesh.index.array);
      transfer.push(position.buffer, index.buffer);
      if (normal) transfer.push(normal.buffer);
      return {
        name: mesh.name || "",
        color: mesh.color || null,
        faces: (mesh.brep_faces || []).map((face) => ({
          first: face.first,
          last: face.last,
          color: face.color || null,
        })),
        position,
        normal,
        index,
      };
    });
    parentPort.postMessage({ type, ok: true, root: result.root, meshes }, transfer);
  })
  .catch(fail);
`;

const isRgb = (value: unknown): value is Rgb =>
  Array.isArray(value) &&
  value.length === 3 &&
  value.every((channel) => typeof channel === "number" && Number.isFinite(channel));

const isTreeNode = (value: unknown, depth = 0): value is LocalCadTreeNode =>
  depth <= 256 &&
  typeof value === "object" &&
  value !== null &&
  "name" in value &&
  typeof value.name === "string" &&
  "meshes" in value &&
  Array.isArray(value.meshes) &&
  value.meshes.every(Number.isSafeInteger) &&
  "children" in value &&
  Array.isArray(value.children) &&
  value.children.every((child) => isTreeNode(child, depth + 1));

const isMesh = (value: unknown): value is LocalCadMesh =>
  typeof value === "object" &&
  value !== null &&
  "name" in value &&
  typeof value.name === "string" &&
  "color" in value &&
  (value.color === null || isRgb(value.color)) &&
  "faces" in value &&
  Array.isArray(value.faces) &&
  "position" in value &&
  value.position instanceof Float32Array &&
  "normal" in value &&
  (value.normal === null || value.normal instanceof Float32Array) &&
  "index" in value &&
  value.index instanceof Uint32Array;

const isModel = (value: unknown): value is LocalCadModel =>
  typeof value === "object" &&
  value !== null &&
  "root" in value &&
  isTreeNode(value.root) &&
  "meshes" in value &&
  Array.isArray(value.meshes) &&
  value.meshes.every(isMesh);

/**
 * Tessellates a STEP or IGES file with OpenCascade in a worker thread, so a large file cannot stall
 * the server. Interrupting the effect terminates the worker.
 */
export const tessellateLocalCad = (bytes: Uint8Array, format: LocalCadFormat) =>
  Effect.callback<LocalCadModel, LocalCadImportError>((resume) => {
    let settled = false;
    const settle = (result: Effect.Effect<LocalCadModel, LocalCadImportError>) => {
      if (settled) return;
      settled = true;
      resume(result);
    };
    const unreadable = (detail: string) =>
      settle(
        Effect.logWarning("Local CAD tessellation failed", { detail: detail.slice(0, 2000) }).pipe(
          Effect.andThen(Effect.fail(new LocalCadImportError({ reason: "unreadable" }))),
        ),
      );
    // A private copy owns its whole buffer, so it can be transferred. `Buffer#slice` is a view,
    // and transferring its buffer would detach the caller's bytes or a pooled slab.
    const owned = new Uint8Array(bytes);
    const worker = new NodeWorkerThreads.Worker(WORKER_SOURCE, {
      eval: true,
      workerData: { entry: OCCT_ENTRY, format, bytes: owned, params: TESSELLATION_PARAMS },
      transferList: [owned.buffer],
    });
    worker.on("message", (message: unknown) => {
      if (
        typeof message !== "object" ||
        message === null ||
        !("type" in message) ||
        message.type !== RESULT_TYPE
      )
        return;
      if ("ok" in message && message.ok === true && isModel(message))
        settle(Effect.succeed({ root: message.root, meshes: message.meshes }));
      else
        unreadable(
          "error" in message
            ? String(message.error)
            : "The worker returned an unexpected model shape.",
        );
      void worker.terminate();
    });
    worker.once("error", (error) => unreadable(error.stack ?? error.message));
    // Covers a worker killed by WASM running out of memory, which posts nothing.
    worker.once("exit", (code) => unreadable(`The worker exited with code ${code}.`));
    return Effect.promise(() => worker.terminate()).pipe(Effect.asVoid);
  });
