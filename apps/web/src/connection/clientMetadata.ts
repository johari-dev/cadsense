import type { AuthClientPresentationMetadata, DesktopBridge } from "@cadsense/contracts";

function clientOsFromElectronPlatform(platform: string | undefined): string {
  switch (platform) {
    case "darwin":
      return "macOS";
    case "win32":
      return "Windows";
    case "linux":
      return "Linux";
    default:
      return platform ? "other" : "unknown";
  }
}

export function clientPresentationMetadata(input: {
  readonly appVersion: string;
  readonly desktopBridge: Pick<DesktopBridge, "getClientPlatform"> | undefined;
}): AuthClientPresentationMetadata {
  const desktopBridge = input.desktopBridge;
  return {
    label: desktopBridge ? "cadsense Desktop" : "cadsense Development",
    deviceType: "desktop",
    os: clientOsFromElectronPlatform(desktopBridge?.getClientPlatform?.()),
    surface: desktopBridge ? "desktop" : "web",
    ...(input.appVersion === "0.0.0" ? {} : { appVersion: input.appVersion }),
  };
}
