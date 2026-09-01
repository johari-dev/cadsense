// @effect-diagnostics nodeBuiltinImport:off - Tests exercise root env file precedence directly.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { loadRepoEnv } from "./repo-env.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
});

describe("loadRepoEnv", () => {
  it("returns only the process environment for an unconfigured clone", () => {
    expect(
      loadRepoEnv({
        baseEnv: { CADSENSE_TEST_VALUE: "process" },
        repoRoot: makeTemporaryDirectory(),
      }),
    ).toEqual({ CADSENSE_TEST_VALUE: "process" });
  });

  it("applies process, root local, and root precedence in that order", () => {
    const repoRoot = makeTemporaryDirectory();
    NodeFS.writeFileSync(
      NodePath.join(repoRoot, ".env"),
      "CADSENSE_ROOT_ONLY=root\nCADSENSE_SHARED=root\n",
    );
    NodeFS.writeFileSync(
      NodePath.join(repoRoot, ".env.local"),
      "CADSENSE_LOCAL_ONLY=local\nCADSENSE_SHARED=local\n",
    );

    expect(
      loadRepoEnv({
        baseEnv: { CADSENSE_PROCESS_ONLY: "process", CADSENSE_SHARED: "process" },
        repoRoot,
      }),
    ).toEqual({
      CADSENSE_ROOT_ONLY: "root",
      CADSENSE_LOCAL_ONLY: "local",
      CADSENSE_PROCESS_ONLY: "process",
      CADSENSE_SHARED: "process",
    });
  });
});

function makeTemporaryDirectory() {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "cadsense-repo-env-"));
  temporaryDirectories.push(directory);
  return directory;
}
