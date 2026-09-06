#!/usr/bin/env node

// @effect-diagnostics-next-line nodeBuiltinImport:off - Asset copying runs directly in Node without an Effect runtime.
import * as NodeFSP from "node:fs/promises";
// @effect-diagnostics-next-line nodeBuiltinImport:off - Asset paths are resolved by this standalone Node utility.
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { BRAND_ASSET_PATHS, DEVELOPMENT_PUBLIC_ICON_OVERRIDES } from "./lib/brand-assets.ts";

// Preserve the original PoC exports byte-for-byte; rendering them again changes their appearance.
export const POC_ICON_COPIES = [
  ["assets/cadsense/logo-1024.png", BRAND_ASSET_PATHS.developmentDesktopIconPng],
  ["assets/cadsense/logo-1024.png", BRAND_ASSET_PATHS.developmentUniversalIconPng],
  ["assets/cadsense/logo-180.png", BRAND_ASSET_PATHS.developmentRendererAppIconPng],
  ["assets/cadsense/favicon.ico", BRAND_ASSET_PATHS.developmentWebFaviconIco],
  ["assets/cadsense/windows.ico", BRAND_ASSET_PATHS.developmentWindowsIconIco],
  ["assets/cadsense/logo-1024.png", BRAND_ASSET_PATHS.nightlyMacIconPng],
  ["assets/cadsense/logo-1024.png", BRAND_ASSET_PATHS.nightlyLinuxIconPng],
  ["assets/cadsense/logo-180.png", BRAND_ASSET_PATHS.nightlyRendererAppIconPng],
  ["assets/cadsense/favicon.ico", BRAND_ASSET_PATHS.nightlyWebFaviconIco],
  ["assets/cadsense/windows.ico", BRAND_ASSET_PATHS.nightlyWindowsIconIco],
  ["assets/cadsense/logo-1024.png", BRAND_ASSET_PATHS.productionMacIconPng],
  ["assets/cadsense/logo-1024.png", BRAND_ASSET_PATHS.productionLinuxIconPng],
  ["assets/cadsense/logo-180.png", BRAND_ASSET_PATHS.productionRendererAppIconPng],
  ["assets/cadsense/favicon.ico", BRAND_ASSET_PATHS.productionWebFaviconIco],
  ["assets/cadsense/windows.ico", BRAND_ASSET_PATHS.productionWindowsIconIco],
] as const;

export async function syncBrandIcons(repositoryRoot: string, checkOnly: boolean) {
  const copies: ReadonlyArray<readonly [string, string]> = [
    ...POC_ICON_COPIES,
    ...DEVELOPMENT_PUBLIC_ICON_OVERRIDES.map((override) => {
      const original = POC_ICON_COPIES.find(([, target]) => target === override.sourceRelativePath);
      if (!original) throw new Error(`Missing original icon: ${override.sourceRelativePath}`);
      return [original[0], override.targetRelativePath] as const;
    }),
  ];
  const stale: string[] = [];
  for (const [source, target] of copies) {
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
  if (stale.length) throw new Error(`Icons differ from the PoC originals: ${stale.join(", ")}`);
  return copies.length;
}

if (import.meta.main) {
  const checkOnly = process.argv.includes("--check");
  const repositoryRoot = NodeURL.fileURLToPath(new URL("../", import.meta.url));
  const count = await syncBrandIcons(repositoryRoot, checkOnly);
  process.stdout.write(
    `${checkOnly ? "Verified" : "Restored"} ${count} original PoC icon assets.\n`,
  );
}
