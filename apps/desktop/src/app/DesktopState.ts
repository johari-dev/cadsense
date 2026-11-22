import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

export class DesktopState extends Context.Service<
  DesktopState,
  {
    readonly quitting: Ref.Ref<boolean>;
  }
>()("@cadsense/desktop/app/DesktopState") {}

const make = Effect.all({
  quitting: Ref.make(false),
});

export const layer = Layer.effect(DesktopState, make);
