import { CadViewError, type TurnId } from "@cadsense/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { ServerRequest__DynamicToolCallParams } from "effect-codex-app-server/schema";
import type { CadProviderTools } from "../CadProviderTools.ts";

const identity = Schema.String.check(Schema.isNonEmpty());
const encodeResult = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const encodeError = Schema.encodeSync(Schema.fromJsonString(CadViewError));
const decodeCall = Schema.decodeUnknownEffect(
  ServerRequest__DynamicToolCallParams.pipe(
    Schema.fieldsAssign({ threadId: identity, turnId: identity, callId: identity }),
  ),
);
export interface CodexCadCaller {
  readonly childKey: string | null;
  readonly turnId: TurnId;
}
export interface CodexCadResult {
  readonly success: boolean;
  readonly contentItems: ReadonlyArray<
    | { readonly type: "inputText"; readonly text: string }
    | { readonly type: "inputImage"; readonly imageUrl: string }
  >;
}
const unavailable = () => new CadViewError({ reason: "capability-unavailable" });
/** Caller lookup uses the native session's live-turn registry, never the model's arguments. */
export const handleCodexCadCall = Effect.fn("handleCodexCadCall")(function* (
  tools: CadProviderTools,
  resolve: (threadId: string, turnId: string) => Effect.Effect<CodexCadCaller | null>,
  raw: unknown,
): Effect.fn.Return<CodexCadResult, CadViewError> {
  const call = yield* decodeCall(raw).pipe(Effect.mapError(unavailable));
  if (call.namespace != null) return yield* unavailable();
  const caller = yield* resolve(call.threadId, call.turnId);
  if (!caller) return yield* unavailable();
  const delivery = yield* tools.invoke(caller.childKey, caller.turnId, call.tool, call.arguments);
  return {
    success: true,
    contentItems: [
      {
        type: "inputText",
        text: yield* encodeResult(delivery.result).pipe(Effect.mapError(unavailable)),
      },
      ...(delivery.png
        ? [
            {
              type: "inputImage" as const,
              imageUrl: `data:image/png;base64,${Buffer.from(delivery.png).toString("base64")}`,
            },
          ]
        : []),
    ],
  };
});
export const codexCadFailure = (error: CadViewError): CodexCadResult => ({
  success: false,
  contentItems: [{ type: "inputText", text: encodeError(error) }],
});
