// @effect-diagnostics nodeBuiltinImport:off - builds workspaces and reads fixtures from disk.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import type * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type * as Path from "effect/Path";
import type * as Scope from "effect/Scope";
import { resolveAttachmentPathById } from "../attachmentStore.ts";
import { ServerConfig, layerTest } from "../config.ts";
import { make } from "./FeatureScriptPreviews.ts";

/**
 * The file panel's dialog parity with Onshape, through the real worker thread. Failure modes: an
 * INFO or WARNING status reaches the panel with no message, or an earlier feature's notice hides
 * the previewed one's.
 */
const feature = (name: string, body: string) => `FeatureScript 3083;
import(path : "onshape/std/geometry.fs", version : "3083.0");
annotation { "Feature Type Name" : "${name}" }
export const ${name.replaceAll(" ", "")} = defineFeature(function(context is Context, id is Id, definition is map)
    precondition
    {
        annotation { "Name" : "Count" }
        isInteger(definition.count, { (unitless) : [1, 2, 10] } as IntegerBoundSpec);
    }
    {
        ${body}
    });
`;
const cube =
  'fCuboid(context, id + "c", { "corner1" : vector(0, 0, 0) * millimeter, "corner2" : vector(10, 10, 10) * millimeter });';

/** The parts of a GLB's JSON chunk these tests read. */
const GltfJson = Schema.fromJsonString(
  Schema.Struct({
    materials: Schema.Array(Schema.Struct({ name: Schema.String })),
    meshes: Schema.Array(
      Schema.Struct({ primitives: Schema.Array(Schema.Struct({ material: Schema.Int })) }),
    ),
  }),
);
const decodeGltfJson = Schema.decodeUnknownEffect(GltfJson);

const harness = Effect.fn("harness")(function* (files: Record<string, string>) {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "cadsense-fs-parity-" });
  for (const [name, contents] of Object.entries(files)) {
    NodeFS.mkdirSync(NodePath.dirname(NodePath.join(root, name)), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(root, name), contents);
  }
  const previews = yield* make();
  const config = yield* ServerConfig;
  return {
    panel: (input: Omit<Parameters<typeof previews.panel>[0], "cwd">) =>
      previews.panel({ cwd: root, ...input }),
    attachment: (id: string) =>
      resolveAttachmentPathById({ attachmentsDir: config.attachmentsDir, attachmentId: id }),
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
      layerTest(process.cwd(), { prefix: "cadsense-fs-parity-state-" }).pipe(
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
  );

describe("FeatureScriptPreviews panel parity", () => {
  it.live("reports the previewed feature's INFO or WARNING message as the notice", () =>
    run(
      Effect.gen(function* () {
        const h = yield* harness({
          "earlier.fs": feature(
            "Earlier",
            'reportFeatureWarning(context, id, "Earlier is only a sketch.");',
          ),
        });
        const info = yield* h.panel({
          path: "wire.fs",
          source: feature(
            "Wire",
            `${cube}\n        reportFeatureInfo(context, id, "Add at least two waypoints to build the wire.");`,
          ),
        });
        assert.equal(info.status, "INFO");
        assert.isNull(info.failure);
        assert.deepEqual(info.notice, {
          status: "INFO",
          message: "Add at least two waypoints to build the wire.",
        });
        // An INFO keeps the feature's geometry: a 10 mm cube.
        assert.closeTo(info.changes!.volumeMm3, 1000, 1e-6);

        // The previewed feature is OK, so the earlier feature's warning shows, named.
        const earlier = yield* h.panel({
          path: "cube.fs",
          source: feature("Cube", cube),
          before: [{ path: "earlier.fs" }],
        });
        assert.equal(earlier.status, "WARNING");
        assert.deepEqual(earlier.notice, {
          status: "WARNING",
          message: "Earlier: Earlier is only a sketch.",
        });

        const ok = yield* h.panel({ path: "cube.fs", source: feature("Cube", cube) });
        assert.equal(ok.status, "OK");
        assert.isNull(ok.notice);
        assert.equal(ok.featureStatus, "OK");

        // An earlier step's failure is the worst status, but the dialog's rows take the previewed
        // feature's own: its warning blames the count.
        const h2 = yield* harness({
          "broken.fs": feature("Broken", 'throw regenError("Earlier broke");'),
        });
        const warned = yield* h2.panel({
          path: "warned.fs",
          source: feature(
            "Warned",
            `${cube}\n        reportFeatureWarning(context, id, "Count is high", ["count"]);`,
          ),
          before: [{ path: "broken.fs" }],
        });
        assert.deepEqual(
          [warned.status, warned.featureStatus, warned.inputs[0]!.faulty],
          ["ERROR", "WARNING", true],
        );
      }),
    ),
  );

  it.live("marks the inputs and list items the feature's status blames", () =>
    run(
      Effect.gen(function* () {
        const h = yield* harness({});
        const listFeature = `FeatureScript 3083;
import(path : "onshape/std/geometry.fs", version : "3083.0");
annotation { "Feature Type Name" : "Wire" }
export const wire = defineFeature(function(context is Context, id is Id, definition is map)
    precondition
    {
        annotation { "Name" : "Lead" }
        isLength(definition.lead, { (millimeter) : [0, 15, 1000] } as LengthBoundSpec);
        annotation { "Name" : "Waypoints", "Item name" : "Waypoint" }
        definition.waypoints is array;
        for (var waypoint in definition.waypoints)
        {
            annotation { "Name" : "Z offset" }
            isLength(waypoint.z, ZERO_DEFAULT_LENGTH_BOUNDS);
        }
    }
    {
        if (size(definition.waypoints) < 2)
            throw regenError("Add at least two waypoints", ["waypoints"]);
        throw regenError("Waypoint 2 sits on waypoint 1", ["lead", faultyArrayParameterId("waypoints", 1, "z")]);
    });
`;
        const few = yield* h.panel({ path: "wire.fs", source: listFeature });
        assert.equal(few.status, "ERROR");
        assert.deepEqual(
          few.inputs.map((input) => [input.id, input.faulty]),
          [
            ["lead", false],
            ["waypoints", true],
          ],
        );
        const two = yield* h.panel({
          path: "wire.fs",
          source: listFeature,
          parameters: { waypoints: "[{}, {}]" },
        });
        const waypoints = two.inputs.find((input) => input.id === "waypoints")!;
        assert.deepEqual(
          [two.inputs.map((input) => input.faulty), waypoints.items.map((item) => item[0]!.faulty)],
          [
            [true, false],
            [false, true],
          ],
        );
      }),
    ),
  );

  it.live("draws a failed feature's error entities in the after model", () =>
    run(
      Effect.gen(function* () {
        const h = yield* harness({});
        const failed = yield* h.panel({
          path: "tool.fs",
          source: feature(
            "Tool",
            `${cube}\n        throw regenError("The tool hits the plate", ["count"], qCreatedBy(id + "c", EntityType.BODY));`,
          ),
        });
        assert.equal(failed.status, "ERROR");
        assert.equal(failed.failure!.message, "The tool hits the plate");
        assert.equal(failed.errorEntities, 1);
        assert.deepEqual(
          failed.inputs.map((input) => input.faulty),
          [true],
        );
        // Rolled back, so nothing is left but the cube drawn in the error material, outlined.
        const glb = NodeFS.readFileSync(h.attachment(failed.model!.after!)!);
        const json = yield* decodeGltfJson(
          glb.subarray(20, 20 + glb.readUInt32LE(12)).toString("utf8"),
        );
        assert.deepEqual(
          json.meshes.flatMap((mesh) =>
            mesh.primitives.map((primitive) => json.materials[primitive.material]?.name),
          ),
          ["error", "outline"],
        );
        const ok = yield* h.panel({ path: "cube.fs", source: feature("Cube", cube) });
        assert.equal(ok.errorEntities, 0);
      }),
    ),
  );

  it.live(
    "runs the editing logic when an input changes and returns its state for the next run",
    () =>
      run(
        Effect.gen(function* () {
          // Failure modes: the panel's runs never call the logic; the state it returns is lost, so a
          // value the logic set reverts at the next edit; the dialog shows the person's value
          // instead of the logic's.
          const h = yield* harness({});
          const source = `FeatureScript 3083;
import(path : "onshape/std/geometry.fs", version : "3083.0");
annotation { "Feature Type Name" : "Doubler", "Editing Logic Function" : "doublerLogic" }
export const doubler = defineFeature(function(context is Context, id is Id, definition is map)
    precondition
    {
        annotation { "Name" : "Width" }
        isLength(definition.width, LENGTH_BOUNDS);
        annotation { "Name" : "Height" }
        isLength(definition.height, LENGTH_BOUNDS);
    }
    {
        fCuboid(context, id + "c", { "corner1" : vector(0, 0, 0) * meter, "corner2" : vector(definition.width, definition.width, definition.height) });
    });

export function doublerLogic(context is Context, id is Id, oldDefinition is map, definition is map, specifiedParameters is map) returns map
{
    if (oldDefinition.width != definition.width && !specifiedParameters.height)
        definition.height = definition.width * 2;
    return definition;
}
`;
          const heights = (preview: typeof opened) =>
            preview.inputs.find((input) => input.id === "height")?.value;
          // Opening the dialog calls the logic with oldDefinition {}, so the default 25 mm width
          // counts as changed.
          const opened = yield* h.panel({ path: "doubler.fs", source });
          assert.equal(heights(opened), "50 mm");
          assert.deepEqual(opened.editing, { parameters: {}, edited: { height: "0.05 * meter" } });
          const widened = yield* h.panel({
            path: "doubler.fs",
            source,
            parameters: { width: "10 * millimeter" },
            editing: opened.editing,
          });
          assert.equal(heights(widened), "20 mm");
          // A 10 x 10 x 20 mm block.
          assert.closeTo(widened.changes!.volumeMm3, 2000, 1e-6);
          assert.deepEqual(widened.editing, {
            parameters: { width: "10 * millimeter" },
            edited: { height: "0.02 * meter" },
          });
          // Saving the file again changes no input: the logic doesn't run, and its value stays.
          const resaved = yield* h.panel({
            path: "doubler.fs",
            source,
            parameters: { width: "10 * millimeter" },
            editing: widened.editing,
          });
          assert.equal(heights(resaved), "20 mm");
          // Width 12 mm: the logic sets the height to 24 mm. The person sets 20 mm again, the same
          // text as before, and says so; the height is theirs again.
          const twelve = yield* h.panel({
            path: "doubler.fs",
            source,
            parameters: { width: "12 * millimeter" },
            editing: resaved.editing,
          });
          assert.equal(heights(twelve), "24 mm");
          const overridden = { width: "12 * millimeter", height: "20 * millimeter" };
          const mine = yield* h.panel({
            path: "doubler.fs",
            source,
            parameters: overridden,
            editing: twelve.editing,
          });
          assert.equal(heights(mine), "20 mm");
          const widerAgain = yield* h.panel({
            path: "doubler.fs",
            source,
            parameters: { ...overridden, width: "13 * millimeter" },
            editing: mine.editing,
          });
          // The person's height stays when the width changes (specifiedParameters.height).
          assert.equal(heights(widerAgain), "20 mm");
          const resetLogic = yield* h.panel({
            path: "doubler.fs",
            source: source.replace("&& !specifiedParameters.height", ""),
            parameters: { ...overridden, width: "14 * millimeter" },
            editing: widerAgain.editing,
          });
          assert.equal(heights(resetLogic), "28 mm");
          const again = yield* h.panel({
            path: "doubler.fs",
            source: source.replace("&& !specifiedParameters.height", ""),
            parameters: { ...overridden, width: "14 * millimeter" },
            editing: resetLogic.editing,
            touched: ["height"],
          });
          assert.equal(heights(again), "20 mm");
          // A feature without editing logic has no state to keep.
          const plain = yield* h.panel({ path: "cube.fs", source: feature("Cube", cube) });
          assert.isNull(plain.editing);
        }),
      ),
  );

  it.live("reads #variables an earlier feature set, and shows the reference in the dialog", () =>
    run(
      Effect.gen(function* () {
        const h = yield* harness({
          "variables.fs": feature("Variables", 'setVariable(context, "holes", 4);'),
        });
        const counted = yield* h.panel({
          path: "count.fs",
          source: feature(
            "Counted",
            `${cube}\n        setVariable(context, "seen", definition.count);`,
          ),
          parameters: { count: "#holes + 1" },
          before: [{ path: "variables.fs" }],
        });
        assert.equal(counted.status, "OK");
        assert.equal(counted.inputs[0]!.value, "#holes + 1");
        // An editing logic that replaces the reference: the dialog shows its value instead.
        const replacing = `${feature("Replaced", cube).replace(
          '"Feature Type Name" : "Replaced"',
          '"Feature Type Name" : "Replaced", "Editing Logic Function" : "replacedLogic"',
        )}
export function replacedLogic(context is Context, id is Id, oldDefinition is map, definition is map) returns map
{
    definition.count = 7;
    return definition;
}
`;
        const replaced = yield* h.panel({
          path: "replaced.fs",
          source: replacing,
          parameters: { count: "#holes + 1" },
          before: [{ path: "variables.fs" }],
        });
        assert.equal(replaced.inputs[0]!.value, "7");
        const missing = yield* h.panel({
          path: "count.fs",
          source: feature("Counted", cube),
          parameters: { count: "#nope" },
        });
        assert.equal(missing.status, "ERROR");
        assert.match(missing.failure!.message, /nope/);
        assert.isTrue(missing.inputs[0]!.faulty);
      }),
    ),
  );

  it.live("returns a feature's manipulators and runs its change function for a dragged one", () =>
    run(
      Effect.gen(function* () {
        // Wire run's pattern: a triad per waypoint, whose change function writes the waypoint's
        // offsets. Failure modes: manipulators missing from the panel's result, or not sendable
        // back; the change not reaching the feature; the list input it changed not returned as an
        // input the panel can keep.
        const h = yield* harness({});
        const source = `FeatureScript 3083;
import(path : "onshape/std/geometry.fs", version : "3083.0");
annotation { "Feature Type Name" : "Blocks", "Manipulator Change Function" : "blocksChange" }
export const blocks = defineFeature(function(context is Context, id is Id, definition is map)
    precondition
    {
        annotation { "Name" : "Waypoints", "Item name" : "Waypoint" }
        definition.waypoints is array;
        for (var waypoint in definition.waypoints)
        {
            annotation { "Name" : "X offset" }
            isLength(waypoint.x, ZERO_DEFAULT_LENGTH_BOUNDS);
            annotation { "Name" : "Y offset" }
            isLength(waypoint.y, ZERO_DEFAULT_LENGTH_BOUNDS);
            annotation { "Name" : "Z offset" }
            isLength(waypoint.z, ZERO_DEFAULT_LENGTH_BOUNDS);
        }
    }
    {
        for (var i = 0; i < size(definition.waypoints); i += 1)
        {
            const at = vector(definition.waypoints[i].x, definition.waypoints[i].y, definition.waypoints[i].z);
            addManipulators(context, id, { ("waypoint" ~ i) : triadManipulator({ "base" : vector(0, 0, 0) * meter, "offset" : at }) });
            fCuboid(context, id + ("block" ~ i), { "corner1" : at, "corner2" : at + vector(1, 1, 1) * millimeter });
        }
    });

export function blocksChange(context is Context, definition is map, newManipulators is map) returns map
{
    for (var i = 0; i < size(definition.waypoints); i += 1)
    {
        const manipulator = newManipulators["waypoint" ~ i];
        if (manipulator == undefined)
            continue;
        definition.waypoints[i].x = manipulator.offset[0];
        definition.waypoints[i].y = manipulator.offset[1];
        definition.waypoints[i].z = manipulator.offset[2];
    }
    return definition;
}
`;
        const parameters = { waypoints: "[{}, {}]" };
        const first = yield* h.panel({ path: "blocks.fs", source, parameters });
        assert.deepEqual(
          first.manipulators.map(({ key, type, fields }) => [key, type, fields.offset]),
          [
            ["waypoint0", "LINEAR_3D", [0, 0, 0]],
            ["waypoint1", "LINEAR_3D", [0, 0, 0]],
          ],
        );
        const dragged = yield* h.panel({
          path: "blocks.fs",
          source,
          parameters,
          manipulatorChange: {
            key: "waypoint1",
            manipulator: first.manipulators[1]!.expression!,
            changes: { offset: "vector(5, 0, 2) * millimeter" },
          },
        });
        assert.equal(dragged.status, "OK");
        // The second block moved to (5, 0, 2) mm.
        assert.deepEqual(
          // Bounds may sit a tessellation's deflection outside; `+ 0` turns -0 into 0.
          dragged.solids.map((solid) => solid.boundsMm.min.map((mm) => Math.round(mm) + 0)),
          [
            [0, 0, 0],
            [5, 0, 2],
          ],
        );
        assert.deepEqual(
          dragged.inputs[0]!.items.map((item) => item.map((input) => input.value)),
          [
            ["0 mm", "0 mm", "0 mm"],
            ["5 mm", "0 mm", "2 mm"],
          ],
        );
        // The list as the change set it, which runs the same again.
        const kept = yield* h.panel({ path: "blocks.fs", source, parameters: dragged.parameters! });
        assert.deepEqual(
          kept.solids.map((solid) => Math.round(solid.boundsMm.min[0]) + 0),
          [0, 5],
        );
      }),
    ),
  );
});
