import type { ServerProvider } from "@cadsense/contracts";
import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";
import type { ProviderSetupCommands } from "../providerSetup.ts";

export interface ServerProviderShape {
  readonly setupCommands: ProviderSetupCommands;
  readonly getSnapshot: Effect.Effect<ServerProvider>;
  readonly refresh: Effect.Effect<ServerProvider>;
  readonly streamChanges: Stream.Stream<ServerProvider>;
}
