import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { readCadReviewScopes } from "./CadReviewScopes.ts";

const workspace = Effect.fn(function* (contents: string | null) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "cadsense-review-scopes-" });
  if (contents !== null) yield* fs.writeFileString(path.join(root, "cadsense.json"), contents);
  return root;
});

it.effect(
  "reads review scopes from cadsense.json and treats missing or invalid files as none",
  () =>
    Effect.gen(function* () {
      const valid = yield* workspace(`{
      // comments and trailing commas are fine
      "reviewScopes": [{ "match": { "name": "*bolt*" }, "ignore": true },],
    }`);
      assert.deepEqual(yield* readCadReviewScopes(valid), [
        { match: { name: "*bolt*" }, ignore: true },
      ]);
      assert.deepEqual(yield* readCadReviewScopes(yield* workspace('{ "iconPath": "a.svg" }')), []);
      assert.deepEqual(yield* readCadReviewScopes(yield* workspace(null)), []);
      assert.deepEqual(
        yield* readCadReviewScopes(
          yield* workspace('{ "reviewScopes": [{ "match": { "name": "Bolt" } }] }'),
        ),
        [],
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
