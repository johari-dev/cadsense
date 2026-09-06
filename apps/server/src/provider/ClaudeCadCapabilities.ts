import { CadViewError, type TurnId } from "@cadsense/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { CadProviderTools, CadToolDelivery } from "./CadProviderTools.ts";

export const CLAUDE_CAD_CAPABILITY_FIELD = "_cadsenseCapability";
const unavailable = () => new CadViewError({ reason: "capability-unavailable" });
interface Session {
  readonly tools: CadProviderTools;
  readonly isActive: (childKey: string | null, turnId: TurnId) => boolean;
  readonly calls: Map<
    string,
    { name: string; input: unknown; childKey: string | null; turnId: TurnId }
  >;
}
export class ClaudeCadCapabilities extends Context.Service<
  ClaudeCadCapabilities,
  {
    readonly register: (
      id: string,
      tools: CadProviderTools,
      isActive: Session["isActive"],
    ) => Effect.Effect<void, never, import("effect/Scope").Scope>;
    readonly available: (id: string) => Effect.Effect<boolean>;
    readonly issue: (
      id: string,
      childKey: string | null,
      turnId: TurnId,
      name: string,
      input: unknown,
    ) => Effect.Effect<string, CadViewError>;
    readonly consume: (
      id: string,
      token: string,
      name: string,
    ) => Effect.Effect<CadToolDelivery, CadViewError>;
  }
>()("@cadsense/server/provider/ClaudeCadCapabilities") {}
export const layer = Layer.effect(
  ClaudeCadCapabilities,
  Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto;
    const sessions = new Map<string, Session>();
    return ClaudeCadCapabilities.of({
      register: (id, tools, isActive) =>
        Effect.acquireRelease(
          Effect.sync(() => {
            sessions.set(id, { tools, isActive, calls: new Map() });
          }),
          () =>
            Effect.sync(() => {
              sessions.delete(id);
            }),
        ),
      available: (id) => Effect.sync(() => sessions.has(id)),
      issue: Effect.fn("ClaudeCadCapabilities.issue")(
        function* (id, childKey, turnId, name, input) {
          const session = sessions.get(id);
          if (!session || !session.isActive(childKey, turnId)) return yield* unavailable();
          for (const [token, call] of session.calls)
            if (!session.isActive(call.childKey, call.turnId)) session.calls.delete(token);
          if (session.calls.size >= 256) return yield* unavailable();
          const token = yield* crypto.randomUUIDv4.pipe(Effect.mapError(unavailable));
          session.calls.set(token, { childKey, turnId, name, input });
          return token;
        },
      ),
      consume: Effect.fn("ClaudeCadCapabilities.consume")(function* (id, token, name) {
        const session = sessions.get(id);
        const call = session?.calls.get(token);
        if (
          !session ||
          !call ||
          call.name !== name ||
          !session.isActive(call.childKey, call.turnId)
        )
          return yield* unavailable();
        session.calls.delete(token);
        return yield* session.tools.invoke(call.childKey, call.turnId, name, call.input);
      }),
    });
  }),
);
