// @effect-diagnostics nodeBuiltinImport:off - builds workspaces and reads fixtures from disk.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import type * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import type * as Path from "effect/Path";
import type * as Scope from "effect/Scope";
import { ServerConfig, layerTest } from "../config.ts";
import { make, type FeatureScriptPreviewOptions } from "./FeatureScriptPreviews.ts";

/**
 * Runs previews through the real worker thread. Failure modes covered: a path that leaves the
 * workspace (`..`, absolute, symlink) or doesn't exist; a script that doesn't parse; a warm worker
 * serving the source it loaded first instead of the edited file; a preview that never finishes
 * (the worker must be killed and replaced); artifact directories piling up.
 */
const corpus = new URL("../../../../packages/featurescript/corpus/bolt-circle/", import.meta.url);
const boltCircle = NodeFS.readFileSync(new URL("feature.fs", corpus), "utf8");
// The bolt circle's 100 x 60 x 10 mm plate, exported to STEP in millimeters.
const plateStep = NodeFS.readFileSync(new URL("plate.step", corpus));
const feature = (body: string) => `FeatureScript 3083;
import(path : "onshape/std/geometry.fs", version : "3083.0");
annotation { "Feature Type Name" : "Test" }
export const test = defineFeature(function(context is Context, id is Id, definition is map)
    precondition {}
    {
        ${body}
    });
`;
const cube = (size: number) =>
  feature(
    `fCuboid(context, id + "c", { "corner1" : vector(0, 0, 0) * millimeter, "corner2" : vector(${size}, ${size}, ${size}) * millimeter });`,
  );

const harness = Effect.fn("harness")(function* (
  files: Record<string, string | Uint8Array>,
  options: Partial<FeatureScriptPreviewOptions> = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "cadsense-fs-preview-" });
  for (const [name, contents] of Object.entries(files)) {
    NodeFS.mkdirSync(NodePath.dirname(NodePath.join(root, name)), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(root, name), contents);
  }
  const previews = yield* make(options);
  const config = yield* ServerConfig;
  return {
    root,
    runsDir: NodePath.join(config.attachmentsDir, "featurescript-previews"),
    write: (name: string, contents: string) =>
      NodeFS.writeFileSync(NodePath.join(root, name), contents),
    preview: (input: unknown) => previews.preview(root, input),
  };
});
const run = <A, E>(
  effect: Effect.Effect<
    A,
    E,
    FileSystem.FileSystem | Path.Path | Crypto.Crypto | Scope.Scope | ServerConfig
  >,
) =>
  effect.pipe(
    Effect.scoped,
    Effect.provide(
      layerTest(process.cwd(), { prefix: "cadsense-fs-preview-state-" }).pipe(
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
  );

describe("FeatureScriptPreviews", () => {
  it.live("previews a feature on a workspace STEP base and returns the image", () =>
    run(
      Effect.gen(function* () {
        const h = yield* harness({ "cad/bolt.fs": boltCircle, "cad/plate.step": plateStep });
        const { result, png } = yield* h.preview({
          path: "cad/bolt.fs",
          base: "cad/plate.step",
          parameters: {
            count: "8",
            face: 'qContainsPoint(qCreatedBy(makeId("Base"), EntityType.FACE), vector(50, 30, 10) * millimeter)',
          },
        });
        assert.equal(result.status, "OK");
        assert.include(result.summary, "Bolt circle (boltCircle in cad/bolt.fs): OK");
        assert.equal(result.solids.length, 1);
        // 60000 - 8 * PI * 2.5^2 * 10
        assert.closeTo(result.solids[0]!.volumeMm3, 58429.204, 1e-2);
        assert.equal(result.solids[0]!.faces, 14);
        assert.deepEqual([...png!.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
        assert.isTrue(NodeFS.existsSync(result.artifacts!.image));
        for (const file of ["top.png", "result.glb", "report.json"])
          assert.isTrue(NodeFS.existsSync(NodePath.join(result.artifacts!.directory, file)));
      }),
    ),
  );

  it.live("previews the edited script, not the source the warm worker loaded first", () =>
    run(
      Effect.gen(function* () {
        const h = yield* harness({ "cube.fs": cube(10) });
        const first = yield* h.preview({ path: "cube.fs" });
        h.write("cube.fs", cube(20));
        const second = yield* h.preview({ path: "cube.fs" });
        assert.deepEqual(
          [first, second].map(({ result }) => Math.round(result.solids[0]!.volumeMm3)),
          [1000, 8000],
        );
      }),
    ),
  );

  it.live("reports a script that doesn't parse with its workspace path and line", () =>
    run(
      Effect.gen(function* () {
        const h = yield* harness({ "cad/bad.fs": feature("var x = ;") });
        const { result, png } = yield* h.preview({ path: "cad/bad.fs" });
        assert.equal(result.status, "INVALID");
        assert.match(result.summary, /cad\/bad\.fs:7:\d+/);
        assert.isNull(result.artifacts);
        assert.isUndefined(png);
      }),
    ),
  );

  it.live("refuses files outside the workspace and names missing ones", () =>
    run(
      Effect.gen(function* () {
        const h = yield* harness({ "cube.fs": cube(10) });
        const outside = NodePath.join(
          NodePath.dirname(h.root),
          `${NodePath.basename(h.root)}-outside.fs`,
        );
        NodeFS.writeFileSync(outside, cube(10));
        NodeFS.symlinkSync(outside, NodePath.join(h.root, "link.fs"));
        try {
          for (const path of [`../${NodePath.basename(outside)}`, outside, "link.fs"]) {
            const error = yield* Effect.flip(h.preview({ path }));
            assert.equal(error.reason, "invalid-operation");
            assert.include(error.details, "inside the project workspace");
          }
          const missing = yield* Effect.flip(h.preview({ path: "cube.fs", base: "nope.step" }));
          assert.include(missing.details, "base nope.step doesn't exist");
        } finally {
          NodeFS.rmSync(outside);
        }
      }),
    ),
  );

  it.live("stops a preview that runs too long and serves the next one from a fresh worker", () =>
    run(
      Effect.gen(function* () {
        const h = yield* harness(
          {
            "slow.fs": feature(
              'for (var i = 0; i < 100000; i += 1) { fCuboid(context, id + ("c" ~ toString(i)), { "corner1" : vector(i, 0, 0) * millimeter, "corner2" : vector(i + 1, 1, 1) * millimeter }); }',
            ),
            "cube.fs": cube(10),
          },
          { timeout: "3 seconds" },
        );
        const slow = yield* h.preview({ path: "slow.fs" });
        assert.equal(slow.result.status, "STOPPED");
        assert.include(slow.result.summary, "took longer than 3s");
        const next = yield* h.preview({ path: "cube.fs" });
        assert.equal(next.result.status, "OK");
      }),
    ),
  );

  it.live("keeps only the newest artifact directories", () =>
    run(
      Effect.gen(function* () {
        const h = yield* harness({ "cube.fs": cube(10) }, { keepRuns: 2 });
        const runs = [];
        for (let i = 0; i < 3; i++) runs.push((yield* h.preview({ path: "cube.fs" })).result);
        assert.deepEqual(
          NodeFS.readdirSync(h.runsDir).toSorted(),
          runs.slice(1).map((result) => NodePath.basename(result.artifacts!.directory)),
        );
      }),
    ),
  );
});
