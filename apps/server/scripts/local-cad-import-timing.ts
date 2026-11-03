// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalDate:off preferSchemaOverJson:off
/**
 * Times a real local CAD import end to end: the same `LocalCadImport.acquire` a Sync runs, with the
 * real SolidWorks bridge, occt workers, and snapshot store, on a fresh data directory so nothing is
 * reused. Appends one line to `timings.jsonl` under --out per run, so runs before and after a change
 * can be compared:
 *
 *   node apps/server/scripts/local-cad-import-timing.ts --out .cadsense/import-timing \
 *     --folder "path/to/project folder" --file "Robot.SLDASM" [--label after]
 *
 * --file is relative to --folder. A SolidWorks file needs SolidWorks on this machine or its
 * Windows host.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProjectId } from "@cadsense/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { CadDiskSpace, CadSnapshotStore, make as makeStore } from "../src/cad/CadSnapshotStore.ts";
import { ServerConfig } from "../src/config.ts";
import * as LocalCadImport from "../src/localCad/LocalCadImport.ts";
import * as SolidWorksBridge from "../src/localCad/SolidWorksBridge.ts";
import * as WorkspacePaths from "../src/workspace/WorkspacePaths.ts";

const { values } = NodeUtil.parseArgs({
  options: {
    out: { type: "string" },
    folder: { type: "string" },
    file: { type: "string" },
    label: { type: "string" },
  },
});
if (!values.out || !values.folder || !values.file)
  throw new Error("Usage: --out <dir> --folder <project folder> --file <file in it> [--label x]");

const layer = LocalCadImport.layer.pipe(
  Layer.provideMerge(SolidWorksBridge.layer),
  Layer.provideMerge(
    Layer.effect(CadSnapshotStore, makeStore).pipe(
      Layer.provide(
        Layer.succeed(CadDiskSpace, { availableBytes: () => Effect.succeed(10 ** 12) }),
      ),
    ),
  ),
  Layer.provideMerge(WorkspacePaths.layer),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "cadsense-import-timing-" })),
  Layer.provideMerge(NodeServices.layer),
);

const started = performance.now();
const manifest = await Effect.runPromise(
  Effect.gen(function* () {
    const imports = yield* LocalCadImport.LocalCadImport;
    return yield* imports.acquire({
      projectId: ProjectId.make("import-timing"),
      workspaceRoot: NodePath.resolve(values.folder!),
      filePath: values.file!,
      configuration: "default",
    });
  }).pipe(Effect.provide(layer)),
);
const run = {
  label: values.label ?? null,
  file: values.file,
  at: new Date().toISOString(),
  seconds: Math.round((performance.now() - started) / 100) / 10,
  nodes: manifest.nodes.length,
  parts: manifest.parts.length,
  assets: manifest.assets.length,
  assetBytes: manifest.assets.reduce((total, asset) => total + asset.byteLength, 0),
};
NodeFS.mkdirSync(values.out, { recursive: true });
NodeFS.appendFileSync(NodePath.join(values.out, "timings.jsonl"), `${JSON.stringify(run)}\n`);
console.log(JSON.stringify(run));
