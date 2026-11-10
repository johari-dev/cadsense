// The cadsense logo (see assets/cadsense/README.md). Every channel ships the same
// artwork, so the per-channel keys below all point here; give a channel its own
// file if its icon ever needs to differ.
const CADSENSE_LOGO = {
  png1024: "assets/cadsense/logo-1024.png",
  png180: "assets/cadsense/logo-180.png",
  // macOS 26 Icon Composer bundle. The build adds png1024 to it as Assets/logo.png.
  iconComposer: "assets/cadsense/Cadsense.icon",
  faviconIco: "assets/cadsense/favicon.ico",
  windowsIco: "assets/cadsense/windows.ico",
} as const;

export const BRAND_ASSET_PATHS = {
  productionMacIconPng: CADSENSE_LOGO.png1024,
  productionMacIconComposer: CADSENSE_LOGO.iconComposer,
  productionLinuxIconPng: CADSENSE_LOGO.png1024,
  productionWindowsIconIco: CADSENSE_LOGO.windowsIco,
  productionWebFaviconIco: CADSENSE_LOGO.faviconIco,
  productionRendererAppIconPng: CADSENSE_LOGO.png180,

  nightlyMacIconPng: CADSENSE_LOGO.png1024,
  nightlyMacIconComposer: CADSENSE_LOGO.iconComposer,
  nightlyLinuxIconPng: CADSENSE_LOGO.png1024,
  nightlyWindowsIconIco: CADSENSE_LOGO.windowsIco,
  nightlyWebFaviconIco: CADSENSE_LOGO.faviconIco,
  nightlyRendererAppIconPng: CADSENSE_LOGO.png180,

  developmentDesktopIconPng: CADSENSE_LOGO.png1024,
  developmentUniversalIconPng: CADSENSE_LOGO.png1024,
  developmentWindowsIconIco: CADSENSE_LOGO.windowsIco,
  developmentWebFaviconIco: CADSENSE_LOGO.faviconIco,
  developmentRendererAppIconPng: CADSENSE_LOGO.png180,
} as const;

export type WebAssetBrand = "development" | "nightly" | "production";

export const WEB_ASSET_CHANNELS = ["latest", "nightly"] as const;

export type WebAssetChannel = (typeof WEB_ASSET_CHANNELS)[number];

export function resolveWebAssetBrandForChannel(channel: WebAssetChannel): WebAssetBrand {
  return channel === "nightly" ? "nightly" : "production";
}

export function resolveWebAssetBrandForPackageVersion(version: string): WebAssetBrand {
  return version.includes("-nightly.") ? "nightly" : "production";
}

export interface IconOverride {
  readonly sourceRelativePath: string;
  readonly targetRelativePath: string;
}

const WEB_ICON_TARGET_FILENAMES = {
  faviconIco: "favicon.ico",
  appIconPng: "app-icon.png",
} as const;

const WEB_ICON_SOURCE_PATHS_BY_BRAND = {
  development: {
    faviconIco: BRAND_ASSET_PATHS.developmentWebFaviconIco,
    appIconPng: BRAND_ASSET_PATHS.developmentRendererAppIconPng,
  },
  nightly: {
    faviconIco: BRAND_ASSET_PATHS.nightlyWebFaviconIco,
    appIconPng: BRAND_ASSET_PATHS.nightlyRendererAppIconPng,
  },
  production: {
    faviconIco: BRAND_ASSET_PATHS.productionWebFaviconIco,
    appIconPng: BRAND_ASSET_PATHS.productionRendererAppIconPng,
  },
} as const satisfies Record<WebAssetBrand, Record<keyof typeof WEB_ICON_TARGET_FILENAMES, string>>;

export function resolveWebIconOverrides(
  brand: WebAssetBrand,
  targetDirectory: string,
): ReadonlyArray<IconOverride> {
  const sourcePaths = WEB_ICON_SOURCE_PATHS_BY_BRAND[brand];
  return [
    {
      sourceRelativePath: sourcePaths.faviconIco,
      targetRelativePath: `${targetDirectory}/${WEB_ICON_TARGET_FILENAMES.faviconIco}`,
    },
    {
      sourceRelativePath: sourcePaths.appIconPng,
      targetRelativePath: `${targetDirectory}/${WEB_ICON_TARGET_FILENAMES.appIconPng}`,
    },
  ];
}

export const DEVELOPMENT_ICON_OVERRIDES = resolveWebIconOverrides("development", "dist/client");

export const DEVELOPMENT_PUBLIC_ICON_OVERRIDES = resolveWebIconOverrides(
  "development",
  "apps/web/public",
);
