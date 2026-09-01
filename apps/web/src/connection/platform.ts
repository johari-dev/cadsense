import {
  BearerConnectionCredential,
  BearerConnectionProfile,
  BearerConnectionRegistration,
  BearerConnectionTarget,
  ConnectionTransientError,
  Connectivity,
  type PlatformConnectionRegistration,
  PrimaryConnectionRegistration,
  PrimaryConnectionTarget,
  Wakeups,
} from "@cadsense/client-runtime/connection";
import { bootstrapLocalBearerSession } from "@cadsense/client-runtime/authorization";
import { fetchEnvironmentDescriptor } from "@cadsense/client-runtime/environment";
import {
  ClientPresentation,
  EnvironmentOwnedDataCleanup,
  PlatformConnectionSource,
  PrimaryEnvironmentAuth,
} from "@cadsense/client-runtime/platform";
import { EnvironmentRpcRequestObserver } from "@cadsense/client-runtime/rpc";
import {
  AuthStandardClientScopes,
  type DesktopEnvironmentBootstrap,
  PRIMARY_LOCAL_ENVIRONMENT_ID,
} from "@cadsense/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { FetchHttpClient } from "effect/unstable/http";

import { APP_VERSION } from "../branding";
import { clearComposerDraftsEnvironment } from "../composerDraftStore";
import { readDesktopPrimaryBearerToken } from "../environments/primary/desktopAuth";
import { primaryEnvironmentHttpLayer } from "../environments/primary/httpLayer";
import {
  readPrimaryEnvironmentTarget,
  type PrimaryEnvironmentTarget,
} from "../environments/primary/target";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { acknowledgeRpcRequest, trackRpcRequestSent } from "../rpc/requestLatencyState";
import {
  desktopLocalConnectionId,
  readDesktopSecondaryBootstrapsResult,
  type DesktopSecondaryBootstrapsRead,
} from "./desktopLocal";
import { connectionStorageLayer } from "./storage";
import { clientPresentationMetadata } from "./clientMetadata";

let nextObservedRpcRequestId = 0;

const connectivityLayer = Connectivity.layer({
  status: Effect.sync(() => (navigator.onLine ? "online" : "offline")),
  changes: Stream.callback((queue) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        const online = () => Queue.offerUnsafe(queue, "online");
        const offline = () => Queue.offerUnsafe(queue, "offline");
        window.addEventListener("online", online);
        window.addEventListener("offline", offline);
        return { online, offline };
      }),
      ({ online, offline }) =>
        Effect.sync(() => {
          window.removeEventListener("online", online);
          window.removeEventListener("offline", offline);
        }),
    ).pipe(Effect.asVoid),
  ),
});

const wakeupsLayer = Wakeups.layer({
  changes: Stream.callback<"application-active">((queue) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        const listener = () => {
          if (document.visibilityState === "visible") {
            Queue.offerUnsafe(queue, "application-active");
          }
        };
        document.addEventListener("visibilitychange", listener);
        return listener;
      }),
      (listener) =>
        Effect.sync(() => {
          document.removeEventListener("visibilitychange", listener);
        }),
    ).pipe(Effect.asVoid),
  ),
});

function clientMetadata() {
  return clientPresentationMetadata({
    appVersion: APP_VERSION,
    desktopBridge: window.desktopBridge,
  });
}

const capabilitiesLayer = Layer.effectContext(
  Effect.sync(() =>
    Context.make(
      ClientPresentation,
      ClientPresentation.of({
        metadata: clientMetadata(),
        scopes: AuthStandardClientScopes,
      }),
    ).pipe(
      Context.add(
        PrimaryEnvironmentAuth,
        PrimaryEnvironmentAuth.of({
          bearerToken: Effect.tryPromise({
            try: readDesktopPrimaryBearerToken,
            catch: (cause) =>
              new ConnectionTransientError({
                reason: "endpoint-unavailable",
                detail: `Could not load the desktop credential: ${String(cause)}`,
              }),
          }).pipe(Effect.map(Option.fromNullishOr)),
        }),
      ),
    ),
  ),
);

function requestError(detail: string, cause: unknown) {
  return new ConnectionTransientError({
    reason: "endpoint-unavailable",
    detail: `${detail}: ${cause instanceof Error ? cause.message : String(cause)}`,
  });
}

const loadPrimaryRegistration = Effect.fn("web.connectionPlatform.loadPrimary")(function* (
  resolved: PrimaryEnvironmentTarget,
) {
  const descriptor = yield* fetchEnvironmentDescriptor({
    httpBaseUrl: resolved.target.httpBaseUrl,
  }).pipe(
    Effect.provide(primaryEnvironmentHttpLayer),
    Effect.mapError((cause) => requestError("Could not discover the local environment", cause)),
  );
  return new PrimaryConnectionRegistration({
    target: new PrimaryConnectionTarget({
      environmentId: descriptor.environmentId,
      label: descriptor.label,
      httpBaseUrl: resolved.target.httpBaseUrl,
      wsBaseUrl: resolved.target.wsBaseUrl,
    }),
  });
});

const loadSecondaryRegistration = Effect.fn("web.connectionPlatform.loadSecondary")(function* (
  entry: DesktopEnvironmentBootstrap,
) {
  if (
    entry.httpBaseUrl === null ||
    entry.wsBaseUrl === null ||
    entry.bootstrapToken === undefined
  ) {
    return yield* requestError(`Local backend ${entry.id} is not ready`, "missing endpoint");
  }
  const descriptor = yield* fetchEnvironmentDescriptor({ httpBaseUrl: entry.httpBaseUrl }).pipe(
    Effect.mapError((cause) => requestError("Could not discover the local backend", cause)),
  );
  const access = yield* bootstrapLocalBearerSession({
    httpBaseUrl: entry.httpBaseUrl,
    credential: entry.bootstrapToken,
    scopes: AuthStandardClientScopes,
    clientMetadata: clientMetadata(),
  }).pipe(Effect.mapError((cause) => requestError("Could not authorize the local backend", cause)));
  const connectionId = desktopLocalConnectionId(entry.id);
  const label = entry.label || descriptor.label;
  return new BearerConnectionRegistration({
    target: new BearerConnectionTarget({
      environmentId: descriptor.environmentId,
      label,
      connectionId,
    }),
    profile: new BearerConnectionProfile({
      connectionId,
      environmentId: descriptor.environmentId,
      label,
      httpBaseUrl: entry.httpBaseUrl,
      wsBaseUrl: entry.wsBaseUrl,
    }),
    credential: new BearerConnectionCredential({ token: access.access_token }),
  });
});

interface CachedRegistration {
  readonly signature: string;
  readonly registration: PlatformConnectionRegistration;
}

function secondarySignature(entry: DesktopEnvironmentBootstrap): string {
  return `${entry.httpBaseUrl ?? ""}|${entry.wsBaseUrl ?? ""}|${entry.bootstrapToken ?? ""}`;
}

const PLATFORM_POLL_INTERVAL = "3 seconds";

const platformConnectionSourceLayer = Layer.effect(
  PlatformConnectionSource,
  Effect.gen(function* () {
    const cacheRef = yield* Ref.make(new Map<string, CachedRegistration>());
    const buildRegistrations = Effect.gen(function* () {
      const previous = yield* Ref.get(cacheRef);
      const next = new Map<string, CachedRegistration>();
      const registrations: PlatformConnectionRegistration[] = [];

      const primaryTarget = yield* Effect.try({
        try: readPrimaryEnvironmentTarget,
        catch: (cause) => requestError("Could not resolve the local environment", cause),
      }).pipe(Effect.option);
      if (Option.isSome(primaryTarget)) {
        const signature = `${primaryTarget.value.target.httpBaseUrl}|${primaryTarget.value.target.wsBaseUrl}`;
        const cached = previous.get(PRIMARY_LOCAL_ENVIRONMENT_ID);
        const registration =
          cached?.signature === signature
            ? Option.some(cached.registration)
            : yield* loadPrimaryRegistration(primaryTarget.value).pipe(Effect.option);
        if (Option.isSome(registration)) {
          const cacheEntry = { signature, registration: registration.value };
          next.set(PRIMARY_LOCAL_ENVIRONMENT_ID, cacheEntry);
          registrations.push(registration.value);
        }
      }

      const secondaryRead: DesktopSecondaryBootstrapsRead = readDesktopSecondaryBootstrapsResult();
      if (secondaryRead._tag === "Success") {
        for (const entry of secondaryRead.bootstraps) {
          const signature = secondarySignature(entry);
          const cached = previous.get(entry.id);
          const registration =
            cached?.signature === signature
              ? Option.some(cached.registration)
              : yield* loadSecondaryRegistration(entry).pipe(Effect.option);
          if (Option.isSome(registration)) {
            const cacheEntry = { signature, registration: registration.value };
            next.set(entry.id, cacheEntry);
            registrations.push(registration.value);
          }
        }
      } else {
        for (const [id, cached] of previous) {
          if (id === PRIMARY_LOCAL_ENVIRONMENT_ID) continue;
          next.set(id, cached);
          registrations.push(cached.registration);
        }
      }

      yield* Ref.set(cacheRef, next);
      return registrations;
    }).pipe(Effect.provide(FetchHttpClient.layer));

    return PlatformConnectionSource.of({
      registrations: Stream.tick(PLATFORM_POLL_INTERVAL).pipe(
        Stream.mapEffect(() => buildRegistrations),
      ),
    });
  }),
);

const environmentOwnedDataCleanupLayer = Layer.succeed(
  EnvironmentOwnedDataCleanup,
  EnvironmentOwnedDataCleanup.of({
    clear: (environmentId) => Effect.sync(() => clearComposerDraftsEnvironment(environmentId)),
  }),
);

const rpcRequestObserverLayer = Layer.succeed(
  EnvironmentRpcRequestObserver,
  EnvironmentRpcRequestObserver.of({
    observe: ({ environmentId, method }) =>
      Effect.sync(() => {
        const requestId = `${environmentId}:${++nextObservedRpcRequestId}`;
        trackRpcRequestSent(requestId, method, `${method} · ${environmentId}`);
        return Effect.sync(() => acknowledgeRpcRequest(requestId));
      }),
  }),
);

export const connectionPlatformLayer = Layer.mergeAll(
  connectionStorageLayer,
  connectivityLayer,
  wakeupsLayer,
  capabilitiesLayer,
  platformConnectionSourceLayer,
  environmentOwnedDataCleanupLayer,
  rpcRequestObserverLayer,
);
