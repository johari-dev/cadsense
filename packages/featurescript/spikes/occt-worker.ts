// @effect-diagnostics globalConsole:off - spike script prints its measurements.
/* eslint-disable unicorn/require-post-message-target-origin -- worker_threads ports take transfer lists, not window target origins. */
// @effect-diagnostics nodeBuiltinImport:off - spike runs directly in Node worker threads.
// @effect-diagnostics globalTimers:off - the parent times out a worker with a plain timer.
/**
 * Spikes S1 and S3: OpenCascade WASM in a Node worker, and history-based face naming.
 *
 * Run: node spikes/occt-worker.ts
 * Prints one JSON report. The parent compiles the WASM once and hands the module to workers,
 * which is how the server would keep startup cheap.
 */
import * as NodeFSP from "node:fs/promises";
import * as NodeModule from "node:module";
import * as NodePerfHooks from "node:perf_hooks";
import * as NodeWorkerThreads from "node:worker_threads";
import init from "replicad-opencascadejs";

type Oc = Awaited<ReturnType<typeof init>>;
type Shape = InstanceType<Oc["TopoDS_Shape"]>;
type Job = "geometry" | "heavy";

const instantiate = (module: WebAssembly.Module) =>
  init({
    instantiateWasm: (
      imports: WebAssembly.Imports,
      done: (instance: WebAssembly.Instance) => void,
    ) => {
      void WebAssembly.instantiate(module, imports).then(done);
      return {};
    },
  });

/** Copies an OCCT shape list into a JS array (the binding exposes no iterator). */
const listShapes = (oc: Oc, list: InstanceType<Oc["NCollection_List_TopoDS_Shape"]>) => {
  const copy = new oc.NCollection_List_TopoDS_Shape(list);
  const out: Shape[] = [];
  while (!copy.IsEmpty()) {
    out.push(copy.First());
    copy.RemoveFirst();
  }
  copy.delete();
  return out;
};

/** Unique sub-shapes in explorer order. The bound IndexedMap can't be constructed in this build,
 * so identity is ReplicadShapeHasher buckets plus IsSame. */
const subShapes = (oc: Oc, shape: Shape, kind: "TopAbs_FACE" | "TopAbs_EDGE" | "TopAbs_VERTEX") => {
  const buckets = new Map<number, Shape[]>();
  const out: Shape[] = [];
  for (const ex = new oc.TopExp_Explorer(shape, oc.TopAbs_ShapeEnum[kind]); ex.More(); ex.Next()) {
    const current = ex.Current();
    const hash = oc.ReplicadShapeHasher.HashCode(current, 2 ** 31 - 1);
    const bucket = buckets.get(hash) ?? [];
    if (bucket.some((seen) => seen.IsSame(current))) continue;
    bucket.push(current);
    buckets.set(hash, bucket);
    out.push(current);
  }
  return out;
};

const volume = (oc: Oc, shape: Shape) => {
  const props = new oc.GProp_GProps();
  oc.BRepGProp.VolumeProperties(shape, props, false, false, false);
  return props.Mass();
};

/** Plate 100 x 60 x 10 mm minus six 5.5 mm holes on a 50 mm circle, with face provenance. */
const geometry = (oc: Oc) => {
  const t0 = NodePerfHooks.performance.now();
  const plate = new oc.BRepPrimAPI_MakeBox(100, 60, 10).Shape();
  const tools = new oc.NCollection_List_TopoDS_Shape();
  const toolShapes: Shape[] = [];
  for (let i = 0; i < 6; i++) {
    const angle = (i * Math.PI) / 3 + Math.PI / 6;
    const axis = new oc.gp_Ax2(
      new oc.gp_Pnt(50 + 25 * Math.cos(angle), 30 + 25 * Math.sin(angle), -5),
      new oc.gp_Dir(0, 0, 1),
    );
    const cylinder = new oc.BRepPrimAPI_MakeCylinder(axis, 2.75, 20).Shape();
    toolShapes.push(cylinder);
    tools.Append(cylinder);
  }
  const args = new oc.NCollection_List_TopoDS_Shape();
  args.Append(plate);
  const cut = new oc.BRepAlgoAPI_Cut();
  cut.SetArguments(args);
  cut.SetTools(tools);
  cut.Build(new oc.Message_ProgressRange());
  if (cut.HasErrors()) throw new Error("boolean failed");
  const result = cut.Shape();
  const booleanMs = NodePerfHooks.performance.now() - t0;

  // Provenance: which input face each result face came from, per OCCT history.
  const resultFaces = subShapes(oc, result, "TopAbs_FACE");
  const origin = new Map<number, string>();
  const tag = (inputs: Shape[], label: string) =>
    inputs.forEach((input, n) => {
      const modified = listShapes(oc, cut.Modified(input));
      const generated = listShapes(oc, cut.Generated(input));
      const kept = !cut.IsDeleted(input) && modified.length === 0;
      resultFaces.forEach((face, index) => {
        if (modified.some((m) => m.IsSame(face))) origin.set(index, `${label}${n}:modified`);
        else if (generated.some((g) => g.IsSame(face))) origin.set(index, `${label}${n}:generated`);
        else if (kept && input.IsSame(face)) origin.set(index, `${label}${n}:unchanged`);
      });
    });
  tag(subShapes(oc, plate, "TopAbs_FACE"), "plate-face");
  toolShapes.forEach((tool, n) => tag(subShapes(oc, tool, "TopAbs_FACE"), `tool${n}-face`));
  const classification: Record<string, number> = {};
  resultFaces.forEach((_, index) => {
    const kind = (origin.get(index) ?? "unknown").replace(/\d+/g, "#");
    classification[kind] = (classification[kind] ?? 0) + 1;
  });

  const t1 = NodePerfHooks.performance.now();
  const mesher = new oc.BRepMesh_IncrementalMesh(result, 0.05, false, 0.5, false);
  mesher.delete();
  let triangles = 0;
  for (const face of resultFaces) {
    const location = new oc.TopLoc_Location();
    const mesh = oc.BRep_Tool.Triangulation(oc.TopoDS.Face(face), location, 0);
    if (!mesh.isNull()) triangles += mesh.NbTriangles();
  }
  const meshMs = NodePerfHooks.performance.now() - t1;

  // STEP round trip through the Emscripten file system.
  const t2 = NodePerfHooks.performance.now();
  const writer = new oc.STEPControl_Writer();
  writer.Transfer(
    result,
    oc.STEPControl_StepModelType.STEPControl_AsIs,
    true,
    new oc.Message_ProgressRange(),
  );
  writer.Write("/plate.step");
  const stepBytes = oc.FS.readFile("/plate.step").byteLength;
  const reader = new oc.STEPControl_Reader();
  reader.ReadFile("/plate.step");
  reader.TransferRoots(new oc.Message_ProgressRange());
  const imported = reader.OneShape();
  const stepMs = NodePerfHooks.performance.now() - t2;

  return {
    booleanMs,
    meshMs,
    stepMs,
    volumeMm3: volume(oc, result),
    expectedVolumeMm3: 100 * 60 * 10 - 6 * Math.PI * 2.75 ** 2 * 10,
    faces: resultFaces.length,
    edges: subShapes(oc, result, "TopAbs_EDGE").length,
    vertices: subShapes(oc, result, "TopAbs_VERTEX").length,
    faceProvenance: classification,
    triangles,
    stepBytes,
    stepImport: {
      faces: subShapes(oc, imported, "TopAbs_FACE").length,
      volumeMm3: volume(oc, imported),
    },
  };
};

/** Deliberately slow: fuse many overlapping cylinders so the parent can terminate us mid-boolean. */
const heavy = (oc: Oc) => {
  let acc = new oc.BRepPrimAPI_MakeBox(200, 200, 10).Shape();
  for (let i = 0; i < 400; i++) {
    const axis = new oc.gp_Ax2(
      new oc.gp_Pnt(100 + 80 * Math.cos(i * 0.37), 100 + 80 * Math.sin(i * 0.53), -1),
      new oc.gp_Dir(0, 0.01 * (i % 7), 1),
    );
    const fuse = new oc.BRepAlgoAPI_Fuse(
      acc,
      new oc.BRepPrimAPI_MakeCylinder(axis, 6, 12).Shape(),
      new oc.Message_ProgressRange(),
    );
    acc = fuse.Shape();
    NodeWorkerThreads.parentPort?.postMessage({ progress: i });
  }
  return { done: true };
};

if (NodeWorkerThreads.isMainThread) {
  const require = NodeModule.createRequire(import.meta.url);
  const wasmPath = require.resolve("replicad-opencascadejs/wasm");
  const report: Record<string, unknown> = {};
  const rss = () => Math.round(process.memoryUsage().rss / 2 ** 20);
  report.rssStartMb = rss();

  const c0 = NodePerfHooks.performance.now();
  const module = await WebAssembly.compile(await NodeFSP.readFile(wasmPath));
  report.compileInParentMs = Math.round(NodePerfHooks.performance.now() - c0);

  const run = (job: Job, killAfterMs?: number) =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      const started = NodePerfHooks.performance.now();
      const worker = new NodeWorkerThreads.Worker(new URL(import.meta.url), {
        workerData: { module, job },
      });
      let progress = -1;
      let timer: NodeJS.Timeout | undefined;
      worker.on("message", (message: Record<string, unknown>) => {
        if (typeof message.progress === "number") {
          progress = message.progress;
          return;
        }
        if (message.ready && killAfterMs !== undefined)
          timer = setTimeout(() => {
            const t = NodePerfHooks.performance.now();
            void worker.terminate().then(() =>
              resolve({
                terminatedAfterProgress: progress,
                terminateMs: Math.round(NodePerfHooks.performance.now() - t),
              }),
            );
          }, killAfterMs);
        if (message.result) {
          clearTimeout(timer);
          resolve({
            ...(message.result as object),
            workerTotalMs: Math.round(NodePerfHooks.performance.now() - started),
            readyMs: message.readyMs,
          });
          void worker.terminate();
        }
      });
      worker.on("error", reject);
    });

  report.geometry = await run("geometry");
  report.rssAfterGeometryMb = rss();
  report.heavyKill = await run("heavy", 1500);
  report.rssAfterKillMb = rss();
  report.secondWorkerAfterKill = await run("geometry");
  report.rssEndMb = rss();
  console.log(JSON.stringify(report, null, 2));
} else {
  const { module, job } = NodeWorkerThreads.workerData as { module: WebAssembly.Module; job: Job };
  const r0 = NodePerfHooks.performance.now();
  const oc = await instantiate(module);
  const readyMs = Math.round(NodePerfHooks.performance.now() - r0);
  NodeWorkerThreads.parentPort?.postMessage({ ready: true });
  const result = job === "geometry" ? geometry(oc) : heavy(oc);
  NodeWorkerThreads.parentPort?.postMessage({ result, readyMs });
}
