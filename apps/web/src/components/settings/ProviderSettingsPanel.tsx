import { useAtomValue } from "@effect/atom-react";
import { connectionStatusText } from "@cadsense/client-runtime/connection";
import { safeErrorLogAttributes } from "@cadsense/client-runtime/errors";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@cadsense/client-runtime/state/runtime";
import {
  defaultInstanceIdForDriver,
  type EnvironmentId,
  type ProviderInstanceConfig,
  type ProviderInstanceId,
  resolveProviderInstanceEnabled,
  type ServerProvider,
  type ServerProviderSetupAction,
  type ServerSettings,
} from "@cadsense/contracts";
import { DEFAULT_UNIFIED_SETTINGS } from "@cadsense/contracts/settings";
import {
  LaptopIcon,
  SpinnerIcon as LoaderIcon,
  MonitorIcon,
  ArrowsClockwiseIcon as RefreshCwIcon,
} from "~/lib/icons";
import { useCallback, useMemo, useRef, useState, type ReactNode } from "react";

import { useEnvironmentSettings, useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import { cn } from "../../lib/utils";
import { resolveAppModelSelectionState } from "../../modelSelection";
import {
  useEnvironments,
  usePrimaryEnvironmentId,
  type EnvironmentPresentation,
} from "../../state/environments";
import { EMPTY_SERVER_PROVIDERS, serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  ConnectionStatusDot,
  connectionPhaseDotClassName,
  connectionPhasePingClassName,
} from "../ConnectionStatusDot";
import { Button } from "../ui/button";
import { ScrollArea } from "../ui/scroll-area";
import { Switch } from "../ui/switch";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { DRIVER_OPTIONS, type DriverOption } from "./providerDriverMeta";
import { providerSettingsTabClassName } from "./providerSettingsTabs";
import { getProviderSummary, getProviderVersionLabel } from "./providerStatus";
import { RedactedSensitiveText } from "./RedactedSensitiveText";
import { searchableSetting } from "./settingsSearch";
import { buildProviderInstanceUpdatePatch } from "./SettingsPanels.logic";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";

function providerEnvironmentIcon(environment: EnvironmentPresentation) {
  if (environment.entry.target._tag === "PrimaryConnectionTarget") return MonitorIcon;
  return LaptopIcon;
}

function providerEnvironmentDetail(environment: EnvironmentPresentation): string {
  if (environment.entry.target._tag === "PrimaryConnectionTarget") return "Primary device";
  return "Local environment";
}

function EnvironmentUnavailableRow({
  environment,
  deviceTabs,
}: {
  readonly environment: EnvironmentPresentation;
  readonly deviceTabs?: ReactNode;
}) {
  return (
    <SettingsSection title="Providers">
      {deviceTabs}
      <SettingsRow
        title="Provider settings are unavailable"
        description={connectionStatusText(environment.connection)}
      />
    </SettingsSection>
  );
}

export function ProviderSettingsPanel() {
  const { environments, isReady } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const options = useMemo(
    () =>
      [...environments].sort((left, right) => {
        if (left.environmentId === primaryEnvironmentId) return -1;
        if (right.environmentId === primaryEnvironmentId) return 1;
        return left.label.localeCompare(right.label);
      }),
    [environments, primaryEnvironmentId],
  );
  // Raw user intent; the effective selection is re-derived every render so a
  // device that drops out of the catalog falls back without erasing the pick —
  // if it reappears (e.g. after a reconnect) the selection is restored.
  const [selectedEnvironmentId, setSelectedEnvironmentId] = useState<EnvironmentId | null>(
    primaryEnvironmentId,
  );
  const effectiveEnvironmentId =
    options.find((environment) => environment.environmentId === selectedEnvironmentId)
      ?.environmentId ??
    options.find((environment) => environment.environmentId === primaryEnvironmentId)
      ?.environmentId ??
    options[0]?.environmentId ??
    null;
  const selectedEnvironment =
    options.find((environment) => environment.environmentId === effectiveEnvironmentId) ?? null;
  const onlyPrimaryDevice =
    options.length === 1 && options[0]?.entry.target._tag === "PrimaryConnectionTarget";
  const deviceTabs =
    !onlyPrimaryDevice && options.length > 0 ? (
      <ScrollArea hideScrollbars scrollFade className="mx-3 h-11 min-w-0 rounded-none sm:mx-4">
        <div
          role="group"
          aria-label="Devices"
          className="flex h-full w-max min-w-full border-b border-border/70 px-1"
        >
          {options.map((environment) => {
            const Icon = providerEnvironmentIcon(environment);
            const selected = environment.environmentId === effectiveEnvironmentId;
            const detail = providerEnvironmentDetail(environment);
            const statusText = connectionStatusText(environment.connection);
            return (
              <Tooltip key={environment.environmentId}>
                <TooltipTrigger
                  render={
                    <button
                      type="button"
                      aria-pressed={selected}
                      className={cn(providerSettingsTabClassName(selected), "gap-2 text-left")}
                      onClick={() => setSelectedEnvironmentId(environment.environmentId)}
                    >
                      <Icon className="size-3.5 shrink-0" aria-hidden />
                      <span className="max-w-40 truncate">{environment.label}</span>
                      {environment.connection.phase !== "connected" ? (
                        <ConnectionStatusDot
                          dotClassName={connectionPhaseDotClassName(environment.connection.phase)}
                          pingClassName={connectionPhasePingClassName(environment.connection.phase)}
                        />
                      ) : null}
                      <span className="sr-only">
                        {detail}, {statusText}
                      </span>
                    </button>
                  }
                />
                <TooltipPopup side="top">
                  {detail} · {statusText}
                </TooltipPopup>
              </Tooltip>
            );
          })}
        </div>
      </ScrollArea>
    ) : null;

  return (
    <SettingsPageContainer className="gap-8">
      {options.length === 0 ? (
        <SettingsSection title="Providers">
          <SettingsRow
            title={isReady ? "No connected devices" : "Loading devices"}
            description={
              isReady
                ? "Connect an execution environment before configuring providers."
                : "Reading connected execution environments."
            }
          />
        </SettingsSection>
      ) : null}

      {selectedEnvironment ? (
        <SelectedEnvironmentProviderSettings
          key={selectedEnvironment.environmentId}
          environment={selectedEnvironment}
          deviceTabs={deviceTabs}
        />
      ) : null}
    </SettingsPageContainer>
  );
}

function SelectedEnvironmentProviderSettings({
  environment,
  deviceTabs,
}: {
  readonly environment: EnvironmentPresentation;
  readonly deviceTabs?: ReactNode;
}) {
  if (environment.connection.phase !== "connected" || environment.serverConfig === null) {
    return <EnvironmentUnavailableRow environment={environment} deviceTabs={deviceTabs} />;
  }
  return (
    <EnvironmentProviderSettings environmentId={environment.environmentId} deviceTabs={deviceTabs} />
  );
}


/**
 * Settings for the two built-in provider slots on one environment. Each row
 * shows the CLI's status, a one-click Install or Sign in when the CLI needs
 * it, and the enable switch.
 */
function EnvironmentProviderSettings({
  environmentId,
  deviceTabs,
}: {
  readonly environmentId: EnvironmentId;
  readonly deviceTabs?: ReactNode;
}) {
  const settings = useEnvironmentSettings(environmentId);
  const updateSettings = useUpdateEnvironmentSettings(environmentId);
  const serverProviders =
    useAtomValue(serverEnvironment.providersValueAtom(environmentId)) ?? EMPTY_SERVER_PROVIDERS;
  const refreshServerProviders = useAtomCommand(serverEnvironment.refreshProviders, {
    reportFailure: false,
  });
  const runProviderSetup = useAtomCommand(serverEnvironment.runProviderSetup, {
    reportFailure: false,
  });
  const [isRefreshingProviders, setIsRefreshingProviders] = useState(false);
  const [pendingSetups, setPendingSetups] = useState<
    ReadonlyMap<ProviderInstanceId, ServerProviderSetupAction>
  >(() => new Map());
  const refreshingRef = useRef(false);
  // Latest attempt per instance. Restarting a sign-in replaces the server's
  // login process, and only the newest attempt may settle the row.
  const setupAttemptsRef = useRef(new Map<ProviderInstanceId, number>());
  const textGenInstanceId = resolveAppModelSelectionState(settings, serverProviders).instanceId;

  const refreshProviders = useCallback(() => {
    if (refreshingRef.current) return;
    refreshingRef.current = true;
    setIsRefreshingProviders(true);
    void (async () => {
      const result = await refreshServerProviders({
        environmentId,
        input: {},
      });
      refreshingRef.current = false;
      setIsRefreshingProviders(false);
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        console.warn("Failed to refresh providers", {
          operation: "refresh-providers",
          environmentId,
          ...safeErrorLogAttributes(squashAtomCommandFailure(result)),
        });
      }
    })();
  }, [environmentId, refreshServerProviders]);

  const runSetup = async (
    instanceId: ProviderInstanceId,
    action: ServerProviderSetupAction,
    label: string,
  ) => {
    const attempt = (setupAttemptsRef.current.get(instanceId) ?? 0) + 1;
    setupAttemptsRef.current.set(instanceId, attempt);
    setPendingSetups((previous) => new Map(previous).set(instanceId, action));

    const result = await runProviderSetup({ environmentId, input: { instanceId, action } });
    if (setupAttemptsRef.current.get(instanceId) !== attempt) return;
    setPendingSetups((previous) => {
      const next = new Map(previous);
      next.delete(instanceId);
      return next;
    });
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: action === "install" ? `Could not install ${label}` : `Could not sign in to ${label}`,
          description: error instanceof Error ? error.message : "The provider command failed.",
        }),
      );
    }
  };

  const rows = DRIVER_OPTIONS.map((option) => {
    const instanceId = defaultInstanceIdForDriver(option.value);
    return {
      option,
      instanceId,
      instance: resolveDefaultInstance(settings, option),
      liveProvider: serverProviders.find((provider) => provider.instanceId === instanceId),
    };
  });

  return (
    <SettingsSection
      {...searchableSetting("providers")}
      headerAction={
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                size="icon-micro"
                variant="ghost-muted"
                disabled={isRefreshingProviders}
                onClick={() => void refreshProviders()}
                aria-label="Refresh provider status"
              >
                {isRefreshingProviders ? (
                  <LoaderIcon className="size-3 animate-spin" />
                ) : (
                  <RefreshCwIcon className="size-3" />
                )}
              </Button>
            }
          />
          <TooltipPopup side="top">Refresh provider status</TooltipPopup>
        </Tooltip>
      }
    >
      {deviceTabs}
      {rows.map(({ option, instanceId, instance, liveProvider }) => (
        <ProviderRow
          key={instanceId}
          option={option}
          enabled={instance === undefined || resolveProviderInstanceEnabled(instance)}
          liveProvider={liveProvider}
          pendingSetup={pendingSetups.get(instanceId)}
          onEnabledChange={
            instance === undefined
              ? undefined
              : (enabled) =>
                  updateSettings(
                    buildProviderInstanceUpdatePatch({
                      settings,
                      instanceId,
                      instance: { ...instance, enabled },
                      driver: option.value,
                      isDefault: true,
                      // A disabled provider cannot keep generating thread titles.
                      ...(!enabled && textGenInstanceId === instanceId
                        ? {
                            textGenerationModelSelection:
                              DEFAULT_UNIFIED_SETTINGS.textGenerationModelSelection,
                          }
                        : {}),
                    }),
                  )
          }
          onSetup={(action) => void runSetup(instanceId, action, option.label)}
        />
      ))}
    </SettingsSection>
  );
}

/**
 * The stored config for a driver's default slot: the explicit instance when
 * one exists, else one built from the legacy per-driver settings. A local
 * backend may run a server whose settings predate the driver, so this can be
 * `undefined`.
 */
function resolveDefaultInstance(
  settings: Pick<ServerSettings, "providers" | "providerInstances">,
  option: DriverOption,
): ProviderInstanceConfig | undefined {
  const explicitInstance = settings.providerInstances[defaultInstanceIdForDriver(option.value)];
  if (explicitInstance !== undefined) return explicitInstance;
  const legacyProviders: Partial<
    Record<string, ServerSettings["providers"][keyof ServerSettings["providers"]]>
  > = settings.providers;
  const legacyConfig = legacyProviders[option.value];
  if (legacyConfig === undefined) return undefined;
  // The envelope is the single enabled flag. Keep the legacy in-config flag
  // out of the blob, or an explicit `enabled: false` would keep winning
  // over the envelope and the switch could never turn the provider on.
  const { enabled, ...config } = legacyConfig;
  return { driver: option.value, enabled, config };
}

function ProviderRow({
  option,
  enabled,
  liveProvider,
  pendingSetup,
  onEnabledChange,
  onSetup,
}: {
  readonly option: DriverOption;
  readonly enabled: boolean;
  readonly liveProvider: ServerProvider | undefined;
  readonly pendingSetup: ServerProviderSetupAction | undefined;
  readonly onEnabledChange: ((enabled: boolean) => void) | undefined;
  readonly onSetup: (action: ServerProviderSetupAction) => void;
}) {
  const Icon = option.icon;
  const setupAction: ServerProviderSetupAction | null =
    !enabled || liveProvider === undefined
      ? null
      : !liveProvider.installed
        ? "install"
        : liveProvider.auth.status === "unauthenticated"
          ? "signIn"
          : null;
  // Keep the button while its command runs, even if a refresh lands first.
  const visibleAction = pendingSetup ?? setupAction;

  return (
    <SettingsRow
      title={
        <span className="flex items-center gap-2">
          <Icon className="size-4 text-foreground/80" aria-hidden />
          {option.label}
        </span>
      }
      description={
        <ProviderStatusLine
          label={option.label}
          enabled={enabled}
          liveProvider={liveProvider}
          pendingSetup={pendingSetup}
        />
      }
      control={
        <>
          {visibleAction === "install" ? (
            <Button
              size="sm"
              variant="outline"
              disabled={pendingSetup === "install"}
              onClick={() => onSetup("install")}
            >
              {pendingSetup === "install" ? "Installing…" : "Install"}
            </Button>
          ) : null}
          {visibleAction === "signIn" ? (
            // A running sign-in stays clickable: the user may have closed the
            // browser tab, and a new attempt replaces the old one.
            <Button size="sm" variant="outline" onClick={() => onSetup("signIn")}>
              {pendingSetup === "signIn" ? "Restart sign-in" : "Sign in"}
            </Button>
          ) : null}
          <Switch
            checked={enabled}
            disabled={onEnabledChange === undefined}
            onCheckedChange={(checked) => onEnabledChange?.(Boolean(checked))}
            aria-label={`Enable ${option.label}`}
          />
        </>
      }
    />
  );
}

function ProviderStatusLine({
  label,
  enabled,
  liveProvider,
  pendingSetup,
}: {
  readonly label: string;
  readonly enabled: boolean;
  readonly liveProvider: ServerProvider | undefined;
  readonly pendingSetup: ServerProviderSetupAction | undefined;
}) {
  if (!enabled) return <>Disabled</>;
  if (pendingSetup === "install") return <>Installing the {label} CLI with npm.</>;
  if (pendingSetup === "signIn") return <>Finish signing in to {label} in your browser.</>;
  if (liveProvider === undefined) return <>Checking status</>;
  if (!liveProvider.installed) return <>The {label} CLI is not installed.</>;

  const version = getProviderVersionLabel(liveProvider.version);
  const auth = liveProvider.auth;
  if (auth.status === "authenticated") {
    const plan = auth.label ?? auth.type;
    const email = auth.email?.trim();
    return (
      <span className="flex min-w-0 flex-wrap items-center gap-x-1.5">
        <span>Signed in</span>
        {email ? (
          <>
            <span>as</span>
            <RedactedSensitiveText
              value={email}
              ariaLabel="Toggle account email visibility"
              revealTooltip="Click to reveal email"
              hideTooltip="Click to hide email"
              className="max-w-full truncate"
            />
          </>
        ) : null}
        {plan ? <span>· {plan}</span> : null}
        {version ? <span>· {version}</span> : null}
      </span>
    );
  }
  if (auth.status === "unauthenticated") return <>Not signed in.</>;

  const summary = getProviderSummary(liveProvider);
  return (
    <span className={cn("[overflow-wrap:anywhere]")}>
      {summary.headline}
      {summary.detail ? ` · ${summary.detail}` : null}
    </span>
  );
}
