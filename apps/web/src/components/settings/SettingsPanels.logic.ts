import type {
  ProviderDriverKind,
  ProviderInstanceConfig,
  ProviderInstanceId,
  ServerSettings,
  UnifiedSettings,
} from "@cadsense/contracts";
import { DEFAULT_UNIFIED_SETTINGS } from "@cadsense/contracts/settings";

type TypographySettings = Pick<
  UnifiedSettings,
  | "fontFamilySans"
  | "fontFamilyComposer"
  | "fontFamilyCode"
  | "fontSizeInterface"
  | "fontSizePrompt"
  | "fontSizeCode"
>;

export function getChangedTypographySettingLabels(settings: TypographySettings): string[] {
  return [
    ...(settings.fontFamilySans !== DEFAULT_UNIFIED_SETTINGS.fontFamilySans ||
    settings.fontSizeInterface !== DEFAULT_UNIFIED_SETTINGS.fontSizeInterface
      ? ["Interface font"]
      : []),
    ...(settings.fontFamilyComposer !== DEFAULT_UNIFIED_SETTINGS.fontFamilyComposer ||
    settings.fontSizePrompt !== DEFAULT_UNIFIED_SETTINGS.fontSizePrompt
      ? ["Prompt font"]
      : []),
    ...(settings.fontFamilyCode !== DEFAULT_UNIFIED_SETTINGS.fontFamilyCode ||
    settings.fontSizeCode !== DEFAULT_UNIFIED_SETTINGS.fontSizeCode
      ? ["Code font"]
      : []),
  ];
}

function collapseOtelSignalsUrl(input: {
  readonly tracesUrl: string;
  readonly metricsUrl: string;
}): string | null {
  const tracesSuffix = "/traces";
  const metricsSuffix = "/metrics";
  if (!input.tracesUrl.endsWith(tracesSuffix) || !input.metricsUrl.endsWith(metricsSuffix)) {
    return null;
  }
  const tracesBase = input.tracesUrl.slice(0, -tracesSuffix.length);
  const metricsBase = input.metricsUrl.slice(0, -metricsSuffix.length);
  return tracesBase === metricsBase ? `${tracesBase}/{traces,metrics}` : null;
}

export function formatDiagnosticsDescription(input: {
  readonly localTracingEnabled: boolean;
  readonly otlpTracesEnabled: boolean;
  readonly otlpTracesUrl?: string;
  readonly otlpMetricsEnabled: boolean;
  readonly otlpMetricsUrl?: string;
}): string {
  const mode = input.localTracingEnabled ? "Local trace file" : "Console logs only";
  const tracesUrl = input.otlpTracesEnabled ? input.otlpTracesUrl : undefined;
  const metricsUrl = input.otlpMetricsEnabled ? input.otlpMetricsUrl : undefined;
  if (tracesUrl && metricsUrl) {
    const collapsedUrl = collapseOtelSignalsUrl({ tracesUrl, metricsUrl });
    return collapsedUrl
      ? `${mode}. Exporting OTEL to ${collapsedUrl}.`
      : `${mode}. Exporting OTEL traces to ${tracesUrl} and metrics to ${metricsUrl}.`;
  }
  if (tracesUrl) return `${mode}. Exporting OTEL traces to ${tracesUrl}.`;
  if (metricsUrl) return `${mode}. Exporting OTEL metrics to ${metricsUrl}.`;
  return `${mode}.`;
}

export function buildProviderInstanceUpdatePatch(input: {
  readonly settings: Pick<ServerSettings, "providers" | "providerInstances">;
  readonly instanceId: ProviderInstanceId;
  readonly instance: ProviderInstanceConfig;
  readonly driver: ProviderDriverKind;
  readonly isDefault: boolean;
  readonly textGenerationModelSelection?: ServerSettings["textGenerationModelSelection"];
}): Partial<UnifiedSettings> {
  type LegacyProviderSettings = ServerSettings["providers"][keyof ServerSettings["providers"]];
  const defaults = DEFAULT_UNIFIED_SETTINGS.providers as Record<
    string,
    LegacyProviderSettings | undefined
  >;
  const defaultProvider = input.isDefault ? defaults[input.driver] : undefined;
  return {
    ...(defaultProvider === undefined
      ? {}
      : { providers: { ...input.settings.providers, [input.driver]: defaultProvider } }),
    providerInstances: {
      ...input.settings.providerInstances,
      [input.instanceId]: input.instance,
    },
    ...(input.textGenerationModelSelection === undefined
      ? {}
      : { textGenerationModelSelection: input.textGenerationModelSelection }),
  };
}
