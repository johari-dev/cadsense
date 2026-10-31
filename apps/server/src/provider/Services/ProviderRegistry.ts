/**
 * ProviderRegistry - Provider snapshot service.
 *
 * Owns provider install/auth/version/model snapshots and exposes the latest
 * provider state to transport layers.
 *
 * @module ProviderRegistry
 */
import type {
  ProviderInstanceId,
  ProviderDriverKind,
  ServerProvider,
  ServerProviderSetupState,
} from "@cadsense/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";
import type { ProviderSetupCommands } from "../providerSetup.ts";

export interface ProviderRegistryShape {
  /**
   * Read the latest provider snapshots for every configured instance.
   * Multiple snapshots may share the same `provider` kind (multiple
   * instances of the same driver) and disambiguate via `instanceId`.
   */
  readonly getProviders: Effect.Effect<ReadonlyArray<ServerProvider>>;

  /**
   * Refresh all providers, or the default instance of the specified
   * kind when supplied.
   *
   * Retained for back-compat with legacy call sites (WS refresh RPC,
   * orchestration metrics). New code should prefer `refreshInstance`.
   *
   * @deprecated prefer `refreshInstance` for new call sites.
   */
  readonly refresh: (provider?: ProviderDriverKind) => Effect.Effect<ReadonlyArray<ServerProvider>>;

  /**
   * Refresh the specific configured instance. Returns the updated snapshot
   * list. When the instance id is unknown the call resolves with the
   * currently cached list (no error) — matching the legacy `refresh` shim
   * behaviour so transport layers don't have to special-case unknowns.
   */
  readonly refreshInstance: (
    instanceId: ProviderInstanceId,
  ) => Effect.Effect<ReadonlyArray<ServerProvider>>;

  /**
   * Install and sign-in commands for one live provider instance, or
   * `undefined` when the instance is not running.
   */
  readonly getProviderSetupCommands: (
    instanceId: ProviderInstanceId,
  ) => Effect.Effect<ProviderSetupCommands | undefined>;

  /**
   * Record the setup command running for an instance, or the last one that
   * failed; `null` clears it. Every snapshot the registry returns or publishes
   * carries it as `setup`. It is never written to the status cache.
   */
  readonly setSetupState: (
    instanceId: ProviderInstanceId,
    state: ServerProviderSetupState | null,
  ) => Effect.Effect<void>;
  /**
   * Stream of provider snapshot updates — one emission per aggregated
   * change. The array contains the full current state.
   */
  readonly streamChanges: Stream.Stream<ReadonlyArray<ServerProvider>>;
}

export class ProviderRegistry extends Context.Service<ProviderRegistry, ProviderRegistryShape>()(
  "@cadsense/server/provider/Services/ProviderRegistry",
) {}
