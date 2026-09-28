import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Option from "effect/Option";
import { HttpServer } from "effect/unstable/http";

import * as ServerConfig from "../config.ts";
import { makeServerLayer } from "../server.ts";
import { ServerRuntimeStartup } from "../serverRuntimeStartup.ts";
import { makeCadMcpRenderHost } from "./CadMcpRenderHost.ts";
import { makeCadMcpReviews } from "./CadMcpReviews.ts";
import type { CadMcpCall } from "./CadMcpStdio.ts";
import type { OnshapeApiKey } from "./CadMcpTools.ts";

export class CadMcpStartupError extends Error {}

/**
 * The regular backend plus the MCP review service. Loaded with a dynamic import after the stdio
 * server is already answering, because this module graph takes most of startup. Completes
 * `ready` once commands are accepted, and runs until interrupted.
 */
export const runCadMcpBackend = (options: {
  readonly config: ServerConfig.ServerConfig["Service"];
  readonly apiKey: Option.Option<OnshapeApiKey>;
  readonly clientName: () => string;
  readonly ready: Deferred.Deferred<CadMcpCall, CadMcpStartupError>;
}) => {
  const reviewsLayer = Layer.effectDiscard(
    Effect.gen(function* () {
      const http = yield* HttpServer.HttpServer;
      const startup = yield* ServerRuntimeStartup;
      if (http.address._tag !== "TcpAddress")
        return yield* Effect.die(new CadMcpStartupError("Cadsense needs a TCP loopback address."));
      const renderHost = yield* makeCadMcpRenderHost(`http://127.0.0.1:${http.address.port}`);
      const reviews = yield* makeCadMcpReviews({
        apiKey: options.apiKey,
        renderHost,
        clientName: options.clientName,
      });
      yield* startup.awaitCommandReady.pipe(
        Effect.andThen(Deferred.succeed(options.ready, reviews.call)),
        Effect.catch(() =>
          Deferred.fail(
            options.ready,
            new CadMcpStartupError("The Cadsense backend did not start."),
          ),
        ),
        Effect.forkScoped,
      );
    }),
  );
  return Layer.launch(
    reviewsLayer.pipe(
      Layer.provideMerge(makeServerLayer),
      Layer.provide(ServerConfig.layer(options.config)),
    ),
  );
};
