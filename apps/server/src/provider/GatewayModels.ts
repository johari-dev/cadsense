/**
 * Model listing for a CLI pointed at a local or third-party gateway (Ollama,
 * LM Studio, LiteLLM, vLLM, OpenRouter...). Neither Claude Code nor Codex asks
 * such a gateway for its models: verified against both CLIs, their model
 * lists stay the built-in Anthropic or OpenAI ones. So the provider check asks
 * the gateway's models endpoint itself. Anthropic's `/v1/models` and the
 * OpenAI-compatible `/models` both answer with a `data[].id` list.
 *
 * @module provider/GatewayModels
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

const LIST_MODELS_TIMEOUT_MS = 5_000;

/** A gateway's models endpoint and the headers the CLI would send it. */
export interface Gateway {
  /** Shown to the user when listing fails. */
  readonly baseUrl: string;
  readonly modelsUrl: string;
  readonly headers: Readonly<Record<string, string>>;
}

export interface GatewayModel {
  readonly id: string;
  readonly displayName: string | undefined;
}

/**
 * What the gateway reported. `Unlisted` means it gave no usable list
 * (unreachable, no models endpoint, or zero models), so the caller keeps its
 * built-in models and can say why.
 */
export type GatewayModels =
  | {
      readonly _tag: "Listed";
      readonly baseUrl: string;
      readonly models: ReadonlyArray<GatewayModel>;
    }
  | { readonly _tag: "Unlisted"; readonly baseUrl: string };

const ModelsResponse = Schema.Struct({
  data: Schema.Array(
    Schema.Struct({ id: Schema.String, display_name: Schema.optional(Schema.String) }),
  ),
});
const decodeModelsResponse = Schema.decodeUnknownEffect(ModelsResponse);

/** The status message for a gateway that could not list its models. */
export function formatUnlistedGatewayMessage(baseUrl: string, fallback: string): string {
  return `Could not list models from ${baseUrl}, so the picker shows ${fallback} models.`;
}

/**
 * Ask a gateway for its models. Never fails: any error becomes `Unlisted`.
 * `limit=1000` is the Anthropic API's page maximum; gateways that do not
 * paginate ignore it.
 */
export const listGatewayModels = Effect.fn("listGatewayModels")(function* (
  gateway: Gateway,
): Effect.fn.Return<GatewayModels, never, HttpClient.HttpClient> {
  const httpClient = yield* HttpClient.HttpClient;
  const unlisted = { _tag: "Unlisted", baseUrl: gateway.baseUrl } as const;
  const response = yield* httpClient
    .get(gateway.modelsUrl, { headers: gateway.headers, urlParams: { limit: "1000" } })
    .pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap((ok) => ok.json),
      Effect.flatMap(decodeModelsResponse),
      Effect.timeout(LIST_MODELS_TIMEOUT_MS),
      Effect.tapCause((cause) =>
        Effect.logWarning("Could not list models from the gateway.", {
          baseUrl: gateway.baseUrl,
          cause,
        }),
      ),
      Effect.orElseSucceed(() => undefined),
    );
  if (!response) return unlisted;

  const seen = new Set<string>();
  const models: Array<GatewayModel> = [];
  for (const entry of response.data) {
    const id = entry.id.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    models.push({ id, displayName: entry.display_name?.trim() || undefined });
  }
  return models.length > 0 ? { _tag: "Listed", baseUrl: gateway.baseUrl, models } : unlisted;
});
