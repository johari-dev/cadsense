import { EnvironmentHttpApi } from "@cadsense/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { FetchHttpClient, HttpRouter, HttpServer } from "effect/unstable/http";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";

import * as BackgroundPolicy from "./background/BackgroundPolicy.ts";
import * as HostPowerMonitor from "./background/HostPowerMonitor.ts";
import * as ServerConfig from "./config.ts";
import {
  otlpTracesProxyRouteLayer,
  assetRouteLayer,
  attachmentUploadRouteLayer,
  serverEnvironmentHttpApiLayer,
  staticAndDevRouteLayer,
  browserApiCorsLayer,
  httpCompressionLayer,
} from "./http.ts";
import { guardHttpResponseWriteErrors } from "./httpResponseErrorGuard.ts";
import { fixPath } from "./os-jank.ts";
import { websocketRpcRouteLayer } from "./ws.ts";
import * as ExternalLauncher from "./process/externalLauncher.ts";
import { layerConfig as SqlitePersistenceLayerLive } from "./persistence/Layers/Sqlite.ts";
import * as ServerLifecycleEvents from "./serverLifecycleEvents.ts";
import * as AnalyticsService from "./telemetry/AnalyticsService.ts";
import { ProviderSessionDirectoryLive } from "./provider/Layers/ProviderSessionDirectory.ts";
import * as ProviderSessionRuntime from "./persistence/ProviderSessionRuntime.ts";
import { ProviderAdapterRegistryLive } from "./provider/Layers/ProviderAdapterRegistry.ts";
import * as ModelManifest from "./provider/ModelManifest.ts";
import * as ProviderEventLoggers from "./provider/Layers/ProviderEventLoggers.ts";
import { ProviderServiceLive } from "./provider/Layers/ProviderService.ts";
import { ProviderSessionReaperLive } from "./provider/Layers/ProviderSessionReaper.ts";
import * as TextGeneration from "./textGeneration/TextGeneration.ts";
import { ProviderInstanceRegistryHydrationLive } from "./provider/Layers/ProviderInstanceRegistryHydration.ts";
import * as McpHttpServer from "./mcp/McpHttpServer.ts";
import * as McpSessionRegistry from "./mcp/McpSessionRegistry.ts";
import * as PreviewAutomationBroker from "./mcp/PreviewAutomationBroker.ts";
import * as PreviewManager from "./preview/Manager.ts";
import * as PortScanner from "./preview/PortScanner.ts";
import * as ProcessRunner from "./processRunner.ts";
import * as Keybindings from "./keybindings.ts";
import * as ServerRuntimeStartup from "./serverRuntimeStartup.ts";
import { OrchestrationReactorLive } from "./orchestration/Layers/OrchestrationReactor.ts";
import { OnshapeWorkspaceReactorLive } from "./orchestration/Layers/OnshapeWorkspaceReactor.ts";
import { ProviderRuntimeIngestionLive } from "./orchestration/Layers/ProviderRuntimeIngestion.ts";
import { ProviderCommandReactorLive } from "./orchestration/Layers/ProviderCommandReactor.ts";
import { ThreadDeletionReactorLive } from "./orchestration/Layers/ThreadDeletionReactor.ts";
import { ProviderRegistryLive } from "./provider/Layers/ProviderRegistry.ts";
import * as ServerSettings from "./serverSettings.ts";
import * as ProjectFaviconResolver from "./project/ProjectFaviconResolver.ts";
import * as WorkspaceEntries from "./workspace/WorkspaceEntries.ts";
import * as WorkspaceFileSystem from "./workspace/WorkspaceFileSystem.ts";
import * as WorkspacePaths from "./workspace/WorkspacePaths.ts";
import { ObservabilityLive } from "./observability/Layers/Observability.ts";
import * as ServerEnvironment from "./environment/ServerEnvironment.ts";
import { authHttpApiLayer, environmentAuthenticatedAuthLayer } from "./auth/http.ts";
import * as ServerSecretStore from "./auth/ServerSecretStore.ts";
import * as EnvironmentAuth from "./auth/EnvironmentAuth.ts";
import * as ProcessDiagnostics from "./diagnostics/ProcessDiagnostics.ts";
import * as ProcessResourceMonitor from "./diagnostics/ProcessResourceMonitor.ts";
import * as TraceDiagnostics from "./diagnostics/TraceDiagnostics.ts";
import * as DesktopTelemetryReceiver from "./resourceTelemetry/DesktopTelemetryReceiver.ts";
import * as NativeTelemetryClient from "./resourceTelemetry/NativeTelemetryClient.ts";
import * as ResourceAttribution from "./resourceTelemetry/ResourceAttribution.ts";
import * as ResourceMonitorBinary from "./resourceTelemetry/ResourceMonitorBinary.ts";
import * as ResourceTelemetry from "./resourceTelemetry/ResourceTelemetry.ts";
import { OrchestrationLayerLive } from "./orchestration/runtimeLayer.ts";
import { orchestrationHttpApiLayer } from "./orchestration/http.ts";
import * as NetService from "@cadsense/shared/Net";
import { ServerActivation } from "./serverActivation.ts";
import * as OnshapeConnections from "./onshape/OnshapeConnections.ts";
import * as OnshapeProjects from "./onshape/OnshapeProjects.ts";
import * as ManagedWorkspaceAllocator from "./workspace/ManagedWorkspaceAllocator.ts";

// Effect's default preemptive shutdown waits 20s before finalizing request scopes.
// cadsense's primary transport is long-lived WebSocket RPC, whose Effect scope finalizer
// already closes the websocket gracefully. Do not add an artificial drain before
// those finalizers get a chance to run.
const HTTP_PREEMPTIVE_SHUTDOWN_GRACE_MS = 0;
const ResourceAttributionLayerLive = ResourceAttribution.layer;
const ApplicationObservabilityLive = ObservabilityLive.pipe(
  Layer.provideMerge(ResourceAttributionLayerLive),
);

const ServerSettingsLayerLive = ServerSettings.layer.pipe(
  Layer.provide(ServerSecretStore.layer),
  Layer.provideMerge(SqlitePersistenceLayerLive),
);

const NativeTelemetryLayerLive = NativeTelemetryClient.layer.pipe(
  Layer.provide(ResourceMonitorBinary.layer),
);
const DesktopTelemetryReceiverLayerLive = DesktopTelemetryReceiver.layer.pipe(
  Layer.provideMerge(ServerSettingsLayerLive),
);

const ResourceTelemetryLayerLive = ResourceTelemetry.layer.pipe(
  Layer.provideMerge(NativeTelemetryLayerLive),
  Layer.provideMerge(DesktopTelemetryReceiverLayerLive),
);

const HostPowerMonitorLayerLive = HostPowerMonitor.layer.pipe(
  Layer.provide(DesktopTelemetryReceiverLayerLive),
);

const BackgroundLayerLive = BackgroundPolicy.layer.pipe(
  Layer.provide(HostPowerMonitorLayerLive),
  Layer.provideMerge(ServerSettingsLayerLive),
);

const ResourceDiagnosticsLayerLive = Layer.mergeAll(
  ResourceTelemetryLayerLive,
  ProcessDiagnostics.layer.pipe(Layer.provide(ResourceTelemetryLayerLive)),
  ProcessResourceMonitor.layer.pipe(Layer.provide(ResourceTelemetryLayerLive)),
);

const HttpServerLive = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    if (typeof Bun !== "undefined") {
      const BunHttpServer = yield* Effect.promise(
        () => import("@effect/platform-bun/BunHttpServer"),
      );
      return BunHttpServer.layer({
        port: config.port,
        hostname: config.host ?? "127.0.0.1",
        gracefulShutdownTimeout: HTTP_PREEMPTIVE_SHUTDOWN_GRACE_MS,
        websocket: {
          // Negotiate permessage-deflate with clients that offer it; clients
          // that don't still get uncompressed frames on their connection. A
          // dedicated compressor keeps a per-connection sliding window
          // (context takeover) so the compression dictionary is shared across
          // server-to-client frames. Decompression uses the shared
          // decompressor: uWebSockets' dedicated decompressor path can abort
          // connections (close 1006) on valid DEFLATE input — see
          // https://github.com/uNetworking/uWebSockets.js/issues/633.
          perMessageDeflate: {
            compress: "dedicated",
            decompress: "shared",
          },
        },
      });
    } else {
      const [NodeHttpServer, NodeHttp] = yield* Effect.all([
        Effect.promise(() => import("@effect/platform-node/NodeHttpServer")),
        Effect.promise(() => import("node:http")),
      ]);
      return NodeHttpServer.layer(() => guardHttpResponseWriteErrors(NodeHttp.createServer()), {
        host: config.host ?? "127.0.0.1",
        port: config.port,
        gracefulShutdownTimeout: HTTP_PREEMPTIVE_SHUTDOWN_GRACE_MS,
        // Negotiate permessage-deflate with clients that offer it; clients
        // that don't still get uncompressed frames on their connection.
        // Context takeover stays enabled (ws default) so the compression
        // window is shared across frames — that also makes small frames cheap
        // to compress, so no size threshold is set (ws only honors
        // `threshold` when context takeover is disabled).
        websocket: { perMessageDeflate: true },
      });
    }
  }),
);

const PlatformServicesLive = Layer.unwrap(
  Effect.gen(function* () {
    if (typeof Bun !== "undefined") {
      const { layer } = yield* Effect.promise(() => import("@effect/platform-bun/BunServices"));
      return layer;
    } else {
      const { layer } = yield* Effect.promise(() => import("@effect/platform-node/NodeServices"));
      return layer;
    }
  }),
);

const ProviderSessionDirectoryLayerLive = ProviderSessionDirectoryLive.pipe(
  Layer.provide(ProviderSessionRuntime.layer),
);

// `ProviderAdapterRegistryLive` is now a facade that resolves kind → adapter
// by looking up the default `ProviderInstance` per driver in the instance
// registry. Adapter construction itself moved inside each driver's
// `create()`; `ProviderEventLoggers.layer` owns the shared native/canonical
// NDJSON writers and is provided at the outer runtime layer so both
// `ProviderService` and the per-instance drivers read the same logger pair.
const ProviderLayerLive = ProviderServiceLive.pipe(
  Layer.provide(ProviderAdapterRegistryLive),
  Layer.provideMerge(ProviderSessionDirectoryLayerLive),
);

const PersistenceLayerLive = Layer.empty.pipe(Layer.provideMerge(SqlitePersistenceLayerLive));

const PortScannerLayerLive = PortScanner.layer.pipe(Layer.provide(ProcessRunner.layer));

const PreviewLayerLive = Layer.empty.pipe(
  Layer.provideMerge(PreviewManager.layer),
  Layer.provideMerge(PortScannerLayerLive),
);

const WorkspaceEntriesLayerLive = WorkspaceEntries.layer.pipe(Layer.provide(WorkspacePaths.layer));

const WorkspaceFileSystemLayerLive = WorkspaceFileSystem.layer.pipe(
  Layer.provide(WorkspacePaths.layer),
  Layer.provide(WorkspaceEntriesLayerLive),
);

const WorkspaceLayerLive = Layer.mergeAll(
  WorkspacePaths.layer,
  WorkspaceEntriesLayerLive,
  WorkspaceFileSystemLayerLive,
);

const ProjectFaviconResolverLayerLive = ProjectFaviconResolver.layer.pipe(
  Layer.provide(WorkspacePaths.layer),
);

const AuthLayerLive = EnvironmentAuth.layer;

const OnshapeConnectionsLayerLive = OnshapeConnections.layerLive.pipe(
  Layer.provideMerge(ServerSecretStore.layer),
  Layer.provideMerge(SqlitePersistenceLayerLive),
);

const ProviderRuntimeLayerLive = ProviderSessionReaperLive.pipe(
  Layer.provideMerge(ProviderLayerLive),
  Layer.provideMerge(OrchestrationLayerLive),
);

const OnshapeWorkspaceReactorLayerLive = OnshapeWorkspaceReactorLive.pipe(
  Layer.provideMerge(ManagedWorkspaceAllocator.layer),
  Layer.provideMerge(ProviderRuntimeLayerLive),
);

const OnshapeLayerLive = OnshapeProjects.layer.pipe(
  Layer.provideMerge(ManagedWorkspaceAllocator.layer),
  Layer.provideMerge(OnshapeConnectionsLayerLive),
  Layer.provideMerge(OnshapeWorkspaceReactorLayerLive),
);

const AgentRuntimeLayerLive = OnshapeLayerLive.pipe(Layer.provideMerge(ProviderRuntimeLayerLive));

const ReactorLayerLive = Layer.empty.pipe(
  Layer.provideMerge(OrchestrationReactorLive),
  Layer.provideMerge(ProviderRuntimeIngestionLive),
  Layer.provideMerge(ProviderCommandReactorLive),
  Layer.provideMerge(ThreadDeletionReactorLive),
  Layer.provideMerge(OnshapeWorkspaceReactorLayerLive),
);

const ProviderInstanceServicesLive = TextGeneration.layer.pipe(
  Layer.provideMerge(ProviderInstanceRegistryHydrationLive),
);

const RuntimeCoreDependenciesLive = ReactorLayerLive.pipe(
  // Core Services
  Layer.provideMerge(ServerSettingsLayerLive),
  Layer.provideMerge(AgentRuntimeLayerLive),
  Layer.provideMerge(PreviewLayerLive),
  Layer.provideMerge(PersistenceLayerLive),
  Layer.provideMerge(Keybindings.layer),
  Layer.provideMerge(ProviderRegistryLive),
  // The instance registry is the new routing keystone — text generation,
  // adapter lookup, and runtime ingestion all resolve `ProviderInstanceId`
  // through this layer. Built-in drivers come from `BUILT_IN_DRIVERS`;
  // `providerInstances` hydration merges `settings.providers.<kind>`
  // with explicit `providerInstances` entries on boot.
  Layer.provideMerge(ProviderInstanceServicesLive),
  // Shared native/canonical NDJSON writers used by both the per-instance
  // drivers (native stream, written from inside each `<X>Adapter`) and
  // `ProviderService` (canonical stream, written after event normalization).
  // Provided once at the runtime level so every consumer sees the same
  // logger instances.
  // `ModelManifest.layer` supplies bundled legacy-model classification data
  // to the Codex and Claude drivers.
  Layer.provideMerge(Layer.mergeAll(ProviderEventLoggers.layer, ModelManifest.layer)),
  Layer.provideMerge(WorkspaceLayerLive),
  Layer.provideMerge(ProjectFaviconResolverLayerLive),
  Layer.provideMerge(ServerEnvironment.layer),
  Layer.provideMerge(AuthLayerLive),
  Layer.provideMerge(ServerSecretStore.layer),
  Layer.provideMerge(ProcessRunner.layer),
);

const RuntimeDependenciesLive = RuntimeCoreDependenciesLive.pipe(
  // Misc.
  Layer.provideMerge(BackgroundLayerLive),
  Layer.provideMerge(ResourceDiagnosticsLayerLive),
  Layer.provideMerge(TraceDiagnostics.layer),
  Layer.provideMerge(AnalyticsService.layer),
  Layer.provideMerge(ExternalLauncher.layer),
  Layer.provideMerge(ServerLifecycleEvents.layer),
  Layer.provide(NetService.layer),
);

const commandReadinessLayer = HttpRouter.middleware(
  (httpEffect) =>
    Effect.flatMap(ServerRuntimeStartup.ServerRuntimeStartup, (startup) =>
      startup.awaitCommandReady.pipe(Effect.orDie, Effect.andThen(httpEffect)),
    ),
  { global: true },
);

export const makeRoutesLayer = Layer.mergeAll(
  Layer.mergeAll(
    HttpApiBuilder.layer(EnvironmentHttpApi).pipe(
      Layer.provide(authHttpApiLayer),
      Layer.provide(orchestrationHttpApiLayer),
      Layer.provide(serverEnvironmentHttpApiLayer),
      Layer.provide(environmentAuthenticatedAuthLayer),
    ),
    otlpTracesProxyRouteLayer,
    assetRouteLayer,
    attachmentUploadRouteLayer,
    staticAndDevRouteLayer,
    websocketRpcRouteLayer,
  ),
  McpHttpServer.layer.pipe(Layer.provide(McpSessionRegistry.layer)),
).pipe(
  Layer.provide(PreviewAutomationBroker.layer),
  Layer.provide(commandReadinessLayer),
  Layer.provide(browserApiCorsLayer),
  Layer.provide(httpCompressionLayer),
);

export const makeServerLayer = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const activation = yield* Deferred.make<void>();
    const awaitActivation = Deferred.await(activation);
    const activationLayer = Layer.succeed(ServerActivation, awaitActivation);
    const routesReady = yield* Deferred.make<void>();

    yield* fixPath();

    const httpListeningLayer = Layer.effectDiscard(
      Effect.gen(function* () {
        yield* HttpServer.HttpServer;
        const startup = yield* ServerRuntimeStartup.ServerRuntimeStartup;
        yield* startup.markHttpListening;
      }),
    );
    const runtimeServicesLive = ServerRuntimeStartup.layerWithOptions({
      activate: Deferred.succeed(activation, undefined).pipe(Effect.asVoid),
      abort: (error) => Deferred.die(activation, error).pipe(Effect.asVoid),
      awaitAuxiliaryParked: Deferred.await(routesReady),
    }).pipe(Layer.provideMerge(RuntimeDependenciesLive));

    const routesLayer = HttpRouter.serve(makeRoutesLayer, {
      disableLogger: !config.logWebSocketEvents,
    }).pipe(Layer.tap(() => Deferred.succeed(routesReady, undefined).pipe(Effect.orDie)));
    const serverApplicationLayer = Layer.mergeAll(routesLayer, httpListeningLayer);

    return serverApplicationLayer.pipe(
      Layer.provideMerge(runtimeServicesLive),
      Layer.provide(activationLayer),
      Layer.provideMerge(HttpServerLive),
      Layer.provide(ApplicationObservabilityLive),
      Layer.provideMerge(FetchHttpClient.layer),
      Layer.provideMerge(PlatformServicesLive),
    );
  }),
);

// The CLI supplies configuration.
export const runServer = Layer.launch(makeServerLayer);
