// @effect-diagnostics nodeBuiltinImport:off
// The SolidWorks fixtures are generated with node:zlib, the same codec SolidWorks writes.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeZlib from "node:zlib";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  LocalCadError,
  OnshapeDocumentId,
  OnshapeProjectSource,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationProjectShell,
} from "@cadsense/contracts";
import { cadCommentModelDescriptor } from "@cadsense/shared/cadCommentIdentity";
import { assert, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { vi } from "vite-plus/test";
import { ServerConfig } from "../config.ts";
import { OrchestrationEngineLive } from "../orchestration/Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "../orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../orchestration/Layers/ProjectionSnapshotQuery.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ThreadBackgroundLiveness from "../orchestration/ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../orchestration/ThreadPlanProgress.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { OnshapeCadRoots } from "../onshape/OnshapeCadRoots.ts";
import { OnshapeSnapshotAcquisition } from "../onshape/OnshapeSnapshotAcquisition.ts";
import { CadDiskSpace, CadSnapshotStore, make as makeStore } from "../cad/CadSnapshotStore.ts";
import { CadPanel } from "../cad/CadPanel.ts";
import { pruneCadSnapshots } from "../cad/CadSnapshotRetention.ts";
import * as CadStorage from "../cad/CadStorage.ts";
import {
  CadProjectQuiescence,
  CadUserOperations,
  layer as cadUserOperationsLayer,
} from "../cad/CadUserOperations.ts";
import { ManagedWorkspaceAllocator } from "../workspace/ManagedWorkspaceAllocator.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import * as LocalCadImport from "./LocalCadImport.ts";
import { LocalCadProjects, layer as localCadProjectsLayer } from "./LocalCadProjects.ts";
import * as SolidWorksBridge from "./SolidWorksBridge.ts";
import { planSolidWorksFiles, readSolidWorksReferences } from "./SolidWorksFiles.ts";

const FIXTURE = new URL("./testFixtures/dm1-id-214.stp", import.meta.url).pathname;
const onshapeSource = Schema.decodeUnknownSync(OnshapeProjectSource)({
  connectionId: "00000000-0000-4000-8000-000000000001",
  host: "https://cad.onshape.com",
  documentId: "a".repeat(24),
  workspaceType: "w",
  workspaceId: "b".repeat(24),
  configuration: "",
});
const unused = () => Effect.die("Onshape is not used by local CAD projects");

const engine = Layer.mergeAll(
  OrchestrationEngineLive.pipe(
    Layer.provide(OrchestrationProjectionSnapshotQueryLive),
    Layer.provide(OrchestrationProjectionPipelineLive),
  ),
  OrchestrationProjectionSnapshotQueryLive,
).pipe(
  Layer.provideMerge(ThreadBackgroundLiveness.layer),
  Layer.provide(ThreadPlanProgress.layer),
  Layer.provide(OrchestrationEventStoreLive),
  Layer.provide(OrchestrationCommandReceiptRepositoryLive),
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "cadsense-local-cad-" })),
  Layer.provideMerge(NodeServices.layer),
);
const store = Layer.effect(CadSnapshotStore, makeStore).pipe(
  Layer.provide(Layer.succeed(CadDiskSpace, { availableBytes: () => Effect.succeed(10 ** 12) })),
);
const onshape = Layer.mergeAll(
  Layer.succeed(OnshapeCadRoots, { discover: unused }),
  Layer.succeed(OnshapeSnapshotAcquisition, { acquire: unused }),
  // Native agent shutdown is not under test; no agent runs exist here.
  Layer.succeed(CadProjectQuiescence, { confirm: () => Effect.void }),
);

// What the CAD panel does when a project is released, per project. Unset means no open viewer.
const panelReleases = new Map<ProjectId, Effect.Effect<void>>();
const panel = Layer.mergeAll(
  Layer.succeed(CadPanel, {
    watch: () => Stream.die("The CAD panel is not under test"),
    scene: () => Stream.die("The CAD panel is not under test"),
    read: unused,
    releaseProject: (projectId) => panelReleases.get(projectId) ?? Effect.void,
  }),
  Layer.succeed(ManagedWorkspaceAllocator, { provision: unused, remove: unused, resolve: unused }),
);
/** Everything but the SolidWorks host, which the two suites below choose. */
const withSolidWorks = <E, R>(solidWorks: Layer.Layer<SolidWorksBridge.SolidWorks, E, R>) =>
  Layer.mergeAll(localCadProjectsLayer, CadStorage.layer).pipe(
    Layer.provideMerge(panel),
    Layer.provideMerge(cadUserOperationsLayer),
    Layer.provideMerge(LocalCadImport.layer),
    Layer.provideMerge(solidWorks),
    Layer.provideMerge(store),
    Layer.provideMerge(onshape),
    Layer.provideMerge(WorkspacePaths.layer),
    Layer.provideMerge(engine),
  );
/** Every call the main suite makes to the real bridge: how many parts it skipped and exported. */
const bridgeCalls: { skipped: number; exported: number | null }[] = [];
// The real bridge, which finds SolidWorks on this machine or its Windows host when there is one.
const layer = withSolidWorks(
  Layer.effect(
    SolidWorksBridge.SolidWorks,
    Effect.gen(function* () {
      const real = yield* SolidWorksBridge.make();
      return SolidWorksBridge.SolidWorks.of({
        exportParts: (input) =>
          Effect.suspend(() => {
            const call = { skipped: input.skip.length, exported: null as number | null };
            bridgeCalls.push(call);
            return real.exportParts(input).pipe(
              Effect.tap((result) =>
                Effect.sync(() => {
                  call.exported = result.parts.size;
                }),
              ),
            );
          }),
      });
    }),
  ),
);
// The real bridge on a machine without Windows, so without SolidWorks.
const noSolidWorksLayer = withSolidWorks(
  Layer.effect(SolidWorksBridge.SolidWorks, SolidWorksBridge.make({ host: null })),
);

/**
 * A stand-in for the PowerShell bridge, for races only a scripted bridge can order. It takes the
 * same arguments and job folder and writes the same result, a dm1 export for any file. A file
 * named `Hold...` waits for `control/release` and ignores cancel. Like the real bridge, it attaches
 * to a running SolidWorks or starts one that Cadsense then owns (its pid is in `control/solidworks`),
 * and quit mode stops that one. Every run appends to `control/log`, and every conversion request to
 * `control/requests`. Each file has the configurations Default (active) and Large, and one part of
 * Alloy Steel weighing 0.25 kg, keyed by name and configuration and left out when skipped.
 */
const SCRIPTED_BRIDGE = `
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const args = process.argv.slice(2);
const job = args[args.indexOf("-Job") + 1].split("\\\\").join("/");
const control = path.join(path.dirname(job), "control");
const log = (line) => fs.appendFileSync(path.join(control, "log"), line + "\\n");
const request = JSON.parse(fs.readFileSync(path.join(job, "request.json"), "utf8"));
const state = path.join(control, "solidworks");
const running = () => (fs.existsSync(state) ? Number(fs.readFileSync(state, "utf8")) : 0);
if (request.mode === "quit") {
  if (running() === request.ownedPid) {
    fs.rmSync(state);
    log("quit " + request.ownedPid);
  }
  process.exit(0);
}
const name = path.basename(request.file.split("\\\\").join("/"));
fs.appendFileSync(path.join(control, "requests"), JSON.stringify(request) + "\\n");
log("start " + name + " owned=" + request.ownedPid);
let pid = running();
let owned = pid !== 0 && pid === request.ownedPid;
if (pid === 0) {
  pid = 4242;
  owned = true;
  fs.writeFileSync(state, String(pid));
}
const pause = new Int32Array(new SharedArrayBuffer(4));
const until = Date.now() + 60000;
if (name.startsWith("Hold"))
  while (
    fs.existsSync(control) &&
    !fs.existsSync(path.join(control, "release")) &&
    Date.now() < until
  )
    Atomics.wait(pause, 0, 0, 50);
// The suite removed its folder while this bridge waited (a test failed): leave nothing behind.
if (!fs.existsSync(control)) process.exit(0);
const configurations = ["Default", "Large"];
const configuration =
  (request.configuration ?? "default") === "default" ? "Default" : request.configuration;
const write = (result) =>
  fs.writeFileSync(path.join(job, "result.json"), JSON.stringify({ pid, owned, ...result }));
if (!configurations.includes(configuration)) {
  write({ ok: false, reason: "no-configuration", detail: configuration, names: configurations });
  log("exit " + name);
  process.exit(0);
}
const key = crypto.createHash("sha256").update(name + "|" + configuration).digest("hex");
const skipped = request.skip.includes(key);
fs.mkdirSync(path.join(job, "out"), { recursive: true });
if (!skipped) fs.copyFileSync(${JSON.stringify(FIXTURE)}, path.join(job, "out", "0.step"));
const root = { name, kind: "part", configuration, suppressed: false, visible: true };
write({
  ok: true,
  warnings: [],
  root: { ...root, transform: null, key, children: [] },
  parts: skipped
    ? {}
    : { [key]: { name, step: "out\\\\0.step", material: "Alloy Steel", massKg: 0.25 } },
});
log("exit " + name);
`;
/** The scripted bridge's folder: its job folders and `control`. Set when the suite's layer builds. */
let scriptedRoot = "";

/**
 * Holds a SolidWorks job's first `mkdir` (its `in` folder) until `release`, so a test can cancel
 * while the job's files are being staged and its folder does not exist yet.
 */
const staging = vi.hoisted(() => ({
  hold: null as Promise<void> | null,
  held: false,
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    mkdir: async (...args: Parameters<typeof actual.mkdir>) => {
      if (staging.hold && /[\\/]in$/.test(String(args[0]))) {
        staging.held = true;
        await staging.hold;
      }
      return actual.mkdir(...args);
    },
  };
});
const scriptedLayer = withSolidWorks(
  Layer.effect(
    SolidWorksBridge.SolidWorks,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      scriptedRoot = yield* fs.makeTempDirectoryScoped({ prefix: "cadsense-scripted-bridge-" });
      yield* fs.makeDirectory(NodePath.join(scriptedRoot, "control"));
      const bridge = NodePath.join(scriptedRoot, "bridge.cjs");
      yield* fs.writeFileString(bridge, `#!${process.execPath}\n${SCRIPTED_BRIDGE}`, {
        mode: 0o755,
      });
      return yield* SolidWorksBridge.make({
        host: { powershell: bridge, windowsRoot: scriptedRoot, serverRoot: scriptedRoot },
        cancelGrace: "300 millis",
      });
    }),
  ),
);
const scriptedLog = () => {
  const file = NodePath.join(scriptedRoot, "control/log");
  return NodeFS.existsSync(file) ? NodeFS.readFileSync(file, "utf8").trim().split("\n") : [];
};
const scriptedJobs = () =>
  NodeFS.readdirSync(scriptedRoot).filter((name) => /^[0-9a-f-]{36}$/.test(name));
const decodeScriptedRequest = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({ configuration: Schema.String, skip: Schema.Array(Schema.String) }),
  ),
);
/** The conversion requests the scripted bridge received, oldest first. */
const scriptedRequests = () => {
  const file = NodePath.join(scriptedRoot, "control/requests");
  return NodeFS.existsSync(file)
    ? NodeFS.readFileSync(file, "utf8")
        .trim()
        .split("\n")
        .map((line) => decodeScriptedRequest(line))
    : [];
};
/** Waits up to 20 seconds for the scripted bridge to log `line`. */
const scriptedLogged = Effect.fn(function* (line: string) {
  for (let attempt = 0; !scriptedLog().includes(line); attempt++) {
    if (attempt > 400) return yield* Effect.die(`The scripted bridge never logged "${line}"`);
    yield* Effect.sleep("50 millis");
  }
});
/** A folder holding one generated SolidWorks part called `name`. */
const makePartFolder = Effect.fn(function* (name: string) {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "cadsense-local-cad-scripted-" });
  yield* fs.writeFile(NodePath.join(root, name), solidWorksFile({ "Contents/Config-0": "part" }));
  return root;
});
/**
 * A SolidWorks 2015+ file: one raw-DEFLATE block per entry, each behind the 26-byte header and
 * nibble-swapped name SolidWorks writes. Enough for the reader, which only needs the file list.
 */
const solidWorksFile = (blocks: Readonly<Record<string, string>>) =>
  Buffer.concat(
    Object.entries(blocks).flatMap(([name, text]) => {
      const plain = Buffer.from(text, "utf8");
      const packed = NodeZlib.deflateRawSync(plain);
      const header = Buffer.alloc(26);
      header.set([0x14, 0x00, 0x06, 0x00, 0x08, 0x00]);
      header.writeUInt32LE(NodeZlib.crc32(plain), 10);
      header.writeUInt32LE(packed.length, 14);
      header.writeUInt32LE(plain.length, 18);
      header.writeUInt32LE(name.length, 22);
      const swapped = Buffer.from(name, "latin1").map((byte) => ((byte >> 4) | (byte << 4)) & 0xff);
      return [header, swapped, packed];
    }),
  );

/** An assembly's file list: the assembly first, then the parts it uses, as SolidWorks saves it. */
const fileList = (assembly: string, parts: readonly string[]) =>
  `<?xml version="1.0" encoding="UTF-8"?><swSolidWorks><swHeader>${[assembly, ...parts]
    .map(
      (path, index) =>
        `<swFile id="f${index}" swDocType="${index === 0 ? "ASSEMBLY" : "PART"}" swPath="${path}"/>`,
    )
    .join(
      "",
    )}</swHeader><swModelList><swModel id="m0" swFileRef="f0"/></swModelList><swConfigurationList><swConfiguration id="c0" swModelRef="m0"/></swConfigurationList></swSolidWorks>`;

/**
 * A file list with component references, like `patterndrivencomponentpattern.sldasm` in the
 * SolidWorks samples. Virtual components are saved inside the assembly, listed under a `VC~~`
 * temp path, and every reference to one says `swIsVirtualComponent="YES"`. `Arm.SLDASM` uses a
 * virtual Housing, a virtual Joint subassembly holding the real Hinge pin (missing), and the real
 * Bracket. `Pattern.SLDASM` uses only a virtual part.
 */
const virtualTree = {
  arm: `<?xml version="1.0" encoding="UTF-8"?><swSolidWorks><swHeader>
<swFile id="f0" swDocType="ASSEMBLY" swPath="H:\\Robot\\Arm.SLDASM"/>
<swFile id="f1" swDocType="PART" swPath="C:\\Temp\\swx7\\VC~~\\Arm\\Housing^Arm.SLDPRT"/>
<swFile id="f2" swDocType="ASSEMBLY" swPath="C:\\Temp\\swx7\\VC~~\\Arm\\Joint^Arm.SLDASM"/>
<swFile id="f3" swDocType="PART" swPath="H:\\Robot\\Bracket.SLDPRT"/>
<swFile id="f4" swDocType="PART" swPath="H:\\Robot\\Hinge pin.SLDPRT"/>
</swHeader><swModelList>
<swModel id="m1" swFileRef="f1"/><swModel id="m3" swFileRef="f3"/><swModel id="m4" swFileRef="f4"/>
<swModel id="m2" swFileRef="f2"><swReference id="r4" swIsVirtualComponent="NO" swModelRef="m4"/></swModel>
<swModel id="m0" swFileRef="f0"><swReference id="r1" swIsVirtualComponent="YES" swModelRef="m1"/>
<swReference id="r2" swIsVirtualComponent="YES" swModelRef="m2"/>
<swReference id="r3" swIsVirtualComponent="NO" swModelRef="m3"/></swModel>
</swModelList><swConfigurationList><swConfiguration id="c0" swModelRef="m0"/></swConfigurationList></swSolidWorks>`,
  pattern: `<?xml version="1.0" encoding="UTF-8"?><swSolidWorks><swHeader>
<swFile id="f0" swDocType="ASSEMBLY" swPath="H:\\Robot\\Pattern.SLDASM"/>
<swFile id="f1" swDocType="PART" swPath="C:\\Temp\\swx7\\VC~~\\Pattern\\Tooth^Pattern.SLDPRT"/>
</swHeader><swModelList><swModel id="m1" swFileRef="f1"/>
<swModel id="m0" swFileRef="f0"><swReference id="r1" swIsVirtualComponent="YES" swModelRef="m1"/></swModel>
</swModelList><swConfigurationList><swConfiguration id="c0" swModelRef="m0"/></swConfigurationList></swSolidWorks>`,
};

/**
 * A folder of generated SolidWorks files. `Frame v2.SLDASM` was saved as `Frame.SLDASM` and uses
 * Bracket (beside it), Plate (missing), and a 3D Interconnect STEP insert. `Panel.SLDASM` uses only
 * Bracket. `Legacy.SLDASM` has no file list, like a pre-2015 file. `Arm.SLDASM` and
 * `Pattern.SLDASM` use virtual components (see `virtualTree`).
 */
const makeSolidWorksFolder = Effect.fn(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "cadsense-local-cad-solidworks-" });
  yield* fs.makeDirectory(path.join(root, "cad"), { recursive: true });
  const write = (name: string, bytes: Uint8Array) => fs.writeFile(path.join(root, name), bytes);
  yield* write(
    "cad/Frame v2.SLDASM",
    solidWorksFile({
      PreviewPNG: "not a png",
      "swXmlContents/COMPINSTANCETREE": fileList("H:\\Robot\\Frame.SLDASM", [
        "H:\\Robot\\Bracket.SLDPRT",
        "H:\\Robot\\Plate &amp; Rib.SLDPRT",
        "C:\\Users\\me\\AppData\\Local\\Temp\\swx42\\IC~~\\Vendor Bolt.STEP.SLDPRT",
      ]),
    }),
  );
  yield* write(
    "cad/Panel.SLDASM",
    solidWorksFile({
      "swXmlContents/COMPINSTANCETREE": fileList("H:\\Robot\\Panel.SLDASM", [
        "H:\\Robot\\BRACKET.sldprt",
      ]),
    }),
  );
  yield* write("cad/Bracket.SLDPRT", solidWorksFile({ "Contents/Config-0-Partition": "part" }));
  yield* write("cad/Legacy.SLDASM", new TextEncoder().encode("not a 2015 or later file"));
  yield* write(
    "cad/Arm.SLDASM",
    solidWorksFile({ "swXmlContents/COMPINSTANCETREE": virtualTree.arm }),
  );
  yield* write(
    "cad/Pattern.SLDASM",
    solidWorksFile({ "swXmlContents/COMPINSTANCETREE": virtualTree.pattern }),
  );
  yield* write(
    "cad/Rig.SLDASM",
    solidWorksFile({
      "swXmlContents/COMPINSTANCETREE": fileList(
        "H:\\Robot\\Rig.SLDASM",
        Array.from(
          { length: 8 },
          (_, index) => `H:\\Robot\\Vendor bracket with a long name ${index}.SLDPRT`,
        ),
      ),
    }),
  );
  return root;
});
/**
 * A folder with the fixture under models/, a corrupt STEP file, a text file, and STEP files in
 * directories the scan must skip.
 */
const makeFolder = Effect.fn(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "cadsense-local-cad-folder-" });
  for (const dir of ["models", "parts", "node_modules/pkg", ".git"])
    yield* fs.makeDirectory(path.join(root, dir), { recursive: true });
  yield* fs.copyFile(FIXTURE, path.join(root, "models/dm1.step"));
  yield* fs.writeFileString(path.join(root, "parts/broken.STP"), "ISO-10303-21;\nnot a model\n");
  yield* fs.writeFileString(path.join(root, "notes.txt"), "not CAD");
  yield* fs.copyFile(FIXTURE, path.join(root, "node_modules/pkg/vendored.step"));
  yield* fs.copyFile(FIXTURE, path.join(root, ".git/object.step"));
  return root;
});

const decodeGltf = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      accessors: Schema.Array(
        Schema.Struct({ bufferView: Schema.Number, count: Schema.Number, type: Schema.String }),
      ),
      bufferViews: Schema.Array(Schema.Struct({ byteOffset: Schema.Number })),
      meshes: Schema.Array(
        Schema.Struct({
          primitives: Schema.Array(
            Schema.Struct({
              attributes: Schema.Struct({ POSITION: Schema.Number }),
              indices: Schema.Number,
            }),
          ),
        }),
      ),
    }),
  ),
);
/**
 * The volume a part's closed mesh encloses, in cubic meters, summed over its triangles by the
 * divergence theorem. Reads the GLB a local import stores: float positions, uint32 indices.
 */
const meshVolume = (glb: Uint8Array) => {
  const jsonLength = new DataView(glb.buffer, glb.byteOffset).getUint32(12, true);
  const gltf = decodeGltf(new TextDecoder().decode(glb.subarray(20, 20 + jsonLength)));
  // A copy: a Buffer's `slice` is a view, whose `buffer` is the whole pool.
  const bin = new Uint8Array(glb.subarray(28 + jsonLength));
  const read = <T>(index: number, make: (buffer: ArrayBuffer) => T) => {
    const accessor = gltf.accessors[index]!;
    const start = gltf.bufferViews[accessor.bufferView]!.byteOffset;
    return make(
      bin.slice(start, start + accessor.count * (accessor.type === "VEC3" ? 12 : 4)).buffer,
    );
  };
  let volume = 0;
  for (const primitive of gltf.meshes.flatMap((mesh) => mesh.primitives)) {
    const p = read(primitive.attributes.POSITION, (buffer) => new Float32Array(buffer));
    const index = read(primitive.indices, (buffer) => new Uint32Array(buffer));
    for (let i = 0; i < index.length; i += 3) {
      const [a, b, c] = [index[i]! * 3, index[i + 1]! * 3, index[i + 2]! * 3];
      volume +=
        (p[a]! * (p[b + 1]! * p[c + 2]! - p[b + 2]! * p[c + 1]!) -
          p[a + 1]! * (p[b]! * p[c + 2]! - p[b + 2]! * p[c]!) +
          p[a + 2]! * (p[b]! * p[c + 1]! - p[b + 1]! * p[c]!)) /
        6;
    }
  }
  return Math.abs(volume);
};
/** Densities in kg/m³ from the SolidWorks Materials library, for the materials samples use. */
const LIBRARY_DENSITY: Readonly<Record<string, number>> = {
  "Alloy Steel": 7700,
  "Plain Carbon Steel": 7800,
};

const getProject = Effect.fn(function* (projectId: ProjectId) {
  const query = yield* ProjectionSnapshotQuery;
  return Option.getOrThrow(yield* query.getProjectShellById(projectId));
});

/**
 * Waits for the project's CAD operation to end; `operationId` pins which one when known. Up to
 * ten minutes, since a SolidWorks conversion includes starting SolidWorks.
 */
const settle = Effect.fn(function* (projectId: ProjectId, operationId?: string) {
  for (let attempt = 0; attempt < 12_000; attempt++) {
    const project = yield* getProject(projectId);
    const outcome = project.cad?.lastOutcome;
    if (
      !project.cad?.operation &&
      outcome &&
      (operationId === undefined || outcome.operationId === operationId)
    )
      return project;
    yield* Effect.sleep("50 millis");
  }
  return yield* Effect.die("CAD operation did not settle");
});

const catalogRoot = (project: OrchestrationProjectShell, name: string) => {
  const root = project.cad?.catalog?.roots.find((entry) => entry.name === name);
  assert.isDefined(root, `catalog has ${name}`);
  return root!;
};

/** Syncs the catalog file `name` in `configuration`, as project settings and the panel do. */
const sync = Effect.fn(function* (
  project: OrchestrationProjectShell,
  name: string,
  configuration = "default",
) {
  const operations = yield* CadUserOperations;
  const root = catalogRoot(project, name);
  const { operationId } = yield* operations.start({
    projectId: project.id,
    kind: "sync",
    root: { elementId: root.elementId, kind: root.kind, configuration },
  });
  return yield* settle(project.id, operationId);
});

const createError = Effect.fn(function* (workspaceRoot: string, filePath: string) {
  const projects = yield* LocalCadProjects;
  const error = yield* Effect.flip(
    projects.create({
      projectId: ProjectId.make(`local-cad-rejected-${filePath.length}`),
      title: "Rejected",
      workspaceRoot,
      filePath,
    }),
  );
  assert.instanceOf(error, LocalCadError);
  return error.reason;
});

/** A folder project with no CAD linked, as the CAD panel's file prompt sees it. */
const makeFolderProject = Effect.fn(function* (projectId: ProjectId, workspaceRoot: string) {
  yield* (yield* OrchestrationEngineService).dispatch({
    type: "project.create",
    commandId: CommandId.make(`create-${projectId}`),
    projectId,
    title: "Folder",
    workspaceRoot,
    createdAt: DateTime.formatIso(yield* DateTime.now),
  });
});

/** Starts or ends an agent run in a new thread of `projectId`, as the provider runtime reports it. */
const setAgentRun = Effect.fn(function* (
  projectId: ProjectId,
  threadId: ThreadId,
  status: "running" | "ready",
) {
  const engine = yield* OrchestrationEngineService;
  const createdAt = DateTime.formatIso(yield* DateTime.now);
  if (status === "running")
    yield* engine.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`create-${threadId}`),
      threadId,
      projectId,
      title: "Agent",
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "test" },
      runtimeMode: "full-access",
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      createdAt,
    });
  yield* engine.dispatch({
    type: "thread.session.set",
    commandId: CommandId.make(`session-${threadId}-${status}`),
    threadId,
    session: {
      threadId,
      status,
      providerName: "codex",
      runtimeMode: "full-access",
      activeTurnId: status === "running" ? TurnId.make(`turn-${threadId}`) : null,
      lastError: null,
      updatedAt: createdAt,
    },
    createdAt,
  });
});

const setFileError = Effect.fn(function* (projectId: ProjectId, filePath: string) {
  const error = yield* Effect.flip((yield* LocalCadProjects).setFile({ projectId, filePath }));
  assert.instanceOf(error, LocalCadError);
  return error.reason;
});

/** IDs of the snapshots the store holds for `projectId`. */
const owned = Effect.fn(function* (projectId: ProjectId) {
  return (yield* (yield* CadSnapshotStore).list())
    .filter((entry) => entry.projectId === projectId)
    .map((entry) => entry.snapshotId);
});

/** The CAD storage entry of a removed project. */
const retained = Effect.fn(function* (projectId: ProjectId) {
  const entries = yield* (yield* CadStorage.CadStorage).watch.pipe(Stream.runHead);
  const entry = Option.getOrThrow(entries).find((item) => item.projectId === projectId);
  assert.isDefined(entry, `${projectId} is retained`);
  return entry!;
});

// Real clock: imports run in a worker thread and the tests poll for their outcome.
it.layer(layer, { timeout: 120_000, excludeTestServices: true })("local CAD projects", (it) => {
  it.effect("lists only STEP and IGES files outside skipped directories", () =>
    Effect.gen(function* () {
      const root = yield* makeFolder();
      const result = yield* (yield* LocalCadProjects).listFiles({ workspaceRoot: root });
      assert.deepStrictEqual(
        result.files.map((file) => file.path),
        ["models/dm1.step", "parts/broken.STP"],
      );
      assert.strictEqual(result.truncated, false);
      assert.isAbove(result.files[0]!.byteLength, 80_000);
    }).pipe(Effect.scoped),
  );

  it.effect("creates a project and imports the chosen file with its assembly structure", () =>
    Effect.gen(function* () {
      const root = yield* makeFolder();
      const projectId = ProjectId.make("local-cad-create");
      const created = yield* (yield* LocalCadProjects).create({
        projectId,
        title: "Bracket",
        workspaceRoot: root,
        filePath: "models/dm1.step",
      });
      assert.strictEqual(created.projectId, projectId);

      const project = yield* settle(projectId);
      assert.deepStrictEqual(project.localCadSource, { filePath: "models/dm1.step" });
      assert.strictEqual(project.onshapeSource, undefined);
      assert.strictEqual(project.cad?.lastOutcome?.status, "succeeded");
      // The sync rescanned the folder, so other files are selectable without a refresh.
      assert.deepStrictEqual(
        project.cad?.catalog?.roots.map((entry) => entry.name),
        ["models/dm1.step", "parts/broken.STP"],
      );
      assert.strictEqual(
        project.cad?.catalog?.sourceElement?.elementId,
        catalogRoot(project, "models/dm1.step").elementId,
      );
      const synced = project.cad?.roots ?? [];
      assert.strictEqual(synced.length, 1);
      assert.isNotNull(synced[0]!.current);

      const manifest = yield* (yield* CadSnapshotStore).load(synced[0]!.current!.snapshotId);
      assert.strictEqual(manifest.root.host, "local");
      assert.strictEqual(manifest.parts.length, 7);
      assert.strictEqual(manifest.assets.length, 7);
      const names = manifest.nodes.map((node) => node.occurrencePath.at(-1) ?? node.name).sort();
      assert.deepStrictEqual(names, [
        "bolt",
        "bolt#2",
        "bolt#3",
        "dm1",
        "dm1.step",
        "l-bracket",
        "nut",
        "nut#2",
        "nut#3",
      ]);
      // Parts carry the STEP product name and color for the hierarchy and find-parts.
      const bolt = manifest.parts.find((part) => part.metadata?.name === "bolt");
      assert.isDefined(bolt);
      assert.isNotNull(bolt!.metadata?.appearance ?? null);
    }).pipe(Effect.scoped),
  );

  it.effect(
    "keeps the comment revision for an unchanged file and node IDs across a re-export",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const snapshots = yield* CadSnapshotStore;
        const root = yield* makeFolder();
        const projectId = ProjectId.make("local-cad-resync");
        yield* (yield* LocalCadProjects).create({
          projectId,
          title: "Bracket",
          workspaceRoot: root,
          filePath: "models/dm1.step",
        });
        const first = yield* settle(projectId);
        const firstManifest = yield* snapshots.load(first.cad!.roots[0]!.current!.snapshotId);

        const unchanged = yield* sync(first, "models/dm1.step");
        const unchangedRoot = unchanged.cad!.roots[0]!;
        assert.notStrictEqual(unchangedRoot.current!.snapshotId, firstManifest.snapshotId);
        assert.strictEqual(unchangedRoot.rollback?.snapshotId, firstManifest.snapshotId);
        const unchangedManifest = yield* snapshots.load(unchangedRoot.current!.snapshotId);
        assert.strictEqual(
          cadCommentModelDescriptor(unchangedManifest),
          cadCommentModelDescriptor(firstManifest),
        );

        // A re-export with a new header timestamp is a new revision of the same structure.
        const file = path.join(root, "models/dm1.step");
        const text = yield* fs.readFileString(file);
        yield* fs.writeFileString(file, text.replace("FILE_NAME(", "FILE_NAME( /* re-export */ "));
        const changed = yield* sync(unchanged, "models/dm1.step");
        const changedManifest = yield* snapshots.load(changed.cad!.roots[0]!.current!.snapshotId);
        assert.notStrictEqual(
          changedManifest.root.microversionId,
          firstManifest.root.microversionId,
        );
        assert.strictEqual(changedManifest.rootId, firstManifest.rootId);
        assert.deepStrictEqual(
          changedManifest.nodes.map((node) => node.id).sort(),
          firstManifest.nodes.map((node) => node.id).sort(),
        );
      }).pipe(Effect.scoped),
  );

  it.effect("fails a corrupt or missing file without touching the current snapshot", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* makeFolder();
      const projectId = ProjectId.make("local-cad-failures");
      yield* (yield* LocalCadProjects).create({
        projectId,
        title: "Bracket",
        workspaceRoot: root,
        filePath: "models/dm1.step",
      });
      const ready = yield* settle(projectId);
      const current = ready.cad!.roots[0]!.current!.snapshotId;

      const corrupt = yield* sync(ready, "parts/broken.STP");
      assert.strictEqual(corrupt.cad?.lastOutcome?.status, "failed");
      assert.match(corrupt.cad?.lastOutcome?.reason ?? "", /could not read/i);
      const brokenRoot = corrupt.cad!.roots.find(
        (entry) => entry.elementId === catalogRoot(ready, "parts/broken.STP").elementId,
      );
      assert.strictEqual(brokenRoot?.current, null);

      yield* fs.remove(path.join(root, "models/dm1.step"));
      const missing = yield* sync(corrupt, "models/dm1.step");
      assert.strictEqual(missing.cad?.lastOutcome?.status, "failed");
      assert.match(missing.cad?.lastOutcome?.reason ?? "", /no longer in the project folder/i);
      assert.strictEqual(missing.cad!.roots[0]!.current?.snapshotId, current);
    }).pipe(Effect.scoped),
  );

  it.effect("lists the folder after a failed first import so another file can be chosen", () =>
    Effect.gen(function* () {
      const root = yield* makeFolder();
      const projectId = ProjectId.make("local-cad-failed-first-import");
      yield* (yield* LocalCadProjects).create({
        projectId,
        title: "Broken",
        workspaceRoot: root,
        filePath: "parts/broken.STP",
      });
      const failed = yield* settle(projectId);
      assert.strictEqual(failed.cad?.lastOutcome?.status, "failed");
      assert.strictEqual(failed.cad?.roots[0]?.current, null);
      assert.strictEqual(
        failed.cad?.catalog?.sourceElement?.elementId,
        catalogRoot(failed, "parts/broken.STP").elementId,
      );
      const recovered = yield* sync(failed, "models/dm1.step");
      assert.strictEqual(recovered.cad?.lastOutcome?.status, "succeeded");
    }).pipe(Effect.scoped),
  );

  it.effect("rejects paths outside the folder, unsupported files, and missing files", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* makeFolder();
      const outside = yield* fs.makeTempDirectoryScoped({ prefix: "cadsense-local-cad-outside-" });
      yield* fs.copyFile(FIXTURE, path.join(outside, "outside.step"));
      yield* fs.symlink(path.join(outside, "outside.step"), path.join(root, "models/link.step"));

      assert.strictEqual(yield* createError(root, "../outside.step"), "outside-folder");
      assert.strictEqual(
        yield* createError(root, path.join(outside, "outside.step")),
        "outside-folder",
      );
      assert.strictEqual(yield* createError(root, "models/link.step"), "outside-folder");
      assert.strictEqual(yield* createError(root, "notes.txt"), "unsupported-file");
      assert.strictEqual(yield* createError(root, "models/missing.step"), "file-not-found");
      assert.strictEqual(yield* createError(path.join(root, "nope"), "a.step"), "folder-not-found");
      const projects = yield* (yield* ProjectionSnapshotQuery).getCommandReadModel();
      assert.isFalse(projects.projects.some((project) => project.title === "Rejected"));
    }).pipe(Effect.scoped),
  );

  it.effect("attaches to an existing folder project and rejects Onshape folders", () =>
    Effect.gen(function* () {
      const engineService = yield* OrchestrationEngineService;
      const root = yield* makeFolder();
      const folderProjectId = ProjectId.make("local-cad-existing-folder");
      yield* engineService.dispatch({
        type: "project.create",
        commandId: CommandId.make("local-cad-existing-folder"),
        projectId: folderProjectId,
        title: "Existing",
        workspaceRoot: root,
        createdAt: DateTime.formatIso(yield* DateTime.now),
      });
      const attached = yield* (yield* LocalCadProjects).create({
        projectId: ProjectId.make("local-cad-would-duplicate"),
        title: "Duplicate",
        workspaceRoot: root,
        filePath: "models/dm1.step",
      });
      assert.strictEqual(attached.projectId, folderProjectId);
      const project = yield* settle(folderProjectId);
      assert.strictEqual(project.title, "Existing");
      assert.deepStrictEqual(project.localCadSource, { filePath: "models/dm1.step" });
      assert.strictEqual(project.cad?.lastOutcome?.status, "succeeded");

      const onshapeRoot = yield* makeFolder();
      yield* engineService.dispatch({
        type: "project.onshape.create",
        commandId: CommandId.make("local-cad-onshape-folder"),
        projectId: ProjectId.make("local-cad-onshape-folder"),
        title: "Onshape",
        workspaceRoot: onshapeRoot,
        defaultModelSelection: null,
        onshapeSource,
        createdAt: DateTime.formatIso(yield* DateTime.now),
      });
      assert.strictEqual(yield* createError(onshapeRoot, "models/dm1.step"), "onshape-project");
    }).pipe(Effect.scoped),
  );

  it.effect("links a natively picked absolute path in a plain folder project and imports it", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const root = yield* makeFolder();
      const projectId = ProjectId.make("local-cad-set-file-absolute");
      yield* makeFolderProject(projectId, root);
      assert.strictEqual((yield* getProject(projectId)).localCadSource, undefined);

      const result = yield* (yield* LocalCadProjects).setFile({
        projectId,
        filePath: path.join(root, "models/dm1.step"),
      });
      assert.strictEqual(result.projectId, projectId);
      const project = yield* settle(projectId);
      // Stored workspace-relative, so the project survives the folder moving.
      assert.deepStrictEqual(project.localCadSource, { filePath: "models/dm1.step" });
      assert.strictEqual(project.cad?.lastOutcome?.status, "succeeded");
      assert.isNotNull(project.cad?.roots[0]?.current ?? null);
    }).pipe(Effect.scoped),
  );

  it.effect("refuses to link a plain folder's first file while its agent runs", () =>
    Effect.gen(function* () {
      const root = yield* makeFolder();
      const projectId = ProjectId.make("local-cad-first-link-busy");
      const threadId = ThreadId.make("local-cad-first-link-busy-agent");
      yield* makeFolderProject(projectId, root);
      yield* setAgentRun(projectId, threadId, "running");
      // A run in another project does not block this one.
      const otherProjectId = ProjectId.make("local-cad-first-link-other");
      yield* makeFolderProject(otherProjectId, yield* makeFolder());
      yield* setAgentRun(
        otherProjectId,
        ThreadId.make("local-cad-first-link-other-agent"),
        "running",
      );

      assert.strictEqual(yield* setFileError(projectId, "models/dm1.step"), "busy");
      // Nothing was linked, so the panel still offers the file prompt.
      assert.strictEqual((yield* getProject(projectId)).localCadSource, undefined);

      yield* setAgentRun(projectId, threadId, "ready");
      yield* (yield* LocalCadProjects).setFile({ projectId, filePath: "models/dm1.step" });
      const project = yield* settle(projectId);
      assert.deepStrictEqual(project.localCadSource, { filePath: "models/dm1.step" });
      assert.strictEqual(project.cad?.lastOutcome?.status, "succeeded");
    }).pipe(Effect.scoped),
  );

  it.effect("switches a linked project to another picked file", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* makeFolder();
      yield* fs.copyFile(FIXTURE, path.join(root, "parts/second.stp"));
      const projectId = ProjectId.make("local-cad-set-file-switch");
      yield* (yield* LocalCadProjects).create({
        projectId,
        title: "Bracket",
        workspaceRoot: root,
        filePath: "models/dm1.step",
      });
      const first = yield* settle(projectId);

      yield* (yield* LocalCadProjects).setFile({ projectId, filePath: "parts/second.stp" });
      const project = yield* settle(projectId);
      assert.notStrictEqual(
        project.cad?.lastOutcome?.operationId,
        first.cad?.lastOutcome?.operationId,
      );
      assert.deepStrictEqual(project.localCadSource, { filePath: "parts/second.stp" });
      assert.strictEqual(project.cad?.lastOutcome?.status, "succeeded");
      assert.strictEqual(
        project.cad?.catalog?.sourceElement?.elementId,
        catalogRoot(project, "parts/second.stp").elementId,
      );
      assert.strictEqual(project.cad?.roots.length, 2);
    }).pipe(Effect.scoped),
  );

  it.effect("rejects picked files outside the folder, non-CAD files, and non-folder projects", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const engineService = yield* OrchestrationEngineService;
      const root = yield* makeFolder();
      const outside = yield* fs.makeTempDirectoryScoped({ prefix: "cadsense-local-cad-outside-" });
      yield* fs.copyFile(FIXTURE, path.join(outside, "outside.step"));
      yield* fs.symlink(path.join(outside, "outside.step"), path.join(root, "models/link.step"));
      const projectId = ProjectId.make("local-cad-set-file-rejected");
      yield* makeFolderProject(projectId, root);

      assert.strictEqual(
        yield* setFileError(projectId, path.join(outside, "outside.step")),
        "outside-folder",
      );
      assert.strictEqual(
        yield* setFileError(projectId, path.join(root, "models/link.step")),
        "outside-folder",
      );
      assert.strictEqual(
        yield* setFileError(projectId, path.join(root, "notes.txt")),
        "unsupported-file",
      );
      assert.strictEqual(
        yield* setFileError(ProjectId.make("local-cad-no-such-project"), "models/dm1.step"),
        "project-not-found",
      );
      assert.strictEqual((yield* getProject(projectId)).localCadSource, undefined);

      const onshapeProjectId = ProjectId.make("local-cad-set-file-onshape");
      yield* engineService.dispatch({
        type: "project.onshape.create",
        commandId: CommandId.make("local-cad-set-file-onshape"),
        projectId: onshapeProjectId,
        title: "Onshape",
        workspaceRoot: yield* makeFolder(),
        defaultModelSelection: null,
        // A second document: the first Onshape test project still owns `onshapeSource`.
        onshapeSource: { ...onshapeSource, documentId: OnshapeDocumentId.make("c".repeat(24)) },
        createdAt: DateTime.formatIso(yield* DateTime.now),
      });
      assert.strictEqual(
        yield* setFileError(onshapeProjectId, "models/dm1.step"),
        "onshape-project",
      );
    }).pipe(Effect.scoped),
  );

  // Removal keeps the threads and, unless the user deletes it, the imported CAD. The folder is the
  // user's, so restore needs no managed workspace: provisioning one dies in this layer.
  it.effect("keeps a removed local CAD project's threads and imported CAD, and restores it", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const storage = yield* CadStorage.CadStorage;
      const query = yield* ProjectionSnapshotQuery;
      const root = yield* makeFolder();
      const projectId = ProjectId.make("local-cad-retain");
      const threadId = ThreadId.make("local-cad-retain-thread");
      yield* (yield* LocalCadProjects).create({
        projectId,
        title: "Bracket",
        workspaceRoot: root,
        filePath: "models/dm1.step",
      });
      const roots = (yield* settle(projectId)).cad!.roots;
      const keep = {
        kind: "remove",
        projectId,
        deleteCad: false,
        deleteWorkspace: false,
      } as const;
      yield* setAgentRun(projectId, threadId, "running");
      assert.strictEqual((yield* Effect.flip(storage.run(keep))).reason, "busy");
      yield* setAgentRun(projectId, threadId, "ready");

      yield* storage.run(keep);
      assert.isTrue(Option.isNone(yield* query.getProjectShellById(projectId)));
      assert.isTrue(Option.isSome(yield* query.getThreadDetailById(threadId)));
      const entry = yield* retained(projectId);
      assert.strictEqual(entry.source, "local");
      assert.isFalse(entry.cleanupPending);
      // Pruning, as at the next start, keeps what removal retained.
      yield* pruneCadSnapshots(projectId);
      assert.deepStrictEqual(yield* owned(projectId), [roots[0]!.current!.snapshotId]);

      yield* storage.run({ kind: "restore", projectId, removedAt: entry.removedAt });
      const restored = yield* getProject(projectId);
      assert.deepStrictEqual(restored.localCadSource, { filePath: "models/dm1.step" });
      assert.deepStrictEqual(restored.cad?.roots, roots);
      assert.strictEqual(restored.cad?.storage, undefined);
      assert.isTrue(Option.isSome(yield* query.getThreadDetailById(threadId)));
      assert.isTrue(yield* fs.exists(path.join(root, "models/dm1.step")));
    }).pipe(Effect.scoped),
  );

  // An open viewer pins the snapshot it shows, and a pinned snapshot can't be removed, so removal
  // releases the project's viewers before it deletes the imported CAD. Other projects keep theirs.
  it.effect("removing a local CAD project with its imported CAD releases its viewer first", () =>
    Effect.gen(function* () {
      const snapshots = yield* CadSnapshotStore;
      const storage = yield* CadStorage.CadStorage;
      const projectId = ProjectId.make("local-cad-delete");
      const keptId = ProjectId.make("local-cad-kept");
      for (const id of [projectId, keptId]) {
        yield* (yield* LocalCadProjects).create({
          projectId: id,
          title: "Bracket",
          workspaceRoot: yield* makeFolder(),
          filePath: "models/dm1.step",
        });
        yield* settle(id);
      }
      const [shown] = yield* owned(projectId);
      assert.isDefined(shown);
      const release = yield* Deferred.make<void>();
      const viewer = yield* snapshots
        .withPinned(shown!, () => Deferred.await(release))
        .pipe(Effect.forkScoped);
      panelReleases.set(
        projectId,
        Deferred.succeed(release, undefined).pipe(
          Effect.andThen(Fiber.await(viewer)),
          Effect.asVoid,
        ),
      );

      yield* storage.run({ kind: "remove", projectId, deleteCad: true, deleteWorkspace: false });
      assert.deepStrictEqual(yield* owned(projectId), []);
      assert.strictEqual((yield* owned(keptId)).length, 1);
      const entry = yield* retained(projectId);
      assert.isTrue(entry.deleteCad);
      assert.isFalse(entry.cleanupPending);

      // Restored without its CAD, the project imports the file again.
      yield* storage.run({ kind: "restore", projectId, removedAt: entry.removedAt });
      const restored = yield* getProject(projectId);
      assert.deepStrictEqual(restored.cad?.roots, []);
      const reimported = yield* sync(restored, "models/dm1.step");
      assert.strictEqual(reimported.cad?.lastOutcome?.status, "succeeded");
      assert.strictEqual((yield* owned(projectId)).length, 1);
    }).pipe(Effect.scoped),
  );

  // A comment keeps the snapshot it was made on after later imports move current and rollback past
  // it. Removal that keeps the imported CAD keeps that snapshot too, so a restored project can still
  // open the comment's model. Deleting the retained CAD later takes it with the rest.
  it.effect(
    "keeps a removed project's comment snapshots with its kept CAD, and deletes them with it",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const snapshots = yield* CadSnapshotStore;
        const storage = yield* CadStorage.CadStorage;
        const engineService = yield* OrchestrationEngineService;
        const root = yield* makeFolder();
        const projectId = ProjectId.make("local-cad-retain-comment");
        const threadId = ThreadId.make("local-cad-retain-comment-thread");
        yield* (yield* LocalCadProjects).create({
          projectId,
          title: "Bracket",
          workspaceRoot: root,
          filePath: "models/dm1.step",
        });
        const first = yield* settle(projectId);
        const original = yield* snapshots.load(first.cad!.roots[0]!.current!.snapshotId);
        // The chat whose agent published the comment.
        yield* setAgentRun(projectId, threadId, "running");
        yield* setAgentRun(projectId, threadId, "ready");
        const descriptor = cadCommentModelDescriptor(original);
        yield* engineService.dispatch({
          type: "thread.cad.comments.commit",
          commandId: CommandId.make("local-cad-retain-comment-commit"),
          threadId,
          expectedCatalogVersion: 0,
          proposals: [],
          receipts: [],
          comments: [
            {
              id: "local-cad-retain-comment-1",
              threadId,
              rootId: original.rootId,
              snapshotId: original.snapshotId,
              modelKey: NodeCrypto.createHash("sha256").update(descriptor).digest("hex"),
              modelDescriptor: descriptor,
              title: "Check this bolt",
              body: "The bolt is too short.",
              severity: "concern",
              category: "assembly",
              targets: [
                {
                  kind: "part",
                  label: "Bolt",
                  occurrenceId: original.nodes.find((node) => node.kind === "part")!.id,
                  preciseLocationLimitation: "Whole part finding",
                },
              ],
              link: null,
              state: "open",
              version: 0,
              number: 1,
              createdAt: DateTime.formatIso(yield* DateTime.now),
              turnId: TurnId.make("local-cad-retain-comment-turn"),
              outdated: null,
              proposal: null,
            },
          ],
        });
        // Two re-exports move current and rollback past the commented snapshot.
        const file = path.join(root, "models/dm1.step");
        const text = yield* fs.readFileString(file);
        yield* fs.writeFileString(file, text.replace("FILE_NAME(", "FILE_NAME( /* B */ "));
        const second = yield* sync(first, "models/dm1.step");
        yield* fs.writeFileString(file, text.replace("FILE_NAME(", "FILE_NAME( /* C */ "));
        const third = yield* sync(second, "models/dm1.step");
        assert.isFalse(
          third.cad!.roots.some(
            (root) =>
              root.current?.snapshotId === original.snapshotId ||
              root.rollback?.snapshotId === original.snapshotId,
          ),
        );
        yield* pruneCadSnapshots(projectId);
        assert.include(yield* owned(projectId), original.snapshotId);

        yield* storage.run({ kind: "remove", projectId, deleteCad: false, deleteWorkspace: false });
        // Pruning, as at the next start, keeps what removal kept, comment snapshots included.
        yield* pruneCadSnapshots();
        assert.include(yield* owned(projectId), original.snapshotId);

        // Deleting the retained CAD takes the comment's snapshot too.
        const entry = yield* retained(projectId);
        yield* storage.run({
          kind: "cleanup",
          projectId,
          removedAt: entry.removedAt,
          deleteCad: true,
          deleteWorkspace: false,
        });
        assert.deepStrictEqual(yield* owned(projectId), []);
      }).pipe(Effect.scoped),
  );

  // Nothing deletes the folder or deletes the project outright, and a removed project comes back
  // only while no other project uses its folder.
  it.effect("never deletes a local CAD project's folder and restores it only into a free one", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const engineService = yield* OrchestrationEngineService;
      const storage = yield* CadStorage.CadStorage;
      const query = yield* ProjectionSnapshotQuery;
      const root = yield* makeFolder();
      const projectId = ProjectId.make("local-cad-folder-kept");
      yield* (yield* LocalCadProjects).create({
        projectId,
        title: "Bracket",
        workspaceRoot: root,
        filePath: "models/dm1.step",
      });
      yield* settle(projectId);

      const removeFolder = storage.run({
        kind: "remove",
        projectId,
        deleteCad: false,
        deleteWorkspace: true,
      });
      assert.strictEqual((yield* Effect.flip(removeFolder)).reason, "busy");
      const deleted = yield* Effect.exit(
        engineService.dispatch({
          type: "project.delete",
          commandId: CommandId.make("local-cad-folder-kept-delete"),
          projectId,
          force: true,
        }),
      );
      assert.strictEqual(deleted._tag, "Failure");
      assert.isTrue(Option.isSome(yield* query.getProjectShellById(projectId)));

      yield* storage.run({ kind: "remove", projectId, deleteCad: false, deleteWorkspace: false });
      const entry = yield* retained(projectId);
      const cleanupFolder = storage.run({
        kind: "cleanup",
        projectId,
        removedAt: entry.removedAt,
        deleteCad: false,
        deleteWorkspace: true,
      });
      assert.strictEqual((yield* Effect.flip(cleanupFolder)).reason, "busy");
      assert.isFalse((yield* retained(projectId)).deleteWorkspace);

      // The removed project frees its folder for a new project, which does not take its place.
      const reusedId = ProjectId.make("local-cad-folder-reused");
      const reused = yield* (yield* LocalCadProjects).create({
        projectId: reusedId,
        title: "Reused",
        workspaceRoot: root,
        filePath: "models/dm1.step",
      });
      assert.strictEqual(reused.projectId, reusedId);
      yield* settle(reusedId);
      const restore = storage.run({ kind: "restore", projectId, removedAt: entry.removedAt });
      assert.strictEqual((yield* Effect.flip(restore)).reason, "busy");
      assert.isTrue(Option.isNone(yield* query.getProjectShellById(projectId)));

      yield* storage.run({
        kind: "remove",
        projectId: reusedId,
        deleteCad: true,
        deleteWorkspace: false,
      });
      yield* restore;
      assert.isTrue(Option.isSome(yield* query.getProjectShellById(projectId)));
      assert.isTrue(yield* fs.exists(path.join(root, "models/dm1.step")));
    }).pipe(Effect.scoped),
  );

  it.effect("lists SolidWorks parts and assemblies with the other CAD files", () =>
    Effect.gen(function* () {
      const root = yield* makeSolidWorksFolder();
      const result = yield* (yield* LocalCadProjects).listFiles({ workspaceRoot: root });
      assert.deepStrictEqual(
        result.files.map((file) => file.path),
        [
          "cad/Arm.SLDASM",
          "cad/Bracket.SLDPRT",
          "cad/Frame v2.SLDASM",
          "cad/Legacy.SLDASM",
          "cad/Panel.SLDASM",
          "cad/Pattern.SLDASM",
          "cad/Rig.SLDASM",
        ],
      );
    }).pipe(Effect.scoped),
  );

  it.effect("names the files an assembly is missing before starting SolidWorks", () =>
    Effect.gen(function* () {
      const root = yield* makeSolidWorksFolder();
      const projectId = ProjectId.make("local-cad-solidworks-missing");
      yield* (yield* LocalCadProjects).create({
        projectId,
        title: "Frame",
        workspaceRoot: root,
        filePath: "cad/Frame v2.SLDASM",
      });
      const missing = yield* settle(projectId);
      assert.strictEqual(missing.cad?.lastOutcome?.status, "failed");
      // The assembly's own old name, the bracket beside it, and the Interconnect insert all
      // resolve. Only the plate is missing. These generated files would make SolidWorks fail,
      // so reaching this message shows SolidWorks never opened them.
      assert.strictEqual(
        missing.cad?.lastOutcome?.reason,
        "This assembly uses files that are not in the project folder: Plate & Rib.SLDPRT. Add them, then Sync. Existing imported CAD is unchanged.",
      );

      const legacy = yield* sync(missing, "cad/Legacy.SLDASM");
      assert.strictEqual(legacy.cad?.lastOutcome?.status, "failed");
      assert.match(legacy.cad?.lastOutcome?.reason ?? "", /SolidWorks 2015 or later/);

      // Many long names still fit the outcome's 256 characters, so the failure is recorded.
      const many = yield* sync(legacy, "cad/Rig.SLDASM");
      assert.strictEqual(many.cad?.lastOutcome?.status, "failed");
      const reason = many.cad?.lastOutcome?.reason ?? "";
      assert.isAtMost(reason.length, 256);
      assert.match(reason, /^This assembly uses files that are not in the project folder: Vendor/);
      assert.match(reason, /… Existing imported CAD is unchanged\.$/);

      // Virtual components live inside the assembly, so only the real Hinge pin that the virtual
      // Joint uses is missing.
      const arm = yield* sync(many, "cad/Arm.SLDASM");
      assert.strictEqual(
        arm.cad?.lastOutcome?.reason,
        "This assembly uses files that are not in the project folder: Hinge pin.SLDPRT. Add them, then Sync. Existing imported CAD is unchanged.",
      );
    }).pipe(Effect.scoped),
  );

  // Live: opens real SolidWorks files in the SolidWorks installed on this machine or its Windows
  // host. Set CADSENSE_SOLIDWORKS_DIR (a folder holding an assembly and the files it uses, such as
  // samples/learn/Mouse under the SolidWorks public documents), CADSENSE_SOLIDWORKS_ASSEMBLY (its
  // name there), and optionally CADSENSE_SOLIDWORKS_EMPTY_PART (a part with only sketches),
  // CADSENSE_SOLIDWORKS_VIRTUAL_ASSEMBLY (an assembly with virtual components, such as
  // samples/tutorial/api/assemsubassems.sldasm), and CADSENSE_SOLIDWORKS_CONFIGURATION (another
  // configuration of the assembly, whose parts have materials: NPD-16 for
  // samples/tutorial/smartcomponents/pillow_block.sldasm). SolidWorks quits afterwards unless it
  // was running.
  const live = {
    dir: process.env.CADSENSE_SOLIDWORKS_DIR,
    assembly: process.env.CADSENSE_SOLIDWORKS_ASSEMBLY,
    emptyPart: process.env.CADSENSE_SOLIDWORKS_EMPTY_PART,
    virtualAssembly: process.env.CADSENSE_SOLIDWORKS_VIRTUAL_ASSEMBLY,
    configuration: process.env.CADSENSE_SOLIDWORKS_CONFIGURATION,
  };
  const skipLive = !live.dir || !live.assembly;

  /** A fresh folder with the live assembly and the files it uses, less `leaveOut`. */
  const makeLiveFolder = Effect.fn(function* (leaveOut?: string) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "cadsense-local-cad-live-" });
    const references = readSolidWorksReferences(
      NodeFS.readFileSync(path.join(live.dir!, live.assembly!)),
    );
    assert.isNotNull(references);
    const { files, missing } = planSolidWorksFiles({
      assemblyPath: live.assembly!,
      references: references!,
      folderFiles: NodeFS.readdirSync(live.dir!),
    });
    assert.deepStrictEqual(missing, []);
    for (const name of [live.assembly!, ...files])
      if (name !== leaveOut) yield* fs.copyFile(path.join(live.dir!, name), path.join(root, name));
    return { root, uses: files };
  });

  /**
   * What SolidWorks was doing when a live test started. `restored` waits until it is that way again:
   * a SolidWorks Cadsense started quits in the background once the job is over, so a test that ends
   * without waiting hands the next one a SolidWorks that is still quitting.
   */
  const solidWorksAsFound = Effect.fn(function* () {
    const host = yield* SolidWorksBridge.detectSolidWorksHost;
    assert.isNotNull(host);
    // tasklist sits in System32, three levels above WindowsPowerShell\v1.0\powershell.exe.
    const tasklist = NodePath.join(host!.powershell, "../../../tasklist.exe");
    const running = () =>
      NodeChildProcess.execFileSync(tasklist, ["/FI", "IMAGENAME eq SLDWORKS.exe", "/NH"])
        .toString()
        .includes("SLDWORKS.exe");
    const jobs = () =>
      NodeFS.readdirSync(host!.serverRoot).filter((name) => /^[0-9a-f-]{36}$/.test(name));
    const wasRunning = running();
    const before = new Set(jobs());
    const restored = Effect.gen(function* () {
      for (
        let attempt = 0;
        running() !== wasRunning || jobs().some((job) => !before.has(job));
        attempt++
      ) {
        if (attempt > 120) return yield* Effect.die("SolidWorks was not left as it was found");
        yield* Effect.sleep("1 second");
      }
    });
    return { host: host!, running, jobs, wasRunning, before, restored };
  });

  it.effect.skipIf(skipLive)(
    "converts a real assembly with SolidWorks, then re-exports only what changed",
    () =>
      Effect.gen(function* () {
        const found = yield* solidWorksAsFound();
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const snapshots = yield* CadSnapshotStore;
        const { root, uses } = yield* makeLiveFolder();
        const projectId = ProjectId.make("local-cad-solidworks-live");
        const calls = bridgeCalls.length;
        yield* (yield* LocalCadProjects).create({
          projectId,
          title: "SolidWorks",
          workspaceRoot: root,
          filePath: live.assembly!,
        });
        const first = yield* settle(projectId);
        assert.strictEqual(
          first.cad?.lastOutcome?.status,
          "succeeded",
          first.cad?.lastOutcome?.reason ?? undefined,
        );
        const manifest = yield* snapshots.load(first.cad!.roots[0]!.current!.snapshotId);
        assert.isAtLeast(manifest.parts.length, 2);
        // One call that exported every part (a part with only sketches exports but adds none).
        assert.strictEqual(bridgeCalls.length, calls + 1);
        assert.strictEqual(bridgeCalls[calls]!.skipped, 0);
        assert.isAtLeast(bridgeCalls[calls]!.exported ?? 0, manifest.parts.length);
        // SolidWorks placed the components: at least one is not at the origin unrotated.
        const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1].join();
        assert.isTrue(
          manifest.nodes.some((node) => node.kind === "part" && node.transform.join() !== identity),
        );

        // Unchanged files: the same snapshot, and no call to SolidWorks.
        const unchanged = yield* sync(first, live.assembly!);
        assert.strictEqual(unchanged.cad?.lastOutcome?.status, "succeeded");
        assert.strictEqual(unchanged.cad!.roots[0]!.current?.snapshotId, manifest.snapshotId);
        assert.strictEqual(bridgeCalls.length, calls + 1);
        assert.strictEqual(
          cadCommentModelDescriptor(yield* snapshots.load(manifest.snapshotId)),
          cadCommentModelDescriptor(manifest),
        );

        // Swap in another real part under one used name: a new revision where only that part
        // is exported again and every other part keeps its geometry.
        const other = NodeFS.readdirSync(live.dir!).find(
          (name) => /\.sldprt$/i.test(name) && !uses.includes(name),
        );
        assert.isDefined(other);
        yield* fs.copyFile(path.join(live.dir!, other!), path.join(root, uses[0]!));
        const changed = yield* sync(unchanged, live.assembly!);
        assert.strictEqual(
          changed.cad?.lastOutcome?.status,
          "succeeded",
          changed.cad?.lastOutcome?.reason ?? undefined,
        );
        const next = yield* snapshots.load(changed.cad!.roots[0]!.current!.snapshotId);
        assert.notStrictEqual(next.root.microversionId, manifest.root.microversionId);
        // SolidWorks was told to skip every part it had, and exported only the swapped one.
        assert.deepStrictEqual(bridgeCalls.slice(calls + 1), [
          { skipped: manifest.parts.length, exported: 1 },
        ]);
        const before = new Set(manifest.parts.map((part) => part.geometryKey));
        const kept = next.parts.filter((part) => before.has(part.geometryKey));
        assert.strictEqual(kept.length, next.parts.length - 1);
        assert.isTrue(
          kept.every(
            (part) =>
              next.assets.find((asset) => asset.geometryKey === part.geometryKey)?.sha256 ===
              manifest.assets.find((asset) => asset.geometryKey === part.geometryKey)?.sha256,
          ),
        );
        // The parts SolidWorks skipped keep their names, materials, and masses.
        assert.deepStrictEqual(
          kept.map((part) => part.metadata),
          kept.map(
            (part) =>
              manifest.parts.find((previous) => previous.geometryKey === part.geometryKey)
                ?.metadata,
          ),
        );
        yield* found.restored;
      }).pipe(Effect.scoped),
    10 * 60_000,
  );

  it.effect.skipIf(skipLive)(
    "names a real assembly's missing part before starting SolidWorks",
    () =>
      Effect.gen(function* () {
        const references = readSolidWorksReferences(
          NodeFS.readFileSync(`${live.dir}/${live.assembly}`),
        );
        const { files } = planSolidWorksFiles({
          assemblyPath: live.assembly!,
          references: references!,
          folderFiles: NodeFS.readdirSync(live.dir!),
        });
        const { root } = yield* makeLiveFolder(files[0]);
        const projectId = ProjectId.make("local-cad-solidworks-live-missing");
        yield* (yield* LocalCadProjects).create({
          projectId,
          title: "Missing",
          workspaceRoot: root,
          filePath: live.assembly!,
        });
        const project = yield* settle(projectId);
        assert.strictEqual(project.cad?.lastOutcome?.status, "failed");
        // Named as the assembly spells it, which can differ in case from the file on disk.
        assert.include(
          project.cad?.lastOutcome?.reason?.toLowerCase() ?? "",
          files[0]!.toLowerCase(),
        );
      }).pipe(Effect.scoped),
  );

  it.effect.skipIf(skipLive)(
    "cancels a SolidWorks conversion and leaves SolidWorks as it found it",
    () =>
      Effect.gen(function* () {
        const { jobs, before, restored } = yield* solidWorksAsFound();
        const { root } = yield* makeLiveFolder();
        const projectId = ProjectId.make("local-cad-solidworks-live-cancel");
        yield* (yield* LocalCadProjects).create({
          projectId,
          title: "Cancelled",
          workspaceRoot: root,
          filePath: live.assembly!,
        });
        // Cancel as soon as this job's files are staged for SolidWorks.
        for (let attempt = 0; jobs().every((job) => before.has(job)); attempt++) {
          if (attempt > 600) return yield* Effect.die("The conversion never started");
          yield* Effect.sleep("50 millis");
        }
        const operation = (yield* getProject(projectId)).cad?.operation;
        assert.isDefined(operation ?? undefined);
        yield* (yield* CadUserOperations).cancel(projectId, operation!.operationId);
        const cancelled = yield* settle(projectId, operation!.operationId);
        assert.strictEqual(cancelled.cad?.lastOutcome?.status, "cancelled");
        // A SolidWorks that Cadsense started quits once the slot is idle, just after the job, and
        // takes its hold on the job's files with it.
        yield* restored;
      }).pipe(Effect.scoped),
    5 * 60_000,
  );

  it.effect.skipIf(skipLive)(
    "runs one SolidWorks bridge at a time across Cadsense servers",
    () =>
      Effect.gen(function* () {
        const { host, running, jobs, wasRunning, before } = yield* solidWorksAsFound();
        const decodeRequest = Schema.decodeUnknownOption(
          Schema.fromJsonString(Schema.Struct({ file: Schema.String })),
        );
        const inJob = (job: string, name: string) =>
          NodeFS.existsSync(NodePath.join(host.serverRoot, job, name));
        /** Waits for the new job folder whose request opens `file` to satisfy `ready`. */
        const jobFor = Effect.fn(function* (file: string, ready: (job: string) => boolean) {
          for (let attempt = 0; ; attempt++) {
            const job = jobs().find(
              (job) =>
                !before.has(job) &&
                inJob(job, "request.json") &&
                Option.getOrUndefined(
                  decodeRequest(
                    NodeFS.readFileSync(
                      NodePath.join(host.serverRoot, job, "request.json"),
                      "utf8",
                    ),
                  ),
                )?.file === file,
            );
            if (job && ready(job)) return job;
            if (attempt > 1200) return yield* Effect.die(`No SolidWorks job for ${file}`);
            yield* Effect.sleep("100 millis");
          }
        });
        const read = (name: string) => ({
          path: name,
          bytes: new Uint8Array(NodeFS.readFileSync(NodePath.join(live.dir!, name))),
        });
        const { files } = planSolidWorksFiles({
          assemblyPath: live.assembly!,
          references: readSolidWorksReferences(
            NodeFS.readFileSync(NodePath.join(live.dir!, live.assembly!)),
          )!,
          folderFiles: NodeFS.readdirSync(live.dir!),
        });
        const part = NodeFS.readdirSync(live.dir!).find(
          (name) => /\.sldprt$/i.test(name) && !files.includes(name),
        );
        assert.isDefined(part);

        // Two services, like a restarted Cadsense beside a bridge the earlier one left running.
        const server = Effect.fn(function* () {
          const scope = yield* Scope.make();
          yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
          const service = yield* SolidWorksBridge.make({ host }).pipe(
            Effect.provideService(Scope.Scope, scope),
          );
          return { service, stop: Scope.close(scope, Exit.void) };
        });
        const { service: first, stop: stopFirst } = yield* server();
        const { service: second, stop: stopSecond } = yield* server();
        const assembly = yield* first
          .exportParts({
            files: [live.assembly!, ...files].map(read),
            skip: [],
            configuration: "default",
          })
          .pipe(Effect.forkChild);
        // A bridge creates `out` once it holds the lock.
        const a = yield* jobFor(live.assembly!, (job) => inJob(job, "out"));
        const single = yield* second
          .exportParts({ files: [read(part!)], skip: [], configuration: "default" })
          .pipe(Effect.forkChild);
        const b = yield* jobFor(part!, () => true);
        // Whether a bridge process still runs for this job, from its command line.
        const bridgeRuns = (job: string) =>
          NodeChildProcess.execFileSync(host.powershell, [
            "-NoProfile",
            "-Command",
            `@(Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -like '*${job}*' }).Count`,
          ])
            .toString()
            .trim() !== "0";
        // The second bridge gets the lock only after the first wrote its result and exited. Read
        // in this order, a second bridge holding the lock means the first result is already there,
        // or the first job's folder is being removed, which only happens once its bridge exited.
        let queued = false;
        for (let attempt = 0; ; attempt++) {
          const secondHolds = inJob(b, "out");
          const firstDone =
            inJob(a, "result.json") || !inJob(a, ".") || (secondHolds && !bridgeRuns(a));
          assert.isTrue(!secondHolds || firstDone, "Two SolidWorks bridges ran at once");
          if (firstDone) break;
          queued = true;
          if (attempt > 3000) return yield* Effect.die("The first conversion never finished");
          yield* Effect.sleep("100 millis");
        }
        assert.isTrue(queued, "The second job was staged only after the first one finished");
        assert.isAtLeast((yield* Fiber.join(assembly)).parts.size, 2);
        assert.strictEqual((yield* Fiber.join(single)).parts.size, 1);

        // The first service quits the SolidWorks it started once the second bridge lets go.
        for (let attempt = 0; running() !== wasRunning; attempt++) {
          if (attempt > 120) return yield* Effect.die("SolidWorks was not left as it was found");
          yield* Effect.sleep("1 second");
        }
        // A server retries only its own leftover job folders, and stopping retries them once more.
        yield* stopSecond;
        yield* stopFirst;
        assert.deepStrictEqual(
          jobs().filter((job) => !before.has(job)),
          [],
        );
      }).pipe(Effect.scoped),
    5 * 60_000,
  );

  it.effect.skipIf(!live.virtualAssembly)(
    "converts a real assembly with virtual components",
    () =>
      Effect.gen(function* () {
        const found = yield* solidWorksAsFound();
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const source = live.virtualAssembly!;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "cadsense-local-cad-live-" });
        const { files, missing } = planSolidWorksFiles({
          assemblyPath: path.basename(source),
          references: readSolidWorksReferences(NodeFS.readFileSync(source))!,
          folderFiles: NodeFS.readdirSync(path.dirname(source)),
        });
        assert.deepStrictEqual(missing, []);
        for (const name of [path.basename(source), ...files])
          yield* fs.copyFile(path.join(path.dirname(source), name), path.join(root, name));
        const projectId = ProjectId.make("local-cad-solidworks-live-virtual");
        yield* (yield* LocalCadProjects).create({
          projectId,
          title: "Virtual",
          workspaceRoot: root,
          filePath: path.basename(source),
        });
        const project = yield* settle(projectId);
        assert.strictEqual(
          project.cad?.lastOutcome?.status,
          "succeeded",
          project.cad?.lastOutcome?.reason ?? undefined,
        );
        const manifest = yield* (yield* CadSnapshotStore).load(
          project.cad!.roots[0]!.current!.snapshotId,
        );
        assert.isAtLeast(manifest.parts.length, 1);
        yield* found.restored;
      }).pipe(Effect.scoped),
    5 * 60_000,
  );

  it.effect.skipIf(skipLive || !live.configuration)(
    "converts a real assembly in a chosen configuration, with each part's material and mass",
    () =>
      Effect.gen(function* () {
        const found = yield* solidWorksAsFound();
        const snapshots = yield* CadSnapshotStore;
        const { root } = yield* makeLiveFolder();
        const projectId = ProjectId.make("local-cad-solidworks-live-configuration");
        yield* (yield* LocalCadProjects).create({
          projectId,
          title: "Configured",
          workspaceRoot: root,
          filePath: live.assembly!,
        });
        const first = yield* settle(projectId);
        assert.strictEqual(
          first.cad?.lastOutcome?.status,
          "succeeded",
          first.cad?.lastOutcome?.reason ?? undefined,
        );
        const active = first.cad!.roots[0]!;
        const activeManifest = yield* snapshots.load(active.current!.snapshotId);

        /**
         * A part has a mass exactly when it has a material (no sample overrides one), in kg: its
         * material's density times the volume of the mesh exported in this configuration.
         */
        const checkMaterials = Effect.fn(function* (manifest: typeof activeManifest) {
          const withMaterial = manifest.parts.filter((part) => part.metadata?.material);
          const without = manifest.parts.filter((part) => !part.metadata?.material);
          assert.isNotEmpty(withMaterial);
          assert.isNotEmpty(without);
          assert.deepStrictEqual(
            without.map((part) => part.metadata?.massKg),
            without.map(() => undefined),
          );
          let measured = 0;
          for (const part of withMaterial) {
            const { name, material, massKg } = part.metadata!;
            assert.isAbove(massKg ?? 0, 0, name);
            const density = LIBRARY_DENSITY[material?.displayName ?? ""];
            if (density === undefined) continue;
            const asset = manifest.assets.find((entry) => entry.geometryKey === part.geometryKey);
            const volume = meshVolume(
              yield* snapshots.readAsset(manifest.snapshotId, asset!.sha256),
            );
            assert.approximately(massKg!, density * volume, 0.02 * density * volume, name);
            measured++;
          }
          assert.isAbove(measured, 0, "No part uses a material with a known density");
        });
        yield* checkMaterials(activeManifest);

        // Another configuration is a root of its own. Its components use other part
        // configurations, each measured in its own.
        const calls = bridgeCalls.length;
        const configured = yield* sync(first, live.assembly!, live.configuration!);
        assert.strictEqual(
          configured.cad?.lastOutcome?.status,
          "succeeded",
          configured.cad?.lastOutcome?.reason ?? undefined,
        );
        const configuredRoot = configured.cad!.roots.find(
          (entry) => entry.configuration === live.configuration,
        );
        assert.isDefined(configuredRoot);
        assert.notStrictEqual(configuredRoot!.rootId, active.rootId);
        assert.strictEqual(
          configured.cad!.roots.find((entry) => entry.rootId === active.rootId)?.current
            ?.snapshotId,
          activeManifest.snapshotId,
        );
        const manifest = yield* snapshots.load(configuredRoot!.current!.snapshotId);
        assert.strictEqual(manifest.root.configuration, live.configuration);
        const partConfigurations = (parts: typeof manifest.parts) =>
          parts.map((part) => `${part.metadata?.name} ${part.source.configuration}`).sort();
        assert.notDeepEqual(
          partConfigurations(manifest.parts),
          partConfigurations(activeManifest.parts),
        );
        yield* checkMaterials(manifest);
        assert.strictEqual(bridgeCalls.length, calls + 1);

        // The panel's Sync button syncs a root in its own configuration: unchanged files reuse it.
        const again = yield* sync(configured, live.assembly!, configuredRoot!.configuration);
        assert.strictEqual(
          again.cad!.roots.find((entry) => entry.rootId === configuredRoot!.rootId)?.current
            ?.snapshotId,
          manifest.snapshotId,
        );
        assert.strictEqual(bridgeCalls.length, calls + 1);

        // A configuration the assembly does not have fails, naming the file and configuration.
        const missing = yield* sync(again, live.assembly!, "No such configuration");
        assert.strictEqual(missing.cad?.lastOutcome?.status, "failed");
        assert.include(missing.cad?.lastOutcome?.reason ?? "", live.assembly!);
        assert.include(missing.cad?.lastOutcome?.reason ?? "", '"No such configuration"');
        assert.include(missing.cad?.lastOutcome?.reason ?? "", live.configuration!);
        yield* found.restored;
      }).pipe(Effect.scoped),
    10 * 60_000,
  );

  it.effect.skipIf(skipLive || !live.emptyPart)(
    "says a SolidWorks part with only sketches has no geometry",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "cadsense-local-cad-live-" });
        const name = path.basename(live.emptyPart!);
        yield* fs.copyFile(live.emptyPart!, path.join(root, name));
        const projectId = ProjectId.make("local-cad-solidworks-live-empty");
        yield* (yield* LocalCadProjects).create({
          projectId,
          title: "Sketch",
          workspaceRoot: root,
          filePath: name,
        });
        const project = yield* settle(projectId);
        assert.strictEqual(project.cad?.lastOutcome?.status, "failed");
        assert.match(project.cad?.lastOutcome?.reason ?? "", /no solid geometry/);
      }).pipe(Effect.scoped),
    5 * 60_000,
  );
});

it.layer(noSolidWorksLayer, { timeout: 120_000, excludeTestServices: true })(
  "local CAD projects without SolidWorks",
  (it) => {
    it.effect("says SolidWorks files need SolidWorks, and STEP still works", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* makeSolidWorksFolder();
        yield* fs.copyFile(FIXTURE, path.join(root, "cad/frame.step"));
        const projectId = ProjectId.make("local-cad-solidworks-unavailable");
        yield* (yield* LocalCadProjects).create({
          projectId,
          title: "Panel",
          workspaceRoot: root,
          filePath: "cad/Panel.SLDASM",
        });
        const assembly = yield* settle(projectId);
        assert.strictEqual(assembly.cad?.lastOutcome?.status, "failed");
        assert.strictEqual(
          assembly.cad?.lastOutcome?.reason,
          "Opening SolidWorks files needs SolidWorks installed on this computer. Install it, or save a STEP copy from SolidWorks and pick that. Existing imported CAD is unchanged.",
        );
        const part = yield* sync(assembly, "cad/Bracket.SLDPRT");
        assert.match(part.cad?.lastOutcome?.reason ?? "", /needs SolidWorks installed/);
        // An assembly of virtual components needs no other file, so it gets as far as SolidWorks.
        const pattern = yield* sync(part, "cad/Pattern.SLDASM");
        assert.match(pattern.cad?.lastOutcome?.reason ?? "", /needs SolidWorks installed/);
        const step = yield* sync(pattern, "cad/frame.step");
        assert.strictEqual(step.cad?.lastOutcome?.status, "succeeded");
      }).pipe(Effect.scoped),
    );

    it.effect("rejects an assembly over 512 MiB before reading it", () =>
      Effect.gen(function* () {
        const root = yield* makeSolidWorksFolder();
        // Sparse, so it takes no disk. Reading it would mean 512 MiB of memory, then no file list.
        const huge = NodePath.join(root, "cad/Huge.SLDASM");
        NodeFS.writeFileSync(huge, "");
        NodeFS.truncateSync(huge, 512 * 1024 * 1024 + 1);
        const projectId = ProjectId.make("local-cad-solidworks-huge");
        yield* (yield* LocalCadProjects).create({
          projectId,
          title: "Huge",
          workspaceRoot: root,
          filePath: "cad/Huge.SLDASM",
        });
        const project = yield* settle(projectId);
        assert.strictEqual(
          project.cad?.lastOutcome?.reason,
          "This CAD file is over the 512 MiB import limit. Existing imported CAD is unchanged.",
        );
      }).pipe(Effect.scoped),
    );
  },
);

// The scripted bridge orders the races a real SolidWorks cannot: a bridge that stays busy after
// its caller gives up, and an import that stops waiting while another runs.
it.layer(scriptedLayer, { timeout: 120_000, excludeTestServices: true })(
  "local CAD projects with a scripted SolidWorks bridge",
  (it) => {
    const reset = () => {
      for (const name of ["log", "requests", "release", "solidworks"])
        NodeFS.rmSync(NodePath.join(scriptedRoot, "control", name), { force: true });
    };
    /** Waits for the SolidWorks the jobs started to quit, after the last job, and its folders to go. */
    const idle = Effect.fn(function* () {
      for (let attempt = 0; scriptedLog().at(-1) !== "quit 4242" || scriptedJobs().length > 0; ) {
        if (++attempt > 400) return yield* Effect.die("SolidWorks never went idle");
        yield* Effect.sleep("50 millis");
      }
    });
    const create = Effect.fn(function* (projectId: ProjectId, name: string) {
      yield* (yield* LocalCadProjects).create({
        projectId,
        title: name,
        workspaceRoot: yield* makePartFolder(name),
        filePath: name,
      });
    });
    const cancel = Effect.fn(function* (projectId: ProjectId) {
      const operation = (yield* getProject(projectId)).cad?.operation;
      assert.isDefined(operation ?? undefined);
      yield* (yield* CadUserOperations).cancel(projectId, operation!.operationId);
      return yield* settle(projectId, operation!.operationId);
    });

    it.effect("holds the SolidWorks slot until a cancelled bridge exits", () =>
      Effect.gen(function* () {
        reset();
        const held = ProjectId.make("local-cad-scripted-held");
        yield* create(held, "Hold.SLDPRT");
        yield* scriptedLogged("start Hold.SLDPRT owned=0");
        // The bridge ignores the cancel marker, like one stuck in SolidWorks. The cancel still
        // ends after the grace, but the job keeps its folder, its marker, and the slot.
        assert.strictEqual((yield* cancel(held)).cad?.lastOutcome?.status, "cancelled");
        const jobs = scriptedJobs();
        assert.lengthOf(jobs, 1);
        assert.isTrue(NodeFS.existsSync(NodePath.join(scriptedRoot, jobs[0]!, "cancel")));

        const next = ProjectId.make("local-cad-scripted-next");
        yield* create(next, "Quick.SLDPRT");
        yield* Effect.sleep("1 second");
        assert.deepStrictEqual(scriptedLog(), ["start Hold.SLDPRT owned=0"]);
        assert.isDefined((yield* getProject(next)).cad?.operation ?? undefined);

        NodeFS.writeFileSync(NodePath.join(scriptedRoot, "control/release"), "");
        assert.strictEqual((yield* settle(next)).cad?.lastOutcome?.status, "succeeded");
        // The next job started only after the first bridge exited, and inherited its SolidWorks.
        yield* scriptedLogged("quit 4242");
        assert.deepStrictEqual(scriptedLog(), [
          "start Hold.SLDPRT owned=0",
          "exit Hold.SLDPRT",
          "start Quick.SLDPRT owned=4242",
          "exit Quick.SLDPRT",
          "quit 4242",
        ]);
        assert.deepStrictEqual(scriptedJobs(), []);
      }).pipe(Effect.scoped),
    );

    it.effect("quits the SolidWorks it started when the import waiting for it is cancelled", () =>
      Effect.gen(function* () {
        reset();
        const running = ProjectId.make("local-cad-scripted-running");
        yield* create(running, "Hold.SLDPRT");
        yield* scriptedLogged("start Hold.SLDPRT owned=0");
        const waiting = ProjectId.make("local-cad-scripted-waiting");
        yield* create(waiting, "Quick.SLDPRT");
        yield* Effect.sleep("300 millis");
        assert.strictEqual((yield* cancel(waiting)).cad?.lastOutcome?.status, "cancelled");

        NodeFS.writeFileSync(NodePath.join(scriptedRoot, "control/release"), "");
        assert.strictEqual((yield* settle(running)).cad?.lastOutcome?.status, "succeeded");
        // Nothing waits any more, so the SolidWorks the first job started is quit.
        yield* scriptedLogged("quit 4242");
        assert.deepStrictEqual(scriptedLog(), [
          "start Hold.SLDPRT owned=0",
          "exit Hold.SLDPRT",
          "quit 4242",
        ]);
        assert.isFalse(NodeFS.existsSync(NodePath.join(scriptedRoot, "control/solidworks")));
        assert.deepStrictEqual(scriptedJobs(), []);
      }).pipe(Effect.scoped),
    );

    it.effect("starts no bridge when cancelled while its files are staged", () =>
      Effect.gen(function* () {
        reset();
        let release = () => {};
        staging.held = false;
        staging.hold = new Promise((resolve) => {
          release = resolve;
        });
        const staged = ProjectId.make("local-cad-scripted-staged");
        yield* create(staged, "Staged.SLDPRT");
        for (let attempt = 0; !staging.held; attempt++) {
          if (attempt > 400) return yield* Effect.die("Staging never started");
          yield* Effect.sleep("50 millis");
        }
        // The job's folder does not exist yet, so the cancel marker has nowhere to go.
        assert.strictEqual((yield* cancel(staged)).cad?.lastOutcome?.status, "cancelled");
        staging.hold = null;
        release();
        // The next job runs only once the staged one is over, so its log entry comes first if
        // the staged job started a bridge after all.
        const next = ProjectId.make("local-cad-scripted-after-staged");
        yield* create(next, "Quick.SLDPRT");
        assert.strictEqual((yield* settle(next)).cad?.lastOutcome?.status, "succeeded");
        yield* scriptedLogged("quit 4242");
        assert.deepStrictEqual(scriptedLog(), [
          "start Quick.SLDPRT owned=0",
          "exit Quick.SLDPRT",
          "quit 4242",
        ]);
        assert.deepStrictEqual(scriptedJobs(), []);
      }).pipe(Effect.scoped),
    );

    it.effect("imports a SolidWorks file in each chosen configuration as a root of its own", () =>
      Effect.gen(function* () {
        reset();
        const snapshots = yield* CadSnapshotStore;
        const projectId = ProjectId.make("local-cad-scripted-configuration");
        const root = yield* makePartFolder("Pillow.SLDPRT");
        NodeFS.copyFileSync(FIXTURE, NodePath.join(root, "pillow.step"));
        yield* (yield* LocalCadProjects).create({
          projectId,
          title: "Pillow",
          workspaceRoot: root,
          filePath: "Pillow.SLDPRT",
        });
        const first = yield* settle(projectId);
        assert.strictEqual(
          first.cad?.lastOutcome?.status,
          "succeeded",
          first.cad?.lastOutcome?.reason ?? undefined,
        );
        // "default" opens the configuration the file was saved in, under the root ID local files
        // had before configurations, so existing snapshots and comments keep their root.
        const active = first.cad!.roots[0]!;
        assert.strictEqual(active.configuration, "default");
        assert.strictEqual(
          active.rootId,
          "427242f1a237f4993aac13a4424ba39872120031fb5b7783c04fd3efb2a11d3e",
        );
        assert.strictEqual(scriptedRequests()[0]?.configuration, "default");
        const activeManifest = yield* snapshots.load(active.current!.snapshotId);
        assert.strictEqual(activeManifest.parts[0]!.source.configuration, "Default");
        assert.deepStrictEqual(activeManifest.parts[0]!.metadata?.material, {
          displayName: "Alloy Steel",
        });
        assert.strictEqual(activeManifest.parts[0]!.metadata?.massKg, 0.25);

        // Another configuration of the same, unchanged file is a root of its own, which
        // SolidWorks converts. The default root keeps its snapshot.
        const large = yield* sync(first, "Pillow.SLDPRT", "Large");
        assert.strictEqual(
          large.cad?.lastOutcome?.status,
          "succeeded",
          large.cad?.lastOutcome?.reason ?? undefined,
        );
        assert.lengthOf(large.cad!.roots, 2);
        const largeRoot = large.cad!.roots.find((entry) => entry.configuration === "Large");
        assert.isDefined(largeRoot);
        assert.notStrictEqual(largeRoot!.rootId, active.rootId);
        assert.strictEqual(largeRoot!.elementId, active.elementId);
        assert.strictEqual(
          large.cad!.roots.find((entry) => entry.rootId === active.rootId)?.current?.snapshotId,
          active.current!.snapshotId,
        );
        assert.deepStrictEqual(scriptedRequests()[1], { configuration: "Large", skip: [] });
        const largeManifest = yield* snapshots.load(largeRoot!.current!.snapshotId);
        assert.strictEqual(largeManifest.root.configuration, "Large");
        assert.strictEqual(largeManifest.parts[0]!.source.configuration, "Large");

        // Synced again in its configuration, as the panel's Sync button does, unchanged files
        // reuse that root's snapshot without SolidWorks.
        const again = yield* sync(large, "Pillow.SLDPRT", largeRoot!.configuration);
        assert.strictEqual(
          again.cad!.roots.find((entry) => entry.rootId === largeRoot!.rootId)?.current?.snapshotId,
          largeManifest.snapshotId,
        );
        assert.lengthOf(scriptedRequests(), 2);

        // A new revision skips the part the latest snapshot has, which keeps its material and mass.
        NodeFS.writeFileSync(
          NodePath.join(root, "Pillow.SLDPRT"),
          solidWorksFile({ "Contents/Config-0": "part, saved again" }),
        );
        const changed = yield* sync(again, "Pillow.SLDPRT", "Large");
        const changedRoot = changed.cad!.roots.find((entry) => entry.rootId === largeRoot!.rootId);
        const changedManifest = yield* snapshots.load(changedRoot!.current!.snapshotId);
        assert.notStrictEqual(
          changedManifest.root.microversionId,
          largeManifest.root.microversionId,
        );
        assert.deepStrictEqual(scriptedRequests()[2], {
          configuration: "Large",
          skip: [largeManifest.parts[0]!.source.partId],
        });
        assert.deepStrictEqual(
          changedManifest.parts[0]!.metadata,
          largeManifest.parts[0]!.metadata,
        );

        // A configuration the file does not have fails, naming the file and the configuration.
        const missing = yield* sync(changed, "Pillow.SLDPRT", "Small");
        assert.strictEqual(missing.cad?.lastOutcome?.status, "failed");
        assert.strictEqual(
          missing.cad?.lastOutcome?.reason,
          'Pillow.SLDPRT has no configuration named "Small". Its configurations are Default, Large. Existing imported CAD is unchanged.',
        );

        // STEP and IGES files have no configurations.
        const step = catalogRoot(missing, "pillow.step");
        const rejected = yield* Effect.flip(
          (yield* CadUserOperations).start({
            projectId,
            kind: "sync",
            root: { elementId: step.elementId, kind: step.kind, configuration: "Large" },
          }),
        );
        assert.strictEqual(rejected.reason, "invalid-root");
        yield* idle();
      }).pipe(Effect.scoped),
    );

    it.effect("keeps a stopping server's job folder until its bridge exits", () =>
      Effect.gen(function* () {
        reset();
        // A service of its own, so the test can stop it the way a server stops.
        const scope = yield* Scope.make();
        const solidWorks = yield* SolidWorksBridge.make({
          host: {
            powershell: NodePath.join(scriptedRoot, "bridge.cjs"),
            windowsRoot: scriptedRoot,
            serverRoot: scriptedRoot,
          },
          cancelGrace: "300 millis",
        }).pipe(Effect.provideService(Scope.Scope, scope));
        const caller = yield* solidWorks
          .exportParts({
            files: [{ path: "Hold.SLDPRT", bytes: solidWorksFile({ "Contents/Config-0": "p" }) }],
            skip: [],
            configuration: "default",
          })
          .pipe(Effect.forkChild);
        yield* scriptedLogged("start Hold.SLDPRT owned=0");
        const [job] = scriptedJobs();
        const folder = NodePath.join(scriptedRoot, job!);

        // Stopping waits out the grace, not the stuck bridge, then leaves the bridge its marker
        // and inputs.
        const [stopping] = yield* Effect.timed(Scope.close(scope, Exit.void));
        assert.isBelow(Duration.toMillis(stopping), 5_000);
        assert.isTrue(NodeFS.existsSync(NodePath.join(folder, "cancel")));
        assert.isTrue(NodeFS.existsSync(NodePath.join(folder, "in/Hold.SLDPRT")));

        // Once the bridge exits, its folder goes.
        NodeFS.writeFileSync(NodePath.join(scriptedRoot, "control/release"), "");
        yield* scriptedLogged("exit Hold.SLDPRT");
        for (let attempt = 0; NodeFS.existsSync(folder); attempt++) {
          if (attempt > 100) return yield* Effect.die("The job folder outlived its bridge");
          yield* Effect.sleep("50 millis");
        }
        yield* Fiber.interrupt(caller);
      }).pipe(Effect.scoped),
    );
  },
);
