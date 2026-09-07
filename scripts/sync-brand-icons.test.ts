// @effect-diagnostics-next-line nodeBuiltinImport:off - Asset copying runs directly in Node without an Effect runtime.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
// @effect-diagnostics-next-line nodeBuiltinImport:off - Asset paths are resolved by this standalone Node utility.
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { POC_ICON_COPIES, syncBrandIcons } from "./sync-brand-icons.ts";

const temporaryRoots: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => NodeFSP.rm(root, { recursive: true, force: true })),
  );
});

async function originalIconsFixture() {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "cadsense-icon-sync-"));
  temporaryRoots.push(root);
  for (const source of new Set(POC_ICON_COPIES.map(([source]) => source))) {
    await NodeFSP.mkdir(NodePath.dirname(NodePath.join(root, source)), { recursive: true });
    await NodeFSP.writeFile(NodePath.join(root, source), `original bytes of ${source}`);
  }
  return root;
}

describe("original PoC icons", () => {
  it("ships complete ICO image payloads in the canonical originals", async () => {
    const originals = new Set(POC_ICON_COPIES.map(([source]) => source));
    for (const source of originals) {
      if (!source.endsWith(".ico")) continue;
      const bytes = await NodeFSP.readFile(new URL(`../${source}`, import.meta.url));
      expect(bytes.readUInt16LE(0)).toBe(0);
      expect(bytes.readUInt16LE(2)).toBe(1);
      const count = bytes.readUInt16LE(4);
      expect(count).toBeGreaterThan(0);
      const directoryEnd = 6 + count * 16;
      expect(directoryEnd).toBeLessThan(bytes.length);
      for (let index = 0; index < count; index++) {
        const entry = 6 + index * 16;
        const size = bytes.readUInt32LE(entry + 8);
        const offset = bytes.readUInt32LE(entry + 12);
        expect(size).toBeGreaterThan(0);
        expect(offset).toBeGreaterThanOrEqual(directoryEnd);
        expect(offset + size).toBeLessThanOrEqual(bytes.length);
      }
    }
  });

  it("restores every brand and the development renderer without changing original bytes", async () => {
    const root = await originalIconsFixture();
    expect(await syncBrandIcons(root, false)).toBe(17);
    await expect(syncBrandIcons(root, true)).resolves.toBe(17);
    for (const [source, target] of POC_ICON_COPIES) {
      expect(await NodeFSP.readFile(NodePath.join(root, target))).toEqual(
        await NodeFSP.readFile(NodePath.join(root, source)),
      );
    }
    expect(await NodeFSP.readFile(NodePath.join(root, "apps/web/public/app-icon.png"))).toEqual(
      await NodeFSP.readFile(NodePath.join(root, "assets/cadsense/logo-180.png")),
    );
  });

  it("reports changed and missing outputs without modifying them", async () => {
    const root = await originalIconsFixture();
    await syncBrandIcons(root, false);
    const changed = "apps/web/public/app-icon.png";
    const missing = "assets/nightly/nightly-windows.ico";
    await NodeFSP.writeFile(NodePath.join(root, changed), "incorrect icon");
    await NodeFSP.rm(NodePath.join(root, missing));
    await expect(syncBrandIcons(root, true)).rejects.toThrow(changed);
    await expect(syncBrandIcons(root, true)).rejects.toThrow(missing);
    expect(await NodeFSP.readFile(NodePath.join(root, changed), "utf8")).toBe("incorrect icon");
    await expect(NodeFSP.readFile(NodePath.join(root, missing))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
