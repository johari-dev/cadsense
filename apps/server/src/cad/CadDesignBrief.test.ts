import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Scope from "effect/Scope";

import { CAD_DESIGN_BRIEF_MAX_BYTES, readCadDesignBrief } from "./CadDesignBrief.ts";

const workspace = Effect.fn("workspace")(function* (files: Record<string, string | Uint8Array>) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "cadsense-design-brief-" });
  for (const [relativePath, contents] of Object.entries(files)) {
    const absolutePath = path.join(root, relativePath);
    yield* fileSystem.makeDirectory(path.dirname(absolutePath), { recursive: true });
    yield* typeof contents === "string"
      ? fileSystem.writeFileString(absolutePath, contents)
      : fileSystem.writeFile(absolutePath, contents);
  }
  return root;
});

const run = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path | Scope.Scope>) =>
  effect.pipe(Effect.scoped, Effect.provide(NodeServices.layer));

it.effect("reads DESIGN.md at the workspace root by default", () =>
  run(
    Effect.gen(function* () {
      const text = "\n# Arm\n\nThe motor rides on the stage.\n";
      const root = yield* workspace({ "DESIGN.md": text });
      assert.deepEqual(yield* readCadDesignBrief(root), {
        path: "DESIGN.md",
        bytes: text.length,
        content: text.trim(),
      });
    }),
  ),
);

it.effect("reads the path configured in cadsense.json", () =>
  run(
    Effect.gen(function* () {
      const root = yield* workspace({
        "cadsense.json": '{ "designBrief": "docs/brief.md" }',
        "DESIGN.md": "not this one",
        "docs/brief.md": "Rulebook limit: 120 in extension.",
      });
      const brief = yield* readCadDesignBrief(root);
      assert.equal(brief?.path, "docs/brief.md");
      assert.equal(brief?.content, "Rulebook limit: 120 in extension.");
    }),
  ),
);

it.effect("returns null when no brief file exists", () =>
  run(
    Effect.gen(function* () {
      assert.isNull(yield* readCadDesignBrief(yield* workspace({})));
      assert.isNull(
        yield* readCadDesignBrief(
          yield* workspace({ "cadsense.json": '{ "designBrief": "docs/missing.md" }' }),
        ),
      );
    }),
  ),
);

it.effect("rejects brief paths that leave the workspace", () =>
  run(
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const parent = yield* workspace({ "outside.md": "secret" });
      const root = yield* workspace({});
      const traversal = path.relative(root, path.join(parent, "outside.md"));
      for (const designBrief of [traversal, path.join(parent, "outside.md")]) {
        const configured = yield* workspace({
          "cadsense.json": `{ "designBrief": "${designBrief}" }`,
          "DESIGN.md": "fallback must not be used either",
        });
        assert.isNull(yield* readCadDesignBrief(configured), designBrief);
      }
    }),
  ),
);

it.effect("truncates oversized briefs at the byte cap without splitting a character", () =>
  run(
    Effect.gen(function* () {
      // Two-byte characters so a byte cut can land mid-sequence.
      const text = "é".repeat(CAD_DESIGN_BRIEF_MAX_BYTES);
      const root = yield* workspace({ "DESIGN.md": text });
      const brief = yield* readCadDesignBrief(root);
      assert.equal(brief?.bytes, CAD_DESIGN_BRIEF_MAX_BYTES * 2);
      const [kept, note] = brief!.content.split("\n\n");
      assert.equal(kept, "é".repeat(CAD_DESIGN_BRIEF_MAX_BYTES / 2));
      assert.equal(
        note,
        `[Design brief truncated at 16 KiB; the file is ${CAD_DESIGN_BRIEF_MAX_BYTES * 2} bytes.]`,
      );
      assert.notInclude(brief!.content, "�");
    }),
  ),
);

it.effect("treats an empty brief as no brief", () =>
  run(
    Effect.gen(function* () {
      assert.isNull(yield* readCadDesignBrief(yield* workspace({ "DESIGN.md": " \n\n " })));
    }),
  ),
);

it.effect("falls back to the default path when cadsense.json is malformed", () =>
  run(
    Effect.gen(function* () {
      const root = yield* workspace({ "cadsense.json": "{ not json", "DESIGN.md": "Brief" });
      assert.equal((yield* readCadDesignBrief(root))?.content, "Brief");
    }),
  ),
);

it.effect("never fails the caller when the brief cannot be read", () =>
  run(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* workspace({});
      yield* fileSystem.makeDirectory(path.join(root, "DESIGN.md"));
      assert.isNull(yield* readCadDesignBrief(root));
    }),
  ),
);
