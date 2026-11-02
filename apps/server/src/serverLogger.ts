import * as Effect from "effect/Effect";
import * as Logger from "effect/Logger";
import * as References from "effect/References";
import * as Layer from "effect/Layer";

import { ServerConfig } from "./config.ts";
import * as ErrorReports from "./telemetry/ErrorReports.ts";

export const ServerLoggerLive = Effect.gen(function* () {
  const config = yield* ServerConfig;
  const minimumLogLevelLayer = Layer.succeed(References.MinimumLogLevel, config.logLevel);
  // ErrorReports holds Error logs for usage analytics, which decides whether to send any.
  const loggerLayer = Logger.layer(
    [Logger.consolePretty(), Logger.tracerLogger, ErrorReports.logger],
    {
      mergeWithExisting: false,
    },
  );

  return Layer.mergeAll(loggerLayer, minimumLogLevelLayer);
}).pipe(Layer.unwrap);
