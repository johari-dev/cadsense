/**
 * Which gateway Codex is pointed at, from the `model_provider` in its config:
 * the built-in `ollama` or `lmstudio` (`codex --oss`), or a custom
 * `[model_providers.<id>]` entry with a `base_url`. Verified against the CLI,
 * `model/list` keeps returning the OpenAI models whatever the provider, so
 * `GatewayModels` asks the gateway instead. A provider with a
 * `model_catalog_url` is skipped: Codex already lists that catalog itself,
 * with richer metadata than a `/models` endpoint has.
 *
 * @module provider/Drivers/CodexGateway
 */
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { Gateway } from "../GatewayModels.ts";

/**
 * Codex's own local providers and the ports they default to. Verified
 * against the CLI: `CODEX_OSS_PORT` moves both, and `CODEX_OSS_BASE_URL`
 * wins over it.
 */
const BUILT_IN_LOCAL_PROVIDER_PORTS: Readonly<Record<string, number>> = {
  ollama: 11434,
  lmstudio: 1234,
};

/** The fields this module reads from the app-server's `config/read` result. */
const CodexConfigRead = Schema.Struct({
  config: Schema.Struct({
    model: Schema.optional(Schema.NullOr(Schema.String)),
    model_provider: Schema.optional(Schema.NullOr(Schema.String)),
    model_providers: Schema.optional(
      Schema.NullOr(
        Schema.Record(
          Schema.String,
          Schema.Struct({
            base_url: Schema.optional(Schema.NullOr(Schema.String)),
            env_key: Schema.optional(Schema.NullOr(Schema.String)),
            model_catalog_url: Schema.optional(Schema.NullOr(Schema.String)),
          }),
        ),
      ),
    ),
  }),
});
export type CodexConfigRead = typeof CodexConfigRead.Type;
export const decodeCodexConfigRead = Schema.decodeUnknownOption(CodexConfigRead);

/** A gateway plus the model Codex is configured to use on it. */
export interface CodexGateway extends Gateway {
  readonly configuredModel: string | undefined;
}

/**
 * The gateway Codex's active provider points at, or `undefined` for the
 * OpenAI provider, cloud ones like Bedrock (which have no `base_url`), and
 * providers whose `model_catalog_url` already feeds `model/list`.
 * Sends the provider's `env_key` as a bearer token, as Codex does.
 */
export function resolveCodexGateway(
  configRead: unknown,
  environment: NodeJS.ProcessEnv,
): CodexGateway | undefined {
  const decoded = decodeCodexConfigRead(configRead);
  if (Option.isNone(decoded)) return undefined;
  const { config } = decoded.value;
  const providerId = config.model_provider?.trim() || "openai";
  if (providerId === "openai") return undefined;

  const provider = config.model_providers?.[providerId];
  if (provider?.model_catalog_url?.trim()) return undefined;
  const builtInPort = BUILT_IN_LOCAL_PROVIDER_PORTS[providerId];
  const rawBaseUrl =
    provider?.base_url?.trim() ||
    (builtInPort === undefined
      ? undefined
      : environment.CODEX_OSS_BASE_URL?.trim() ||
        `http://localhost:${environment.CODEX_OSS_PORT?.trim() || builtInPort}/v1`);
  if (!rawBaseUrl || !URL.canParse(rawBaseUrl)) return undefined;

  const baseUrl = rawBaseUrl.replace(/\/+$/, "");
  const apiKey = provider?.env_key ? environment[provider.env_key]?.trim() : undefined;
  return {
    baseUrl,
    modelsUrl: `${baseUrl}/models`,
    headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
    configuredModel: config.model?.trim() || undefined,
  };
}
