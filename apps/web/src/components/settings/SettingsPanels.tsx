import { settingsLocation } from "./settingsLocation";
import {
  ArchiveIcon,
  ArchiveIcon as ArchiveX,
  CaretRightIcon as ChevronRightIcon,
  ArrowUUpLeftIcon as Undo2Icon,
  SpinnerIcon as LoaderIcon,
} from "~/lib/icons";
import { Link } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAtomValue } from "@effect/atom-react";
import {
  type DesktopUpdateChannel,
  type DesktopUpdateStatus,
  ProviderDriverKind,
  type ScopedThreadRef,
} from "@cadsense/contracts";
import { scopeThreadRef } from "@cadsense/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  settlePromise,
  squashAtomCommandFailure,
} from "@cadsense/client-runtime/state/runtime";
import {
  DEFAULT_UNIFIED_SETTINGS,
  MAX_INTERFACE_FONT_SIZE,
  MIN_INTERFACE_FONT_SIZE,
} from "@cadsense/contracts/settings";
import { createModelSelection } from "@cadsense/shared/model";
import * as Equal from "effect/Equal";
import { APP_VERSION } from "../../branding";
import {
  canCheckForUpdate,
  getDesktopUpdateButtonTooltip,
  getDesktopUpdateInstallConfirmation,
  isDesktopUpdateButtonDisabled,
  resolveDesktopUpdateButtonAction,
} from "../../components/desktopUpdate.logic";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { TraitsPicker } from "../chat/TraitsPicker";
import { isElectron } from "../../env";
import { usePrimarySettings, useUpdatePrimarySettings } from "../../hooks/useSettings";
import { useThreadActions } from "../../hooks/useThreadActions";
import { useDesktopUpdateState } from "../../state/desktopUpdate";
import { readRunningDesktopChatCount } from "../../state/runningChats";
import {
  getCustomModelOptionsByInstance,
  resolveAppModelSelectionState,
} from "../../modelSelection";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  sortProviderInstanceEntries,
} from "../../providerInstances";
import { ensureLocalApi, readLocalApi } from "../../localApi";
import { isMacPlatform } from "../../lib/utils";
import { primaryServerObservabilityAtom, primaryServerProvidersAtom } from "../../state/server";
import { useProjects } from "../../state/entities";
import { useArchivedThreadSnapshots } from "../../lib/archivedThreadsState";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { Button } from "../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { Input } from "../ui/input";
import {
  DEFAULT_CODE_FONT_STACK,
  DEFAULT_SANS_FONT_STACK,
  isFontFamilyAvailable,
  isMonospaceFamily,
  resolveDefaultFamilyLabel,
} from "../../appearanceFonts";
import { discoverInstalledFonts, FontFamilyPicker, useFontEnumeration } from "./FontFamilyPicker";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  formatDiagnosticsDescription,
  getChangedTypographySettingLabels,
} from "./SettingsPanels.logic";
import {
  SettingResetButton,
  SETTINGS_PICKER_TRIGGER_CLASS,
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { ProjectFavicon } from "../ProjectFavicon";
import { CadStorageSection } from "../../cad/CadStorageSettings";

const DEFAULT_DRIVER_KIND = ProviderDriverKind.make("codex");
// The line under Version in the desktop app. Idle covers the short wait before the first
// automatic check after launch.
const UPDATE_STATUS_LABELS: Readonly<Record<DesktopUpdateStatus, string>> = {
  disabled: "Updates are off in this build.",
  idle: "Not checked yet.",
  checking: "Checking for updates…",
  "up-to-date": "Up to date.",
  available: "Update available.",
  downloading: "Downloading update…",
  downloaded: "Update ready to install.",
  error: "Could not check for updates.",
};

function AboutVersionTitle() {
  return (
    <span className="inline-flex items-baseline gap-2">
      <span>Version</span>
      <span className="text-muted-foreground tabular-nums">{APP_VERSION}</span>
    </span>
  );
}

function AboutVersionSection() {
  const updateState = useDesktopUpdateState();
  const [isChangingUpdateChannel, setIsChangingUpdateChannel] = useState(false);
  const [isUpdateActionPending, setIsUpdateActionPending] = useState(false);

  const hasDesktopBridge = typeof window !== "undefined" && Boolean(window.desktopBridge);
  const selectedUpdateChannel = updateState?.channel ?? "latest";

  const handleUpdateChannelChange = useCallback(
    (channel: DesktopUpdateChannel) => {
      const bridge = window.desktopBridge;
      if (
        !bridge ||
        typeof bridge.setUpdateChannel !== "function" ||
        channel === selectedUpdateChannel
      ) {
        return;
      }

      setIsChangingUpdateChannel(true);
      void bridge
        .setUpdateChannel(channel)
        .catch((error: unknown) => {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Could not change update track",
              description: error instanceof Error ? error.message : "Update track change failed.",
            }),
          );
        })
        .finally(() => {
          setIsChangingUpdateChannel(false);
        });
    },
    [selectedUpdateChannel],
  );

  const handleButtonClick = useCallback(async () => {
    const bridge = window.desktopBridge;
    if (!bridge) return;

    const action = updateState ? resolveDesktopUpdateButtonAction(updateState) : "none";

    if (action === "download") {
      void bridge.downloadUpdate().catch((error: unknown) => {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not download update",
            description: error instanceof Error ? error.message : "Download failed.",
          }),
        );
      });
      return;
    }

    if (action === "install") {
      if (isUpdateActionPending) return;
      setIsUpdateActionPending(true);
      let confirmed = false;
      try {
        confirmed = await ensureLocalApi().dialogs.confirm(
          getDesktopUpdateInstallConfirmation(
            updateState ?? { availableVersion: null, downloadedVersion: null },
            readRunningDesktopChatCount(),
          ),
        );
      } catch (error) {
        setIsUpdateActionPending(false);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not confirm update",
            description: error instanceof Error ? error.message : "Update confirmation failed.",
          }),
        );
        return;
      }
      if (!confirmed) {
        setIsUpdateActionPending(false);
        return;
      }
      void bridge
        .installUpdate()
        .catch((error: unknown) => {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Could not install update",
              description: error instanceof Error ? error.message : "Install failed.",
            }),
          );
        })
        .finally(() => setIsUpdateActionPending(false));
      return;
    }

    if (typeof bridge.checkForUpdate !== "function") return;
    void bridge
      .checkForUpdate()
      .then((result) => {
        if (!result.checked) {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Could not check for updates",
              description:
                result.state.message ?? "Automatic updates are not available in this build.",
            }),
          );
        }
      })
      .catch((error: unknown) => {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not check for updates",
            description: error instanceof Error ? error.message : "Update check failed.",
          }),
        );
      });
  }, [isUpdateActionPending, updateState]);

  const action = updateState ? resolveDesktopUpdateButtonAction(updateState) : "none";
  const buttonTooltip = updateState ? getDesktopUpdateButtonTooltip(updateState) : null;
  const buttonDisabled =
    action === "none"
      ? !canCheckForUpdate(updateState)
      : isDesktopUpdateButtonDisabled(updateState);

  const actionLabel: Record<string, string> = { download: "Download", install: "Install" };
  const statusLabel: Record<string, string> = {
    checking: "Checking…",
    downloading: "Downloading…",
  };
  const buttonLabel =
    actionLabel[action] ?? statusLabel[updateState?.status ?? ""] ?? "Check for updates";
  const description = UPDATE_STATUS_LABELS[updateState?.status ?? "idle"];

  return (
    <>
      <SettingsRow
        title={<AboutVersionTitle />}
        description={description}
        control={
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant={action === "install" ? "default" : "outline"}
                  disabled={buttonDisabled || isUpdateActionPending}
                  onClick={handleButtonClick}
                >
                  {buttonLabel}
                </Button>
              }
            />
            {buttonTooltip ? <TooltipPopup>{buttonTooltip}</TooltipPopup> : null}
          </Tooltip>
        }
      />
      {hasDesktopBridge ? (
        <SettingsRow
          title="Update track"
          description="Nightly gets new features first. You can switch back anytime."
          control={
            <Select
              value={selectedUpdateChannel}
              onValueChange={(value) => {
                handleUpdateChannelChange(value as DesktopUpdateChannel);
              }}
            >
              <SelectTrigger
                className="w-full sm:w-40"
                aria-label="Update track"
                disabled={isChangingUpdateChannel}
              >
                <SelectValue>
                  {selectedUpdateChannel === "nightly" ? "Nightly" : "Stable"}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                <SelectItem hideIndicator value="latest">
                  Stable
                </SelectItem>
                <SelectItem hideIndicator value="nightly">
                  Nightly
                </SelectItem>
              </SelectPopup>
            </Select>
          }
        />
      ) : null}
    </>
  );
}

/**
 * What Restore defaults would reset, and the action that resets it after a confirm. Settings
 * with no row in the modal are left alone, so restoring cannot flip a hidden preference.
 */
function useSettingsRestore() {
  const settings = usePrimarySettings();
  const updateSettings = useUpdatePrimarySettings();

  const isTextGenerationModelDirty = !Equal.equals(
    settings.textGenerationModelSelection ?? null,
    DEFAULT_UNIFIED_SETTINGS.textGenerationModelSelection ?? null,
  );

  const changedSettingLabels = useMemo(
    () => [
      ...getChangedTypographySettingLabels(settings),
      ...(settings.showPermissionSettings !== DEFAULT_UNIFIED_SETTINGS.showPermissionSettings
        ? ["Permission settings visibility"]
        : []),
      ...(settings.showContextWindowIndicator !==
      DEFAULT_UNIFIED_SETTINGS.showContextWindowIndicator
        ? ["Context window indicator visibility"]
        : []),
      ...(settings.showOnshapeSyncApiCalls !== DEFAULT_UNIFIED_SETTINGS.showOnshapeSyncApiCalls
        ? ["Onshape API calls per sync"]
        : []),
      ...(isTextGenerationModelDirty ? ["Thread title model"] : []),
      ...(settings.enableUsageAnalytics !== DEFAULT_UNIFIED_SETTINGS.enableUsageAnalytics
        ? ["Usage analytics"]
        : []),
    ],
    [
      isTextGenerationModelDirty,
      settings.enableUsageAnalytics,
      settings.showPermissionSettings,
      settings.showContextWindowIndicator,
      settings.showOnshapeSyncApiCalls,
      settings.fontFamilyCode,
      settings.fontFamilySans,
      settings.fontSizeCode,
      settings.fontSizeInterface,
    ],
  );

  const restoreDefaults = useCallback(async () => {
    if (changedSettingLabels.length === 0) return;
    const api = readLocalApi();
    const confirmed = await (api ?? ensureLocalApi()).dialogs.confirm({
      title: "Restore defaults?",
      rows: changedSettingLabels.map((label) => ({
        label,
        status: { label: "Reset", tone: "neutral" },
      })),
      confirmLabel: "Restore defaults",
      variant: "destructive",
    });
    if (!confirmed) return;

    updateSettings({
      showPermissionSettings: DEFAULT_UNIFIED_SETTINGS.showPermissionSettings,
      showContextWindowIndicator: DEFAULT_UNIFIED_SETTINGS.showContextWindowIndicator,
      showOnshapeSyncApiCalls: DEFAULT_UNIFIED_SETTINGS.showOnshapeSyncApiCalls,
      textGenerationModelSelection: DEFAULT_UNIFIED_SETTINGS.textGenerationModelSelection,
      fontFamilySans: DEFAULT_UNIFIED_SETTINGS.fontFamilySans,
      fontFamilyCode: DEFAULT_UNIFIED_SETTINGS.fontFamilyCode,
      fontSizeInterface: DEFAULT_UNIFIED_SETTINGS.fontSizeInterface,
      fontSizeCode: DEFAULT_UNIFIED_SETTINGS.fontSizeCode,
      enableUsageAnalytics: DEFAULT_UNIFIED_SETTINGS.enableUsageAnalytics,
    });
  }, [changedSettingLabels, updateSettings]);

  return {
    changedSettingLabels,
    restoreDefaults,
  };
}
export function AppearanceSettingsPanel() {
  const settings = usePrimarySettings();
  const updateSettings = useUpdatePrimarySettings();
  return (
    <SettingsPageContainer>
      <TypographySection />
      <SettingsSection title="Composer">
        <SettingsRow
          {...searchableSetting("show-permission-settings")}
          description="Show access controls. When hidden, agents edit freely and a reviewer checks riskier actions."
          control={
            <Switch
              checked={settings.showPermissionSettings}
              onCheckedChange={(checked) =>
                updateSettings({ showPermissionSettings: Boolean(checked) })
              }
              aria-label="Show permission settings"
            />
          }
        />
        <SettingsRow
          {...searchableSetting("show-context-window-indicator")}
          description="Show context usage beside the send button."
          control={
            <Switch
              checked={settings.showContextWindowIndicator}
              onCheckedChange={(checked) =>
                updateSettings({ showContextWindowIndicator: Boolean(checked) })
              }
              aria-label="Show context window indicator"
            />
          }
        />
      </SettingsSection>
      <SettingsSection title="CAD">
        <SettingsRow
          {...searchableSetting("show-onshape-sync-api-calls")}
          description="Show the call count in each sync's progress toast."
          control={
            <Switch
              checked={settings.showOnshapeSyncApiCalls}
              onCheckedChange={(checked) =>
                updateSettings({ showOnshapeSyncApiCalls: Boolean(checked) })
              }
              aria-label="Show Onshape API calls per sync"
            />
          }
        />
      </SettingsSection>
    </SettingsPageContainer>
  );
}
function useFontDefaultFamilies() {
  // An unset preference shows the font it resolves to on this machine; the
  // default stacks are the platform's own faces, so the name is probed, not
  // hardcoded.
  const defaults = useMemo(
    () => ({
      sans: resolveDefaultFamilyLabel(DEFAULT_SANS_FONT_STACK) ?? "System default",
      code: resolveDefaultFamilyLabel(DEFAULT_CODE_FONT_STACK) ?? "System monospace",
    }),
    [],
  );
  return defaults;
}

function InterfaceFontRow() {
  const settings = usePrimarySettings();
  const updateSettings = useUpdatePrimarySettings();
  const defaults = useFontDefaultFamilies();
  return (
    <FontFamilySettingsRow
      {...searchableSetting("interface-font")}
      description="Text across the app."
      defaultFamily={defaults.sans}
      defaultValue={DEFAULT_UNIFIED_SETTINGS.fontFamilySans}
      value={settings.fontFamilySans}
      onValueChange={(fontFamilySans) => updateSettings({ fontFamilySans })}
      onReset={() =>
        updateSettings({
          fontFamilySans: DEFAULT_UNIFIED_SETTINGS.fontFamilySans,
          fontSizeInterface: DEFAULT_UNIFIED_SETTINGS.fontSizeInterface,
        })
      }
      size={{
        label: "Interface font size",
        min: MIN_INTERFACE_FONT_SIZE,
        max: MAX_INTERFACE_FONT_SIZE,
        value: settings.fontSizeInterface,
        defaultValue: DEFAULT_UNIFIED_SETTINGS.fontSizeInterface,
        onChange: (fontSizeInterface) => updateSettings({ fontSizeInterface }),
      }}
    />
  );
}

function FontSmoothingRow() {
  const settings = usePrimarySettings();
  const updateSettings = useUpdatePrimarySettings();
  if (!isMacPlatform(navigator.platform)) return null;
  return (
    <SettingsRow
      {...searchableSetting("font-smoothing")}
      description="Thinner text than the macOS default."
      resetAction={
        settings.fontSmoothing !== DEFAULT_UNIFIED_SETTINGS.fontSmoothing ? (
          <SettingResetButton
            label="font smoothing"
            onClick={() =>
              updateSettings({ fontSmoothing: DEFAULT_UNIFIED_SETTINGS.fontSmoothing })
            }
          />
        ) : null
      }
      control={
        <Switch
          checked={settings.fontSmoothing}
          onCheckedChange={(checked) => updateSettings({ fontSmoothing: Boolean(checked) })}
          aria-label="Font smoothing"
        />
      }
    />
  );
}

/** The one global font for the whole app, plus font smoothing on macOS. */
function TypographySection() {
  return (
    <SettingsSection title="Fonts">
      <InterfaceFontRow />
      <FontSmoothingRow />
    </SettingsSection>
  );
}

function FontFamilySettingsRow({
  id,
  title,
  description,
  defaultFamily,
  defaultValue,
  value,
  onValueChange,
  onReset,
  requireMonospace = false,
  size,
}: {
  id?: string;
  title: string;
  description: string;
  /** What an unset preference renders as, e.g. "Menlo". */
  defaultFamily: string;
  /** The persisted family value supplied by the unified settings defaults. */
  defaultValue: string;
  value: string;
  onValueChange: (value: string) => void;
  onReset: () => void;
  requireMonospace?: boolean;
  size: {
    label: string;
    min: number;
    max: number;
    value: number;
    defaultValue: number;
    onChange: (v: number) => void;
  };
}) {
  const trimmed = value.trim();
  // The fallback input edits a draft; the preference only commits once typing
  // pauses and the text probes as an available font (or is an explicit
  // clear), so the current font holds and nothing reflows mid-word.
  const [draft, setDraft] = useState(value);
  const [draftSettled, setDraftSettled] = useState(true);
  const commitTimerRef = useRef<number | null>(null);
  const lastValueRef = useRef(value);
  if (lastValueRef.current !== value) {
    // The committed value changed externally (hydration, reset, picker
    // selection); adopt it and drop any pending commit of a stale draft.
    lastValueRef.current = value;
    if (commitTimerRef.current !== null) {
      window.clearTimeout(commitTimerRef.current);
      commitTimerRef.current = null;
    }
    setDraft(value);
    setDraftSettled(true);
  }
  useEffect(
    () => () => {
      if (commitTimerRef.current !== null) window.clearTimeout(commitTimerRef.current);
    },
    [],
  );
  const acceptsFamily = (candidate: string) =>
    isFontFamilyAvailable(candidate) && (!requireMonospace || isMonospaceFamily(candidate));
  const commitDraft = (next: string) => {
    setDraftSettled(true);
    // A rejected name stays in the field, flagged: the runtime would silently
    // fall back to its default, so the row must not claim it took the value.
    if (next.trim().length === 0 || acceptsFamily(next)) {
      onValueChange(next);
    }
  };
  const flushDraft = () => {
    if (commitTimerRef.current === null) return;
    window.clearTimeout(commitTimerRef.current);
    commitTimerRef.current = null;
    commitDraft(draft);
  };
  const draftTrimmed = draft.trim();
  // Flag an unknown name only once typing pauses, and never for an empty
  // field - that is the starting state, not a rejected entry.
  const draftPending = draftSettled && draftTrimmed.length > 0 && draftTrimmed !== trimmed;
  const resetToDefault = () => {
    if (commitTimerRef.current !== null) {
      window.clearTimeout(commitTimerRef.current);
      commitTimerRef.current = null;
    }
    setDraft(defaultValue);
    setDraftSettled(true);
    onReset();
  };
  const resetAction =
    value !== defaultValue || size.value !== size.defaultValue ? (
      <SettingResetButton label={title.toLowerCase()} onClick={resetToDefault} />
    ) : null;
  const fontEnumeration = useFontEnumeration();
  // Everyone starts on the plain input; focusing it is the user gesture that
  // runs font discovery. Where the engine can enumerate, the control then
  // upgrades to the picker - popped open when the swap happens under focus,
  // so the interaction continues without a second click.
  const inputFocusedRef = useRef(false);
  const familyControl =
    fontEnumeration.status === "granted" ? (
      <FontFamilyPicker
        ariaLabel={`${title} family`}
        defaultFamily={defaultFamily}
        selectedFamily={trimmed}
        requireMonospace={requireMonospace}
        initialOpen={inputFocusedRef.current}
        onSelect={onValueChange}
      />
    ) : (
      <Input
        aria-label={`${title} family`}
        aria-invalid={draftPending || undefined}
        autoCapitalize="off"
        autoComplete="off"
        className="min-w-0 flex-1"
        maxLength={200}
        onFocus={() => {
          inputFocusedRef.current = true;
          discoverInstalledFonts();
        }}
        onBlur={() => {
          inputFocusedRef.current = false;
          flushDraft();
        }}
        onChange={(event) => {
          const next = event.currentTarget.value;
          setDraft(next);
          setDraftSettled(false);
          if (commitTimerRef.current !== null) {
            window.clearTimeout(commitTimerRef.current);
          }
          commitTimerRef.current = window.setTimeout(() => {
            commitTimerRef.current = null;
            commitDraft(next);
          }, 400);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") flushDraft();
          if (event.key === "Escape") {
            // Discard uncommitted typing without closing the settings page,
            // which is what an unhandled Escape does.
            event.preventDefault();
            event.stopPropagation();
            if (commitTimerRef.current !== null) {
              window.clearTimeout(commitTimerRef.current);
              commitTimerRef.current = null;
            }
            setDraft(value);
            setDraftSettled(true);
          }
        }}
        placeholder={defaultFamily}
        spellCheck={false}
        value={draft}
      />
    );
  const control = (
    <div className="flex w-full items-center gap-2 sm:w-auto">
      <div className="min-w-0 flex-1 sm:w-44 sm:flex-none">{familyControl}</div>
      <Select
        value={String(size.value)}
        onValueChange={(next) => {
          if (typeof next !== "string") return;
          const parsed = Number(next);
          if (Number.isInteger(parsed) && parsed >= size.min && parsed <= size.max) {
            size.onChange(parsed);
          }
        }}
      >
        <SelectTrigger className="w-22 shrink-0" aria-label={size.label}>
          <SelectValue>{size.value} px</SelectValue>
        </SelectTrigger>
        <SelectPopup align="end" alignItemWithTrigger={false}>
          {Array.from({ length: size.max - size.min + 1 }, (_, index) => size.min + index).map(
            (px) => (
              <SelectItem hideIndicator key={px} value={String(px)}>
                {px} px
              </SelectItem>
            ),
          )}
        </SelectPopup>
      </Select>
    </div>
  );
  return (
    <SettingsRow
      {...(id !== undefined ? { id } : {})}
      title={title}
      description={description}
      resetAction={resetAction}
      control={control}
    />
  );
}

/**
 * The last row on General. Resets every setting `useSettingsRestore` tracks, after a confirm
 * that names them. It sits at the bottom so the page opens on real settings, not an action.
 */
function RestoreDefaultsRow() {
  const { changedSettingLabels, restoreDefaults } = useSettingsRestore();
  const nothingChanged = changedSettingLabels.length === 0;

  return (
    <SettingsRow
      {...searchableSetting("restore-defaults")}
      description={
        nothingChanged
          ? "Everything is already on its default."
          : `Resets ${changedSettingLabels.length} changed ${changedSettingLabels.length === 1 ? "setting" : "settings"}.`
      }
      control={
        <Button variant="outline" disabled={nothingChanged} onClick={() => void restoreDefaults()}>
          <Undo2Icon className="size-3.5" />
          Restore defaults
        </Button>
      }
    />
  );
}

/** Picks the model that writes thread titles. Lives on the Providers page, below the providers. */
export function ThreadTitleModelSection() {
  const settings = usePrimarySettings();
  const updateSettings = useUpdatePrimarySettings();
  const serverProviders = useAtomValue(primaryServerProvidersAtom);

  const textGenerationModelSelection = resolveAppModelSelectionState(settings, serverProviders);
  const textGenInstanceId = textGenerationModelSelection.instanceId;
  const textGenModel = textGenerationModelSelection.model;
  const textGenModelOptions = textGenerationModelSelection.options;
  const textGenerationModelInstanceEntries = sortProviderInstanceEntries(
    applyProviderInstanceSettings(deriveProviderInstanceEntries(serverProviders), settings),
  );
  const textGenInstanceEntry = textGenerationModelInstanceEntries.find(
    (entry) => entry.instanceId === textGenInstanceId,
  );
  const textGenProvider: ProviderDriverKind =
    textGenInstanceEntry?.driverKind ?? DEFAULT_DRIVER_KIND;
  const textGenerationModelOptionsByInstance = getCustomModelOptionsByInstance(
    settings,
    serverProviders,
    textGenInstanceId,
    textGenModel,
  );
  const isTextGenerationModelDirty = !Equal.equals(
    settings.textGenerationModelSelection ?? null,
    DEFAULT_UNIFIED_SETTINGS.textGenerationModelSelection ?? null,
  );

  return (
    <SettingsSection title="Thread titles">
      <SettingsRow
        {...searchableSetting("text-generation-model")}
        description="Writes and renames thread titles."
        resetAction={
          isTextGenerationModelDirty ? (
            <SettingResetButton
              label="thread title model"
              onClick={() =>
                updateSettings({
                  textGenerationModelSelection:
                    DEFAULT_UNIFIED_SETTINGS.textGenerationModelSelection,
                })
              }
            />
          ) : null
        }
        control={
          <div className="flex flex-wrap items-center justify-end gap-1.5">
            <ProviderModelPicker
              activeInstanceId={textGenInstanceId}
              model={textGenModel}
              lockedProvider={null}
              instanceEntries={textGenerationModelInstanceEntries}
              modelOptionsByInstance={textGenerationModelOptionsByInstance}
              triggerVariant="outline"
              triggerClassName={SETTINGS_PICKER_TRIGGER_CLASS}
              onInstanceModelChange={(instanceId, model) => {
                updateSettings({
                  textGenerationModelSelection: resolveAppModelSelectionState(
                    {
                      ...settings,
                      textGenerationModelSelection: createModelSelection(instanceId, model),
                    },
                    serverProviders,
                  ),
                });
              }}
            />
            <TraitsPicker
              provider={textGenProvider}
              models={
                // Use the exact instance's models (rather than the
                // first-kind-match) so a custom text-gen instance like
                // `codex_personal` gets its own model list, not the
                // default Codex one.
                textGenInstanceEntry?.models ?? []
              }
              model={textGenModel}
              prompt=""
              onPromptChange={() => {}}
              modelOptions={textGenModelOptions}
              allowPromptInjectedEffort={false}
              triggerVariant="outline"
              triggerClassName={SETTINGS_PICKER_TRIGGER_CLASS}
              onModelOptionsChange={(nextOptions) => {
                updateSettings({
                  textGenerationModelSelection: resolveAppModelSelectionState(
                    {
                      ...settings,
                      textGenerationModelSelection: createModelSelection(
                        textGenInstanceId,
                        textGenModel,
                        nextOptions,
                      ),
                    },
                    serverProviders,
                  ),
                });
              }}
            />
          </div>
        }
      />
    </SettingsSection>
  );
}

/**
 * General settings: version and updates, diagnostics, privacy, and Restore defaults last.
 * Streaming text, the default project folder, and the archive, delete, and quit
 * confirmations have no rows here. They keep their stored values, which default to the
 * intended behavior.
 */
export function GeneralSettingsPanel() {
  const settings = usePrimarySettings();
  const updateSettings = useUpdatePrimarySettings();
  const observability = useAtomValue(primaryServerObservabilityAtom);
  const diagnosticsDescription = formatDiagnosticsDescription({
    localTracingEnabled: observability?.localTracingEnabled ?? false,
    otlpTracesEnabled: observability?.otlpTracesEnabled ?? false,
    ...(observability?.otlpTracesUrl === undefined
      ? {}
      : { otlpTracesUrl: observability.otlpTracesUrl }),
    otlpMetricsEnabled: observability?.otlpMetricsEnabled ?? false,
    ...(observability?.otlpMetricsUrl === undefined
      ? {}
      : { otlpMetricsUrl: observability.otlpMetricsUrl }),
  });

  return (
    <SettingsPageContainer>
      <SettingsSection title="About">
        {isElectron ? (
          <AboutVersionSection />
        ) : (
          <SettingsRow
            title={<AboutVersionTitle />}
            description="Updates come with the desktop app."
          />
        )}
        <SettingsRow
          {...searchableSetting("diagnostics")}
          description={diagnosticsDescription}
          control={
            <Button
              render={<Link {...settingsLocation("diagnostics")} replace />}
              variant="outline"
            >
              View diagnostics
            </Button>
          }
        />
      </SettingsSection>

      <SettingsSection title="Privacy">
        <SettingsRow
          {...searchableSetting("usage-analytics")}
          description="Send anonymous usage counts and failure data to help improve Cadsense. Never includes prompts, files, or CAD data."
          resetAction={
            settings.enableUsageAnalytics !== DEFAULT_UNIFIED_SETTINGS.enableUsageAnalytics ? (
              <SettingResetButton
                label="usage analytics"
                onClick={() =>
                  updateSettings({
                    enableUsageAnalytics: DEFAULT_UNIFIED_SETTINGS.enableUsageAnalytics,
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.enableUsageAnalytics}
              onCheckedChange={(checked) =>
                updateSettings({ enableUsageAnalytics: Boolean(checked) })
              }
              aria-label="Share anonymous usage analytics"
            />
          }
        />
      </SettingsSection>

      <SettingsSection title="Reset">
        <RestoreDefaultsRow />
      </SettingsSection>
    </SettingsPageContainer>
  );
}

export function ArchivedThreadsPanel() {
  const projects = useProjects();
  const { unarchiveThread, confirmAndDeleteThread } = useThreadActions();
  const environmentIds = useMemo(
    () => [...new Set(projects.map((project) => project.environmentId))],
    [projects],
  );
  const {
    snapshots: archivedSnapshots,
    error: archiveError,
    isLoading: isLoadingArchive,
    refresh: refreshArchivedThreads,
  } = useArchivedThreadSnapshots(environmentIds);

  const archivedGroups = useMemo(() => {
    const projectsByEnvironmentAndId = new Map(
      archivedSnapshots.flatMap(({ environmentId, snapshot }) =>
        snapshot.projects.map(
          (project) =>
            [
              `${environmentId}:${project.id}`,
              {
                id: project.id,
                environmentId,
                name: project.title,
                cwd: project.workspaceRoot,
                onshapeSource: project.onshapeSource,
              },
            ] as const,
        ),
      ),
    );
    const threads = archivedSnapshots.flatMap(({ environmentId, snapshot }) =>
      snapshot.threads.map((thread) => ({
        ...thread,
        environmentId,
      })),
    );

    const archivedProjects = Array.from(projectsByEnvironmentAndId.values());
    const groups: Array<{
      readonly project: (typeof archivedProjects)[number];
      readonly threads: Array<(typeof threads)[number]>;
    }> = [];
    for (const project of archivedProjects) {
      const projectThreads: Array<(typeof threads)[number]> = [];
      for (const thread of threads) {
        if (thread.projectId === project.id && thread.environmentId === project.environmentId) {
          projectThreads.push(thread);
        }
      }
      if (projectThreads.length > 0) {
        groups.push({
          project,
          threads: projectThreads.toSorted((left, right) => {
            const leftKey = left.archivedAt ?? left.createdAt;
            const rightKey = right.archivedAt ?? right.createdAt;
            return rightKey.localeCompare(leftKey) || right.id.localeCompare(left.id);
          }),
        });
      }
    }
    return groups;
  }, [archivedSnapshots]);

  const handleArchivedThreadContextMenu = useCallback(
    async (threadRef: ScopedThreadRef, position: { x: number; y: number }) => {
      const api = readLocalApi();
      if (!api) return;
      const clicked = await api.contextMenu.show(
        [
          { id: "unarchive", label: "Unarchive" },
          { id: "delete", label: "Delete", destructive: true },
        ],
        position,
      );

      if (clicked === "unarchive") {
        const result = await unarchiveThread(threadRef);
        if (result._tag === "Success") {
          refreshArchivedThreads();
        } else if (!isAtomCommandInterrupted(result)) {
          const error = squashAtomCommandFailure(result);
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Failed to unarchive thread",
              description: error instanceof Error ? error.message : "An error occurred.",
            }),
          );
        }
        return;
      }

      if (clicked === "delete") {
        const result = await confirmAndDeleteThread(threadRef);
        if (result._tag === "Success") {
          refreshArchivedThreads();
        } else if (!isAtomCommandInterrupted(result)) {
          const error = squashAtomCommandFailure(result);
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Failed to delete thread",
              description: error instanceof Error ? error.message : "An error occurred.",
            }),
          );
        }
      }
    },
    [confirmAndDeleteThread, refreshArchivedThreads, unarchiveThread],
  );

  return (
    <SettingsPageContainer>
      {archivedGroups.length === 0 ? (
        <SettingsSection
          id={isLoadingArchive ? undefined : searchableSetting("archive").id}
          title={searchableSetting("archive").title}
        >
          <SettingsRow
            title={
              <span className="inline-flex items-center gap-2">
                {isLoadingArchive ? (
                  <LoaderIcon className="size-3.5 animate-spin text-muted-foreground" />
                ) : (
                  <ArchiveIcon className="size-3.5 text-muted-foreground" />
                )}
                {isLoadingArchive
                  ? "Loading archived threads"
                  : archiveError
                    ? "Could not load archived threads"
                    : "No archived threads"}
              </span>
            }
            description={
              isLoadingArchive
                ? "Checking connected environments."
                : (archiveError ?? "Threads you archive show up here.")
            }
          />
        </SettingsSection>
      ) : (
        archivedGroups.map(({ project, threads: projectThreads }, index) => (
          <SettingsSection
            key={project.id}
            id={index === 0 ? searchableSetting("archive").id : undefined}
            title={project.name}
            icon={
              <ProjectFavicon
                environmentId={project.environmentId}
                cwd={project.cwd}
                onshapeSource={project.onshapeSource}
              />
            }
          >
            {projectThreads.map((thread) => (
              <SettingsRow
                key={thread.id}
                onContextMenu={(event) => {
                  event.preventDefault();
                  void (async () => {
                    const result = await settlePromise(() =>
                      handleArchivedThreadContextMenu(
                        scopeThreadRef(thread.environmentId, thread.id),
                        {
                          x: event.clientX,
                          y: event.clientY,
                        },
                      ),
                    );
                    if (result._tag === "Failure") {
                      const error = squashAtomCommandFailure(result);
                      toastManager.add(
                        stackedThreadToast({
                          type: "error",
                          title: "Archived thread action failed",
                          description:
                            error instanceof Error ? error.message : "An error occurred.",
                        }),
                      );
                    }
                  })();
                }}
                title={thread.title}
                description={
                  <>
                    Archived {formatRelativeTimeLabel(thread.archivedAt ?? thread.createdAt)}
                    {" \u00b7 Created "}
                    {formatRelativeTimeLabel(thread.createdAt)}
                  </>
                }
                control={
                  <Button
                    type="button"
                    variant="outline"
                    className="shrink-0 cursor-pointer gap-1.5"
                    onClick={() => {
                      void (async () => {
                        const result = await unarchiveThread(
                          scopeThreadRef(thread.environmentId, thread.id),
                        );
                        if (result._tag === "Success") {
                          refreshArchivedThreads();
                          return;
                        }
                        if (!isAtomCommandInterrupted(result)) {
                          const error = squashAtomCommandFailure(result);
                          toastManager.add(
                            stackedThreadToast({
                              type: "error",
                              title: "Failed to unarchive thread",
                              description:
                                error instanceof Error ? error.message : "An error occurred.",
                            }),
                          );
                        }
                      })();
                    }}
                  >
                    <ArchiveX className="size-3.5" />
                    <span>Unarchive</span>
                  </Button>
                }
              />
            ))}
          </SettingsSection>
        ))
      )}
      <CadStorageSection />
    </SettingsPageContainer>
  );
}
