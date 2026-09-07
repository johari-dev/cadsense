import { useAtomValue } from "@effect/atom-react";
import { EnvironmentRegistry, EnvironmentSupervisor } from "@cadsense/client-runtime/connection";
import { WS_METHODS, type EnvironmentId } from "@cadsense/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { Atom } from "effect/unstable/reactivity";
import { useMemo } from "react";
import { connectionAtomRuntime } from "../connection/runtime";
import { useEnvironments, useEnvironmentHttpBaseUrl } from "../state/environments";
import { createCadRenderHost } from "./CadRenderHost";

function CadRenderHost({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const baseUrl = useEnvironmentHttpBaseUrl(environmentId);
  const hostAtom = useMemo(
    () =>
      connectionAtomRuntime
        .atom(
          Effect.gen(function* () {
            if (!baseUrl) return;
            const environments = yield* EnvironmentRegistry;
            return yield* environments
              .followStream(
                environmentId,
                Stream.unwrap(
                  Effect.gen(function* () {
                    const supervisor = yield* EnvironmentSupervisor;
                    return SubscriptionRef.changes(supervisor.session).pipe(
                      Stream.switchMap(
                        Option.match({
                          onNone: () => Stream.empty,
                          onSome: (session) =>
                            Stream.unwrap(
                              Effect.acquireRelease(
                                Effect.sync(() => createCadRenderHost(baseUrl)),
                                (host) => Effect.sync(() => host.dispose()),
                              ).pipe(
                                Effect.map((host) =>
                                  session.client[WS_METHODS.cadRenderConnect]({}).pipe(
                                    Stream.tap((event) => Effect.sync(() => host.accept(event))),
                                    Stream.catch(() => Stream.empty),
                                  ),
                                ),
                              ),
                            ),
                        }),
                      ),
                    );
                  }),
                ),
              )
              .pipe(Stream.runDrain);
          }),
        )
        .pipe(Atom.setIdleTTL(0)),
    [baseUrl, environmentId],
  );
  useAtomValue(hostAtom);
  return null;
}

export function CadRenderHosts() {
  const { environments } = useEnvironments();
  return (
    <>
      {environments.map(({ environmentId }) => (
        <CadRenderHost key={environmentId} environmentId={environmentId} />
      ))}
    </>
  );
}
