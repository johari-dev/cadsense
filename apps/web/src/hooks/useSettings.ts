/**
 * Environment-scoped settings hooks.
 *
 * Abstracts the split between server-authoritative settings (persisted in
 * `settings.json` on the server, fetched via `server.getConfig`) and
 * client-only settings (persisted in localStorage).
 *
 * Live server settings always require an environment id. Primary-environment
 * access is intentionally named as such so environment-sensitive consumers
 * cannot silently read the wrong server's settings.
 */
import { useCallback, useContext, useMemo, useSyncExternalStore } from "react";
import { RegistryContext, useAtomValue } from "@effect/atom-react";
import {
  DEFAULT_SERVER_SETTINGS,
  type EnvironmentId,
  ServerSettings,
  type ServerSettingsPatch,
} from "@cadsense/contracts";
import {
  type ClientSettingsPatch,
  type ClientSettings,
  DEFAULT_CLIENT_SETTINGS,
  type EnvironmentIdentificationMode,
  type UnifiedSettings,
} from "@cadsense/contracts/settings";
import { safeErrorLogAttributes } from "@cadsense/client-runtime/errors";
import { applyServerSettingsPatch } from "@cadsense/shared/serverSettings";
import { Atom } from "effect/unstable/reactivity";
import { ensureLocalApi } from "~/localApi";
import * as Struct from "effect/Struct";
import { primaryServerSettingsAtom, serverEnvironment } from "~/state/server";
import { usePrimaryEnvironment, usePrimaryEnvironmentId } from "~/state/environments";
import { useAtomCommand } from "~/state/use-atom-command";

const CLIENT_SETTINGS_PERSISTENCE_ERROR_SCOPE = "[CLIENT_SETTINGS]";

type UnifiedSettingsPatch = ServerSettingsPatch & ClientSettingsPatch;

const clientSettingsListeners = new Set<() => void>();
const clientSettingsHydrationListeners = new Set<() => void>();
let clientSettingsSnapshot = DEFAULT_CLIENT_SETTINGS;
let clientSettingsHydrated = false;
let clientSettingsHydrationPromise: Promise<void> | null = null;
let clientSettingsHydrationGeneration = 0;

function emitClientSettingsChange() {
  for (const listener of clientSettingsListeners) {
    listener();
  }
}

function emitClientSettingsHydrationChange() {
  for (const listener of clientSettingsHydrationListeners) {
    listener();
  }
}

function getClientSettingsSnapshot(): ClientSettings {
  return clientSettingsSnapshot;
}

function replaceClientSettingsSnapshot(settings: ClientSettings): void {
  clientSettingsSnapshot = settings;
  emitClientSettingsChange();
}

function setClientSettingsHydrated(nextHydrated: boolean): void {
  if (clientSettingsHydrated === nextHydrated) {
    return;
  }
  clientSettingsHydrated = nextHydrated;
  emitClientSettingsHydrationChange();
}

function subscribeClientSettings(listener: () => void): () => void {
  clientSettingsListeners.add(listener);
  void hydrateClientSettings();
  return () => {
    clientSettingsListeners.delete(listener);
  };
}

function getClientSettingsHydratedSnapshot(): boolean {
  return clientSettingsHydrated;
}

function subscribeClientSettingsHydration(listener: () => void): () => void {
  clientSettingsHydrationListeners.add(listener);
  void hydrateClientSettings();
  return () => {
    clientSettingsHydrationListeners.delete(listener);
  };
}

async function hydrateClientSettings(): Promise<void> {
  if (clientSettingsHydrated) {
    return;
  }
  if (clientSettingsHydrationPromise) {
    return clientSettingsHydrationPromise;
  }

  const hydrationGeneration = clientSettingsHydrationGeneration;
  const nextHydration = (async () => {
    try {
      const persistedSettings = await ensureLocalApi().persistence.getClientSettings();
      if (hydrationGeneration !== clientSettingsHydrationGeneration) {
        return;
      }
      if (persistedSettings) {
        replaceClientSettingsSnapshot({ ...DEFAULT_CLIENT_SETTINGS, ...persistedSettings });
      }
    } catch (error) {
      console.error(`${CLIENT_SETTINGS_PERSISTENCE_ERROR_SCOPE} hydrate failed`, {
        operation: "hydrate",
        ...safeErrorLogAttributes(error),
      });
    } finally {
      if (hydrationGeneration === clientSettingsHydrationGeneration) {
        setClientSettingsHydrated(true);
      }
    }
  })();

  const hydrationPromise = nextHydration.finally(() => {
    if (clientSettingsHydrationPromise === hydrationPromise) {
      clientSettingsHydrationPromise = null;
    }
  });
  clientSettingsHydrationPromise = hydrationPromise;

  return clientSettingsHydrationPromise;
}

function persistClientSettings(settings: ClientSettings): void {
  replaceClientSettingsSnapshot(settings);
  void ensureLocalApi()
    .persistence.setClientSettings(settings)
    .catch((error) => {
      console.error(`${CLIENT_SETTINGS_PERSISTENCE_ERROR_SCOPE} persist failed`, {
        operation: "persist",
        ...safeErrorLogAttributes(error),
      });
    });
}

// ── Key sets for routing patches ─────────────────────────────────────

const SERVER_SETTINGS_KEYS = new Set<string>(Struct.keys(ServerSettings.fields));

function splitPatch(patch: UnifiedSettingsPatch): {
  serverPatch: ServerSettingsPatch;
  clientPatch: ClientSettingsPatch;
} {
  const serverPatch: Record<string, unknown> = {};
  const clientPatch: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (SERVER_SETTINGS_KEYS.has(key)) {
      serverPatch[key] = value;
    } else {
      clientPatch[key] = value;
    }
  }
  return {
    serverPatch: serverPatch as ServerSettingsPatch,
    clientPatch: clientPatch as ClientSettingsPatch,
  };
}

// ── Hooks ────────────────────────────────────────────────────────────

/**
 * Non-hook accessor for the current merged client settings snapshot.
 * Used by non-React code paths (e.g. runtime services) that need the latest
 * settings without subscribing.
 */
export function getClientSettings(): ClientSettings {
  return getClientSettingsSnapshot();
}

/**
 * Resolves once client settings have been read from disk.
 *
 * The pre-hydration snapshot is just the schema defaults, so imperative paths
 * that open a preview must await this or they bake the built-in viewport, zoom
 * and appearance into a tab that never picks up the user's saved values.
 */
export function ensureClientSettingsHydrated(): Promise<void> {
  return hydrateClientSettings();
}

export function useClientSettingsHydrated(): boolean {
  return useSyncExternalStore(
    subscribeClientSettingsHydration,
    getClientSettingsHydratedSnapshot,
    () => false,
  );
}

function useClientSettingsValue(): ClientSettings {
  return useSyncExternalStore(
    subscribeClientSettings,
    getClientSettingsSnapshot,
    () => DEFAULT_CLIENT_SETTINGS,
  );
}

export function mergeEnvironmentSettings(
  serverSettings: ServerSettings,
  clientSettings: ClientSettings,
): UnifiedSettings {
  return { ...serverSettings, ...clientSettings };
}

function useMergedSettings<T>(
  serverSettings: ServerSettings,
  selector: ((settings: UnifiedSettings) => T) | undefined,
): T {
  const clientSettings = useClientSettingsValue();

  const merged = useMemo<UnifiedSettings>(
    () => mergeEnvironmentSettings(serverSettings, clientSettings),
    [clientSettings, serverSettings],
  );

  return useMemo(() => (selector ? selector(merged) : (merged as T)), [merged, selector]);
}

export function useClientSettings<T = ClientSettings>(
  selector?: (settings: ClientSettings) => T,
): T {
  const settings = useClientSettingsValue();
  return useMemo(() => (selector ? selector(settings) : (settings as T)), [selector, settings]);
}

export function resolveEnvironmentIdentificationMode(input: {
  mode: EnvironmentIdentificationMode;
  settingsHydrated: boolean;
  paletteThemeActive?: boolean;
  paletteThemeAllowsArtwork?: boolean;
}): EnvironmentIdentificationMode {
  // Avoid briefly rendering the default artwork before a persisted pill/none choice loads.
  if (!input.settingsHydrated) return "none";
  // Artwork palettes are maintained for built-ins only. Keep an explicit
  // "none", but use the theme-aware pill for user-controlled palettes.
  return input.paletteThemeActive && !input.paletteThemeAllowsArtwork && input.mode === "artwork"
    ? "pill"
    : input.mode;
}

export function useEnvironmentIdentificationMode(): EnvironmentIdentificationMode {
  return "none";
}
/**
 * One environment's server settings saves that the settings stream has not
 * caught up with. Readers see them applied, so a change made before an earlier
 * save is answered builds on that earlier change. A patch can carry a whole
 * map (`providerInstances`), and one built from settings the earlier save had
 * not reached would silently undo it.
 */
interface UnconfirmedServerSettings {
  /** Patches sent and not yet answered, oldest first. Saves run one at a time. */
  readonly patches: ReadonlyArray<ServerSettingsPatch>;
  /**
   * The server's answer to the latest save. It stands in for the streamed
   * settings until the stream moves on from `streamedAtAnswer`. The answer
   * usually arrives just before the stream's update for the same save, and
   * without this the change would flip back for that moment. An answer is
   * never older than what the stream already shows: the server makes one
   * settings change at a time (`writeSemaphore` in `serverSettings.ts`) and
   * has a save's answer ready before it starts the next change.
   */
  readonly answer: {
    readonly settings: ServerSettings;
    readonly streamedAtAnswer: ServerSettings | null;
  } | null;
}

const NO_UNCONFIRMED_SERVER_SETTINGS: UnconfirmedServerSettings = { patches: [], answer: null };
const unconfirmedServerSettingsAtom = Atom.family((environmentId: EnvironmentId | null) =>
  Atom.make(NO_UNCONFIRMED_SERVER_SETTINGS).pipe(
    Atom.keepAlive,
    Atom.withLabel(`web-unconfirmed-server-settings:${environmentId}`),
  ),
);

/** The streamed server settings with this environment's unconfirmed saves applied. */
function useServerSettings(
  environmentId: EnvironmentId | null,
  streamed: ServerSettings | null,
): ServerSettings {
  const unconfirmed = useAtomValue(unconfirmedServerSettingsAtom(environmentId));
  return useMemo(() => {
    const base =
      unconfirmed.answer !== null && unconfirmed.answer.streamedAtAnswer === streamed
        ? unconfirmed.answer.settings
        : (streamed ?? DEFAULT_SERVER_SETTINGS);
    return unconfirmed.patches.reduce(applyServerSettingsPatch, base);
  }, [streamed, unconfirmed]);
}

/** Read current settings for one environment, merged with client-local preferences. */
export function useEnvironmentSettings<T = UnifiedSettings>(
  environmentId: EnvironmentId,
  selector?: (settings: UnifiedSettings) => T,
): T {
  const streamed = useAtomValue(serverEnvironment.settingsValueAtom(environmentId));
  return useMergedSettings(useServerSettings(environmentId, streamed), selector);
}

/** Primary-only settings access for the settings UI and other explicitly global surfaces. */
export function usePrimarySettings<T = UnifiedSettings>(
  selector?: (settings: UnifiedSettings) => T,
): T {
  const streamed = useAtomValue(primaryServerSettingsAtom);
  return useMergedSettings(useServerSettings(usePrimaryEnvironmentId(), streamed), selector);
}

/**
 * Returns an updater that routes each key to the correct backing store.
 *
 * Server keys show up in the settings hooks right away (see
 * `UnconfirmedServerSettings`) and are persisted via RPC. A save the server
 * rejects is dropped again. Client keys go through client persistence.
 */
function useUpdateSettingsTarget(environmentId: EnvironmentId | null) {
  const persistServerSettings = useAtomCommand(
    serverEnvironment.updateSettings,
    "server settings update",
  );
  const registry = useContext(RegistryContext);
  const updateSettings = useCallback(
    (patch: UnifiedSettingsPatch) => {
      const { serverPatch, clientPatch } = splitPatch(patch);

      if (Object.keys(serverPatch).length > 0) {
        if (environmentId) {
          const unconfirmedAtom = unconfirmedServerSettingsAtom(environmentId);
          registry.update(unconfirmedAtom, (unconfirmed) => ({
            ...unconfirmed,
            patches: [...unconfirmed.patches, serverPatch],
          }));
          void persistServerSettings({
            environmentId,
            input: { patch: serverPatch },
          }).then((result) =>
            registry.update(unconfirmedAtom, (unconfirmed) => ({
              patches: unconfirmed.patches.filter((sent) => sent !== serverPatch),
              answer:
                result._tag === "Success"
                  ? {
                      settings: result.value,
                      streamedAtAnswer: registry.get(
                        serverEnvironment.settingsValueAtom(environmentId),
                      ),
                    }
                  : unconfirmed.answer,
            })),
          );
        }
      }
      if (Object.keys(clientPatch).length > 0) {
        persistClientSettings({
          ...getClientSettingsSnapshot(),
          ...clientPatch,
        });
      }
    },
    [environmentId, persistServerSettings, registry],
  );

  return updateSettings;
}

export function useUpdateEnvironmentSettings(environmentId: EnvironmentId) {
  return useUpdateSettingsTarget(environmentId);
}

export function useUpdatePrimarySettings() {
  return useUpdateSettingsTarget(usePrimaryEnvironment()?.environmentId ?? null);
}

export function useUpdateClientSettings() {
  return useCallback((patch: ClientSettingsPatch) => {
    persistClientSettings({
      ...getClientSettingsSnapshot(),
      ...patch,
    });
  }, []);
}

export function __resetClientSettingsPersistenceForTests(): void {
  clientSettingsHydrationGeneration += 1;
  clientSettingsSnapshot = DEFAULT_CLIENT_SETTINGS;
  clientSettingsHydrated = false;
  clientSettingsHydrationPromise = null;
  clientSettingsListeners.clear();
  clientSettingsHydrationListeners.clear();
}

export function __setClientSettingsForTests(settings: ClientSettings): void {
  clientSettingsHydrationGeneration += 1;
  clientSettingsSnapshot = settings;
  clientSettingsHydrated = true;
  clientSettingsHydrationPromise = null;
}
