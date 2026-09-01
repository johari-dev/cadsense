import {
  DEFAULT_SERVER_SETTINGS,
  DEFAULT_UNIFIED_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderInstanceConfig,
} from "@cadsense/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildProviderInstanceUpdatePatch,
  formatDiagnosticsDescription,
  getChangedBrowserSettingLabels,
  getChangedTypographySettingLabels,
  isSamePreviewViewport,
} from "./SettingsPanels.logic";

describe("settings helpers", () => {
  it("detects typography changes by row", () => {
    expect(getChangedTypographySettingLabels(DEFAULT_UNIFIED_SETTINGS)).toEqual([]);
    expect(
      getChangedTypographySettingLabels({
        ...DEFAULT_UNIFIED_SETTINGS,
        fontSizeInterface: 18,
        fontFamilyCode: "Fira Code",
      }),
    ).toEqual(["Interface font", "Code font"]);
  });

  it("summarizes diagnostics exporters", () => {
    expect(
      formatDiagnosticsDescription({
        localTracingEnabled: true,
        otlpTracesEnabled: true,
        otlpTracesUrl: "http://localhost:4318/v1/traces",
        otlpMetricsEnabled: true,
        otlpMetricsUrl: "http://localhost:4318/v1/metrics",
      }),
    ).toBe("Local trace file. Exporting OTEL to http://localhost:4318/v1/{traces,metrics}.");
  });

  it("updates a provider instance and resets the legacy default entry", () => {
    const instanceId = ProviderInstanceId.make("codex");
    const instance = {
      driver: ProviderDriverKind.make("codex"),
      enabled: true,
      config: { binaryPath: "/opt/cadsense/codex" },
    } satisfies ProviderInstanceConfig;
    const patch = buildProviderInstanceUpdatePatch({
      settings: DEFAULT_SERVER_SETTINGS,
      instanceId,
      instance,
      driver: ProviderDriverKind.make("codex"),
      isDefault: true,
    });
    expect(patch.providerInstances?.[instanceId]).toEqual(instance);
    expect(patch.providers?.codex).toEqual(DEFAULT_SERVER_SETTINGS.providers.codex);
  });

  it("compares browser viewport values structurally", () => {
    expect(getChangedBrowserSettingLabels(DEFAULT_UNIFIED_SETTINGS)).toEqual([]);
    expect(
      isSamePreviewViewport(
        { _tag: "preset", width: 390, height: 844, presetId: "iphone-12-pro" },
        { _tag: "preset", width: 390, height: 844, presetId: "ipad-mini" },
      ),
    ).toBe(false);
  });
});
