#!/usr/bin/env node

// @effect-diagnostics-next-line nodeBuiltinImport:off - Asset copying runs directly in Node without an Effect runtime.
import * as NodeFSP from "node:fs/promises";
// @effect-diagnostics-next-line nodeBuiltinImport:off - Asset paths are resolved by this standalone Node utility.
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { DEVELOPMENT_PUBLIC_ICON_OVERRIDES } from "./lib/brand-assets.ts";

// The web app's checked-in favicon and splash icon, copied byte-for-byte from
// assets/cadsense; rendering them again changes their appearance.
export const PUBLIC_ICON_COPIES = DEVELOPMENT_PUBLIC_ICON_OVERRIDES.map(
  (override) => [override.sourceRelativePath, override.targetRelativePath] as const,
);

// Copies (or with checkOnly, verifies) each public icon. Returns the copy count.
export async function syncBrandIcons(repositoryRoot: string, checkOnly: boolean) {
  const stale: string[] = [];
  for (const [source, target] of PUBLIC_ICON_COPIES) {
    const sourcePath = NodePath.resolve(repositoryRoot, source);
    const targetPath = NodePath.resolve(repositoryRoot, target);
    if (checkOnly) {
      const original = await NodeFSP.readFile(sourcePath);
      const current = await NodeFSP.readFile(targetPath).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      if (current === null || !original.equals(current)) stale.push(target);
    } else {
      await NodeFSP.mkdir(NodePath.dirname(targetPath), { recursive: true });
      await NodeFSP.copyFile(sourcePath, targetPath);
    }
  }
  if (stale.length) throw new Error(`Icons differ from assets/cadsense: ${stale.join(", ")}`);
  return PUBLIC_ICON_COPIES.length;
}

if (import.meta.main) {
  const checkOnly = process.argv.includes("--check");
  const repositoryRoot = NodeURL.fileURLToPath(new URL("../", import.meta.url));
  const count = await syncBrandIcons(repositoryRoot, checkOnly);
  process.stdout.write(`${checkOnly ? "Verified" : "Restored"} ${count} public icon copies.\n`);
}
