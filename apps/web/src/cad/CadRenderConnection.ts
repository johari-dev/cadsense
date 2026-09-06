import { CadRenderError, type CadRenderEvent } from "@cadsense/contracts";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

interface RenderHost {
  accept(event: CadRenderEvent): void;
  dispose(): void;
}
const isRenderError = Schema.is(CadRenderError);

/** Retry only a short host handoff race; never replay captures or poll an idle host. */
export function connectCadRenderHost<E, R>(
  connect: () => Stream.Stream<CadRenderEvent, E, R>,
  createHost: () => RenderHost,
): Stream.Stream<CadRenderEvent, E, R> {
  return Stream.unwrap(
    Effect.acquireRelease(Effect.sync(createHost), (host) =>
      Effect.sync(() => host.dispose()),
    ).pipe(
      Effect.map((host) =>
        connect().pipe(Stream.tap((event) => Effect.sync(() => host.accept(event)))),
      ),
    ),
  ).pipe(
    Stream.retry(
      Schedule.spaced("250 millis").pipe(
        Schedule.while(
          ({ input, attempt }) => attempt <= 3 && isRenderError(input) && input.reason === "busy",
        ),
      ),
    ),
  );
}
