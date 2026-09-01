import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import type * as Stream from "effect/Stream";

export type ConnectionWakeup = "application-active";

export function isApplicationActiveWakeup(_reason: ConnectionWakeup): boolean {
  return true;
}

export function shouldResubscribeAfterWakeup(_reason: ConnectionWakeup): boolean {
  return true;
}

export class ConnectionWakeups extends Context.Service<
  ConnectionWakeups,
  {
    readonly changes: Stream.Stream<ConnectionWakeup>;
  }
>()("@cadsense/client-runtime/connection/wakeups/ConnectionWakeups") {}

export const make = (service: ConnectionWakeups["Service"]) => ConnectionWakeups.of(service);

export const layer = (service: ConnectionWakeups["Service"]) =>
  Layer.succeed(ConnectionWakeups, make(service));
