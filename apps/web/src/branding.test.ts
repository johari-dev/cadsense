import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  formatAppDisplayName,
  resolveServerBackedAppDisplayName,
  resolveServerBackedAppStageLabel,
} from "./branding.logic";

const originalWindow = globalThis.window;

afterEach(() => {
  vi.resetModules();
  vi.unstubAllEnvs();

  if (originalWindow === undefined) {
    Reflect.deleteProperty(globalThis, "window");
    return;
  }

  globalThis.window = originalWindow;
});

describe("branding", () => {
  it("uses an unlabelled web release name", async () => {
    Reflect.deleteProperty(globalThis, "window");
    vi.stubEnv("DEV", false);
    const branding = await import("./branding");
    expect(branding.APP_STAGE_LABEL).toBe("");
    expect(branding.APP_DISPLAY_NAME).toBe("Cadsense");
  });
  it.each([
    ["Nightly", "Nightly", "Cadsense (Nightly)"],
    ["Dev", "Dev", "Cadsense (Dev)"],
    ["", "", "Cadsense"],
    ["Alpha", "", "Cadsense"],
  ])(
    "uses injected desktop branding without obsolete %s labels",
    async (stageLabel, expectedStage, displayName) => {
      Object.defineProperty(globalThis, "window", {
        configurable: true,
        value: {
          desktopBridge: {
            getAppBranding: () => ({
              baseName: "Cadsense",
              stageLabel,
              displayName: stageLabel ? `Cadsense (${stageLabel})` : "Cadsense",
            }),
          },
        },
      });

      const branding = await import("./branding");

      expect(branding.APP_BASE_NAME).toBe("Cadsense");
      expect(branding.APP_STAGE_LABEL).toBe(expectedStage);
      expect(branding.APP_DISPLAY_NAME).toBe(displayName);
    },
  );
});

describe("branding logic", () => {
  it.each(["", "Latest", "Alpha"])("omits release stage %s from the display name", (stageLabel) => {
    expect(formatAppDisplayName({ baseName: "Cadsense", stageLabel })).toBe("Cadsense");
  });
  it.each(["Dev", "Nightly"])("preserves the %s stage", (stageLabel) => {
    expect(formatAppDisplayName({ baseName: "Cadsense", stageLabel })).toBe(
      `Cadsense (${stageLabel})`,
    );
  });
  it("returns Nightly for nightly primary server versions", () => {
    expect(
      resolveServerBackedAppStageLabel({
        primaryServerVersion: "0.0.28-nightly.20260616.12",
        fallbackStageLabel: "Alpha",
      }),
    ).toBe("Nightly");
  });

  it("updates the display name for nightly primary server versions", () => {
    expect(
      resolveServerBackedAppDisplayName({
        baseName: "Cadsense",
        fallbackDisplayName: "Cadsense (Alpha)",
        fallbackStageLabel: "Alpha",
        primaryServerVersion: "0.0.28-nightly.20260616.12",
      }),
    ).toBe("Cadsense (Nightly)");
  });

  it("keeps the fallback display name for stable primary server versions", () => {
    expect(
      resolveServerBackedAppDisplayName({
        baseName: "Cadsense",
        fallbackDisplayName: "Cadsense (Alpha)",
        fallbackStageLabel: "Alpha",
        primaryServerVersion: "0.0.27",
      }),
    ).toBe("Cadsense");
  });

  it("keeps the fallback display name for malformed nightly primary server versions", () => {
    expect(
      resolveServerBackedAppDisplayName({
        baseName: "Cadsense",
        fallbackDisplayName: "Cadsense (Alpha)",
        fallbackStageLabel: "Alpha",
        primaryServerVersion: "0.0.28-nightly.20260616",
      }),
    ).toBe("Cadsense");
  });
});
