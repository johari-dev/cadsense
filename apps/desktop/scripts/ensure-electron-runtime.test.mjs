import { assert, describe, it } from "vite-plus/test";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { extractElectronArchive } from "./ensure-electron-runtime.mjs";

const archive = Buffer.from(
  "UEsDBBQAAAAIAJC5JV1pzMIQHgAAABwAAAALAAAAcGF5bG9hZC50eHRzdnRRKCrNK8nMTVVILErOyCxLVUjLrCgpLUrlAgBQSwECFAAUAAAACACQuSVdaczCEB4AAAAcAAAACwAAAAAAAAAAAAAAAAAAAAAAcGF5bG9hZC50eHRQSwUGAAAAAAEAAQA5AAAARwAAAAAA",
  "base64",
);

describe("Electron runtime repair", () => {
  it("extracts an actual archive into a path with spaces without Python", () => {
    const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "cad runtime archive "));
    try {
      const zipPath = NodePath.join(directory, "runtime.zip");
      const destination = NodePath.join(directory, "runtime files");
      NodeFS.writeFileSync(zipPath, archive);
      extractElectronArchive(zipPath, destination);
      assert.equal(
        NodeFS.readFileSync(NodePath.join(destination, "payload.txt"), "utf8").trim(),
        "CAD runtime archive fixture",
      );
    } finally {
      NodeFS.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("runs as a CLI but has no repair side effects when imported", () => {
    const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "cad runtime entry "));
    try {
      const script = NodePath.join(directory, "ensure-electron-runtime.mjs");
      NodeFS.copyFileSync(new URL("./ensure-electron-runtime.mjs", import.meta.url), script);
      const options = { encoding: "utf8", env: { ...process.env, NODE_PATH: "" } };
      const imported = NodeChildProcess.spawnSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `await import(${JSON.stringify(NodeURL.pathToFileURL(script).href)})`,
        ],
        options,
      );
      assert.equal(imported.status, 0, imported.stderr);
      const invoked = NodeChildProcess.spawnSync(process.execPath, [script], options);
      // The isolated script has no Electron package: reaching this error proves the CLI ran,
      // without downloading anything or mutating the checkout's runtime.
      assert.equal(invoked.status, 1, invoked.stderr);
      assert.include(invoked.stderr, "Cannot find module 'electron/package.json'");
    } finally {
      NodeFS.rmSync(directory, { recursive: true, force: true });
    }
  });
});
