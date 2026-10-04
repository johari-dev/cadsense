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
import { ThreadId } from "@cadsense/contracts";
import { resolveAttachmentPathById } from "../attachmentStore.ts";
import { ServerConfig, layerTest } from "../config.ts";
import { make, type FeatureScriptPreviewOptions } from "./FeatureScriptPreviews.ts";

/**
 * Runs previews through the real worker thread. Failure modes covered: a path that leaves the
 * workspace (`..`, absolute, symlink) or doesn't exist; a script that doesn't parse; a warm worker
 * serving the source it loaded first instead of the edited file; a preview that never finishes
 * (the worker must be killed and replaced); artifact directories piling up.
 *
 * The file panel's previews add: running the file on disk instead of the editor's unsaved text; a
 * failure inside std reported at std's line instead of the user's; "before" showing the feature, or
 * "after" missing it; an empty model written as an unreadable GLB; the dialog showing inputs the
 * feature's own `if`s hide, or values other than the ones it ran with; panel models piling up in
 * the attachments directory, or pruning taking other attachments with them, or a model the panel
 * still shows (the last good run under a burst of failures); a model id the asset
 * route can't resolve; a feature that deletes everything losing its "before" model too. The agent's chat card adds:
 * images that aren't attachments of the thread, so they can't load or outlive it.
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
const FACE =
  'qContainsPoint(qCreatedBy(makeId("Base"), EntityType.FACE), vector(50, 30, 10) * millimeter)';
const isGlb = (path: string | null) =>
  path !== null && NodeFS.readFileSync(path).subarray(0, 4).toString("latin1") === "glTF";
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
    preview: (input: unknown, threadId?: ThreadId) => previews.preview(root, input, threadId),
    panel: (input: Omit<Parameters<typeof previews.panel>[0], "cwd">) =>
      previews.panel({ cwd: root, ...input }),
    attachment: (id: string) =>
      resolveAttachmentPathById({ attachmentsDir: config.attachmentsDir, attachmentId: id }),
    attachmentsDir: config.attachmentsDir,
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

  it.live("panel: runs the editor's text with before and after models and the change", () =>
    run(
      Effect.gen(function* () {
        const h = yield* harness({ "cad/bolt.fs": cube(10), "cad/plate.step": plateStep });
        // The file on disk is a cube; the editor holds the bolt circle, unsaved.
        const preview = yield* h.panel({
          path: "cad/bolt.fs",
          source: boltCircle,
          base: "cad/plate.step",
          parameters: { face: FACE },
        });
        assert.equal(preview.status, "OK");
        assert.isNull(preview.failure);
        assert.deepEqual(preview.features, [{ name: "boltCircle", typeName: "Bolt circle" }]);
        assert.equal(preview.feature, "boltCircle");
        // Six 5 mm holes through 10 mm: 6 * PI * 2.5^2 * 10 removed, six hole walls made.
        assert.closeTo(preview.changes!.volumeMm3, -6 * Math.PI * 2.5 ** 2 * 10, 1e-3);
        assert.equal(preview.changes!.createdFaces, 6);
        assert.isTrue(isGlb(h.attachment(preview.model!.after!)));
        assert.isTrue(isGlb(h.attachment(preview.model!.before!)));
        assert.notEqual(preview.model!.after, preview.model!.before);
      }),
    ),
  );

  it.live(
    "panel: reads the dialog with the values the feature ran with and hides what its ifs hide",
    () =>
      run(
        Effect.gen(function* () {
          const h = yield* harness({ "bolt.fs": boltCircle, "plate.step": plateStep });
          const dialog = (parameters: Record<string, string>) =>
            h
              .panel({ path: "bolt.fs", source: boltCircle, base: "plate.step", parameters })
              .pipe(
                Effect.map(({ inputs }) =>
                  Object.fromEntries(inputs.map((input) => [input.id, input])),
                ),
              );
          const through = yield* dialog({ face: FACE, holeDiameter: "5.5 * millimeter" });
          assert.equal(through.holeDiameter!.value, "5.5 mm");
          assert.equal(through.count!.value, "6");
          assert.equal(through.startAngle!.value, "0 deg");
          assert.equal(through.throughAll!.value, "true");
          assert.equal(through.face!.kind, "query");
          assert.equal(through.face!.filter, "EntityType.FACE && GeometryType.PLANE");
          assert.isFalse(through.depth!.visible);
          const blind = yield* dialog({ face: FACE, throughAll: "false" });
          assert.isTrue(blind.depth!.visible);
        }),
      ),
  );

  it.live("panel: locates a failure inside std at the user's line, and syntax errors too", () =>
    run(
      Effect.gen(function* () {
        const h = yield* harness({ "plate.step": plateStep });
        // The hole centers lose their units, so std's skCircle precondition fails.
        const unitless = boltCircle.replace(
          "vector(cos(angle), sin(angle)) * radius",
          "vector(cos(angle), sin(angle))",
        );
        const line = unitless.split("\n").findIndex((text) => text.includes("skCircle(")) + 1;
        const failed = yield* h.panel({
          path: "cad/bolt.fs",
          source: unitless,
          base: "plate.step",
          parameters: { face: FACE },
        });
        assert.equal(failed.status, "ERROR");
        assert.equal(failed.failure!.location!.path, "cad/bolt.fs");
        assert.equal(failed.failure!.location!.line, line);
        assert.include(failed.failure!.message, "skCircle");
        // The feature rolled back, so the model is the plate as it was.
        assert.isTrue(isGlb(h.attachment(failed.model!.after!)));
        assert.equal(failed.inputs.length, 7);

        const invalid = yield* h.panel({ path: "cad/bad.fs", source: feature("var x = ;") });
        assert.equal(invalid.status, "INVALID");
        assert.deepEqual(invalid.failure!.location, { path: "cad/bad.fs", line: 7, column: 17 });
        assert.isNull(invalid.model);
        assert.deepEqual(invalid.inputs, []);
      }),
    ),
  );

  it.live("panel: writes no model for nothing, refuses paths outside the workspace", () =>
    run(
      Effect.gen(function* () {
        const h = yield* harness({});
        const empty = yield* h.panel({ path: "empty.fs", source: feature("") });
        assert.equal(empty.status, "OK");
        assert.isNull(empty.model);
        for (const path of ["../outside.fs", "/tmp/outside.fs"]) {
          const error = yield* Effect.flip(h.panel({ path, source: cube(10) }));
          assert.equal(error.reason, "invalid-operation");
          assert.include(error.details, "inside the project workspace");
        }
        const missing = yield* Effect.flip(
          h.panel({ path: "cube.fs", source: cube(10), base: "nope.step" }),
        );
        assert.include(missing.details, "base nope.step doesn't exist");
      }),
    ),
  );

  it.live("panel: keeps only the newest models, and nothing else that shares their prefix", () =>
    run(
      Effect.gen(function* () {
        const h = yield* harness({}, { keepPanelModels: 2, keepPanelModelsFor: 0 });
        // A chat image of a thread whose id happens to start with the models' prefix.
        const bystander = "fspanel-000-chat-00000000-0000-4000-8000-000000000000";
        NodeFS.mkdirSync(h.attachmentsDir, { recursive: true });
        NodeFS.writeFileSync(NodePath.join(h.attachmentsDir, `${bystander}.png`), "png");
        const ids = [];
        for (let i = 0; i < 3; i++)
          ids.push((yield* h.panel({ path: "cube.fs", source: cube(10 + i) })).model!.after!);
        assert.isNull(h.attachment(ids[0]!));
        assert.isNotNull(h.attachment(ids[1]!));
        assert.isNotNull(h.attachment(ids[2]!));
        assert.isNotNull(h.attachment(bystander));
      }),
    ),
  );

  it.live("panel: keeps recent models past the count, since the panel may still show them", () =>
    run(
      Effect.gen(function* () {
        // A burst of failing saves must not prune the last good run the panel shows greyed out.
        const h = yield* harness({}, { keepPanelModels: 2 });
        const ids = [];
        for (let i = 0; i < 3; i++)
          ids.push((yield* h.panel({ path: "cube.fs", source: cube(10 + i) })).model!.after!);
        for (const id of ids) assert.isNotNull(h.attachment(id));
      }),
    ),
  );

  it.live("panel: never keeps more than five times the count, however recent", () =>
    run(
      Effect.gen(function* () {
        const h = yield* harness({}, { keepPanelModels: 1 });
        const ids = [];
        // A cube on nothing writes only an "after" model, one file per run.
        for (let i = 0; i < 6; i++)
          ids.push((yield* h.panel({ path: "cube.fs", source: cube(10 + i) })).model!.after!);
        assert.isNull(h.attachment(ids[0]!));
        for (const id of ids.slice(1)) assert.isNotNull(h.attachment(id));
      }),
    ),
  );

  it.live("panel: a feature that deletes everything still has a model before it", () =>
    run(
      Effect.gen(function* () {
        const h = yield* harness({ "plate.step": plateStep });
        const preview = yield* h.panel({
          path: "delete.fs",
          source: feature(
            'opDeleteBodies(context, id + "delete", { "entities" : qEverything(EntityType.BODY) });',
          ),
          base: "plate.step",
        });
        assert.equal(preview.status, "OK");
        assert.closeTo(preview.changes!.volumeMm3, -60000, 1e-3);
        assert.isNull(preview.model!.after);
        assert.isTrue(isGlb(h.attachment(preview.model!.before!)));
      }),
    ),
  );

  it.live("agent: builds the chat card with the failure's line and thread image attachments", () =>
    run(
      Effect.gen(function* () {
        const h = yield* harness({ "bolt.fs": boltCircle, "plate.step": plateStep });
        const threadId = ThreadId.make("thread-fs-card");
        const { result, card } = yield* h.preview(
          { path: "bolt.fs", base: "plate.step", parameters: { face: FACE, count: "4" } },
          threadId,
        );
        assert.equal(result.status, "OK");
        assert.equal(result.changes!.createdFaces, 4);
        assert.equal(card!.status, "OK");
        assert.equal(card!.feature, "boltCircle");
        assert.equal(card!.typeName, "Bolt circle");
        assert.equal(card!.base, "plate.step");
        assert.deepEqual(card!.parameters, { face: FACE, count: "4" });
        assert.deepEqual(
          card!.images.map((image) => image.view),
          ["iso", "top", "front", "right"],
        );
        for (const image of card!.images) {
          assert.match(image.attachmentId, /^thread-fs-card-/);
          assert.isNotNull(h.attachment(image.attachmentId));
        }
        // A script that doesn't load still names the feature the agent asked for.
        const invalid = yield* h.preview(
          { path: "bolt.fs", feature: "boltCircle", parameters: { count: "nope(" } },
          threadId,
        );
        assert.equal(invalid.result.status, "INVALID");
        assert.equal(invalid.card!.feature, "boltCircle");
        const noCard = yield* h.preview({ path: "bolt.fs" });
        assert.isUndefined(noCard.card);
        const failed = yield* h.preview({ path: "missing-face.fs" }, threadId).pipe(Effect.flip);
        assert.equal(failed.reason, "invalid-operation");
      }),
    ),
  );
});
