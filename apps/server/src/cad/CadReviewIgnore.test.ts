import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { readCadReviewIgnore } from "./CadReviewIgnore.ts";

const workspace = Effect.fn(function* (contents: string | null) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "cadsense-review-ignore-" });
  if (contents !== null) yield* fs.writeFileString(path.join(root, "cadsense.json"), contents);
  return root;
});

it.effect("reads reviewIgnore from cadsense.json and treats missing or invalid files as none", () =>
  Effect.gen(function* () {
    const valid = yield* workspace(`{
      // comments and trailing commas are fine
      "reviewIgnore": [{ "name": "*bolt*" },],
    }`);
    assert.deepEqual(yield* readCadReviewIgnore(valid), [{ name: "*bolt*" }]);
    assert.deepEqual(yield* readCadReviewIgnore(yield* workspace('{ "iconPath": "a.svg" }')), []);
    assert.deepEqual(yield* readCadReviewIgnore(yield* workspace(null)), []);
    assert.deepEqual(yield* readCadReviewIgnore(yield* workspace('{ "reviewIgnore": [{}] }')), []);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
