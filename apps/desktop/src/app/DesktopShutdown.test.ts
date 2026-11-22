import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import * as DesktopShutdown from "./DesktopShutdown.ts";

const withShutdown = <A>(
  body: (shutdown: DesktopShutdown.DesktopShutdown["Service"]) => Effect.Effect<A>,
) =>
  DesktopShutdown.DesktopShutdown.pipe(Effect.flatMap(body), Effect.provide(DesktopShutdown.layer));

describe("DesktopShutdown phase", () => {
  it.effect("lets only the first quit path run", () =>
    withShutdown((shutdown) =>
      Effect.gen(function* () {
        assert.equal(yield* shutdown.phase, "running");
        assert.isTrue(yield* shutdown.beginQuit);
        assert.isFalse(yield* shutdown.beginQuit);
        assert.equal(yield* shutdown.phase, "quitting");
      }),
    ),
  );

  it.effect("returns to running when an update install fails or is cancelled", () =>
    withShutdown((shutdown) =>
      Effect.gen(function* () {
        assert.isTrue(yield* shutdown.beginUpdateInstall);
        assert.equal(yield* shutdown.phase, "installingUpdate");
        assert.isFalse(yield* shutdown.beginUpdateInstall);

        yield* shutdown.cancelUpdateInstall;
        assert.equal(yield* shutdown.phase, "running");
        assert.isTrue(yield* shutdown.beginQuit);
      }),
    ),
  );

  it.effect("keeps an install in charge when a quit arrives during it", () =>
    withShutdown((shutdown) =>
      Effect.gen(function* () {
        assert.isTrue(yield* shutdown.beginUpdateInstall);
        assert.isFalse(yield* shutdown.beginQuit);
        assert.equal(yield* shutdown.phase, "installingUpdate");

        yield* shutdown.cancelUpdateInstall;
        assert.equal(yield* shutdown.phase, "running");
      }),
    ),
  );

  it.effect("does not start an install or leave quitting once a quit has begun", () =>
    withShutdown((shutdown) =>
      Effect.gen(function* () {
        assert.isTrue(yield* shutdown.beginQuit);
        assert.isFalse(yield* shutdown.beginUpdateInstall);

        yield* shutdown.cancelUpdateInstall;
        assert.equal(yield* shutdown.phase, "quitting");
      }),
    ),
  );
});
