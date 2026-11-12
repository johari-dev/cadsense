/**
 * Model discovery for Claude Code pointed at a custom `ANTHROPIC_BASE_URL`,
 * such as Ollama, LM Studio, LiteLLM, vLLM or OpenRouter.
 *
 * Claude Code's own model list is static: verified against the CLI, its
 * initialization result reports the Anthropic aliases and never asks the
 * gateway. So a local model only reaches the picker if we ask the gateway's
 * `GET /v1/models`, which Anthropic, Ollama and the OpenAI-compatible proxies
 * all answer with a `data[].id` list.
 *
 * @module provider/Drivers/ClaudeGateway
 */
import type { ClaudeSettings } from "@cadsense/contracts";
import { HostProcessPlatform } from "@cadsense/shared/hostProcess";
import { fromLenientJson } from "@cadsense/shared/schemaJson";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

import {
  claudeSettingsPaths,
  findRepositoryRoot,
  resolveClaudeConfigDirPath,
} from "./ClaudeSkills.ts";

const LIST_MODELS_TIMEOUT_MS = 5_000;
const ANTHROPIC_API_HOST = "api.anthropic.com";
const THIRD_PARTY_BACKEND_FLAGS = [
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
] as const;

/** A non-Anthropic endpoint the CLI sends its API requests to. */
export interface ClaudeGateway {
  readonly baseUrl: string;
  readonly headers: Readonly<Record<string, string>>;
}

export interface ClaudeGatewayModel {
  readonly id: string;
  readonly displayName: string | undefined;
}

/**
 * What the gateway reported. `Unlisted` means a gateway is configured but it
 * gave no usable list (unreachable, no `/v1/models`, or zero models), so the
 * caller keeps the Claude catalog and can say why.
 */
export type ClaudeGatewayModels =
  | {
      readonly _tag: "Listed";
      readonly baseUrl: string;
      readonly models: ReadonlyArray<ClaudeGatewayModel>;
    }
  | { readonly _tag: "Unlisted"; readonly baseUrl: string };

const ClaudeSettingsEnv = fromLenientJson(
  Schema.Struct({ env: Schema.optional(Schema.Record(Schema.String, Schema.String)) }),
);
const decodeClaudeSettingsEnv = Schema.decodeUnknownEffect(ClaudeSettingsEnv);

const ModelsResponse = Schema.Struct({
  data: Schema.Array(
    Schema.Struct({ id: Schema.String, display_name: Schema.optional(Schema.String) }),
  ),
});
const decodeModelsResponse = Schema.decodeUnknownEffect(ModelsResponse);

/**
 * The environment the spawned CLI ends up with: the process environment,
 * overlaid by each settings file's `env` block in precedence order. Verified
 * against the CLI: an `ANTHROPIC_BASE_URL` in `settings.json` wins over the
 * same variable exported in the shell, and Ollama's and OpenRouter's setup
 * guides use either place.
 */
export const resolveClaudeEffectiveEnvironment = Effect.fn("resolveClaudeEffectiveEnvironment")(
  function* (
    config: Pick<ClaudeSettings, "homePath">,
    environment: NodeJS.ProcessEnv,
    cwd: string | undefined,
  ): Effect.fn.Return<NodeJS.ProcessEnv, never, FileSystem.FileSystem | Path.Path> {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const platform = yield* HostProcessPlatform;
    const configDirPath = yield* resolveClaudeConfigDirPath(config, environment, cwd);
    const repositoryRoot = cwd === undefined ? undefined : yield* findRepositoryRoot(cwd);

    const merged: NodeJS.ProcessEnv = { ...environment };
    for (const settingsPath of claudeSettingsPaths(
      path,
      configDirPath,
      cwd,
      platform,
      environment,
      repositoryRoot,
    )) {
      const settings = yield* fileSystem.readFileString(settingsPath).pipe(
        Effect.flatMap(decodeClaudeSettingsEnv),
        Effect.orElseSucceed(() => undefined),
      );
      Object.assign(merged, settings?.env);
    }
    return merged;
  },
);

function isFlagSet(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase() ?? "";
  return normalized !== "" && normalized !== "0" && normalized !== "false";
}

/**
 * The gateway this environment points the CLI at, or `undefined` when the CLI
 * talks to Anthropic directly or to a cloud backend (Bedrock, Vertex,
 * Foundry), whose catalogs are the Claude models we already ship. Sends the
 * same credentials the CLI would: `ANTHROPIC_AUTH_TOKEN` as a bearer token and
 * `ANTHROPIC_API_KEY` as `x-api-key`.
 */
export function resolveClaudeGateway(environment: NodeJS.ProcessEnv): ClaudeGateway | undefined {
  const rawBaseUrl = environment.ANTHROPIC_BASE_URL?.trim();
  if (!rawBaseUrl) return undefined;
  if (THIRD_PARTY_BACKEND_FLAGS.some((flag) => isFlagSet(environment[flag]))) return undefined;
  if (!URL.canParse(rawBaseUrl)) return undefined;
  if (new URL(rawBaseUrl).hostname.toLowerCase() === ANTHROPIC_API_HOST) return undefined;

  const authToken = environment.ANTHROPIC_AUTH_TOKEN?.trim();
  const apiKey = environment.ANTHROPIC_API_KEY?.trim();
  return {
    baseUrl: rawBaseUrl.replace(/\/+$/, ""),
    headers: {
      "anthropic-version": "2023-06-01",
      ...(authToken ? { authorization: `Bearer ${authToken}` } : {}),
      ...(apiKey ? { "x-api-key": apiKey } : {}),
    },
  };
}

/**
 * Ask a gateway for its models. Never fails: any error becomes `Unlisted`.
 * `limit=1000` is the Anthropic API's page maximum; gateways that do not
 * paginate ignore it.
 */
export const listClaudeGatewayModels = Effect.fn("listClaudeGatewayModels")(function* (
  gateway: ClaudeGateway,
): Effect.fn.Return<ClaudeGatewayModels, never, HttpClient.HttpClient> {
  const httpClient = yield* HttpClient.HttpClient;
  const unlisted = { _tag: "Unlisted", baseUrl: gateway.baseUrl } as const;
  const response = yield* httpClient
    .get(`${gateway.baseUrl}/v1/models`, {
      headers: gateway.headers,
      urlParams: { limit: "1000" },
    })
    .pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap((ok) => ok.json),
      Effect.flatMap(decodeModelsResponse),
      Effect.timeout(LIST_MODELS_TIMEOUT_MS),
      Effect.tapCause((cause) =>
        Effect.logWarning("Could not list models from the Claude gateway.", {
          baseUrl: gateway.baseUrl,
          cause,
        }),
      ),
      Effect.orElseSucceed(() => undefined),
    );
  if (!response) return unlisted;

  const seen = new Set<string>();
  const models: Array<ClaudeGatewayModel> = [];
  for (const entry of response.data) {
    const id = entry.id.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    models.push({ id, displayName: entry.display_name?.trim() || undefined });
  }
  return models.length > 0 ? { _tag: "Listed", baseUrl: gateway.baseUrl, models } : unlisted;
});

/**
 * Models from the gateway this Claude instance is configured for, or
 * `undefined` when it uses Anthropic's own API. `environment` must already
 * carry the instance's `CLAUDE_CONFIG_DIR` (see `makeClaudeEnvironment`).
 */
export const discoverClaudeGatewayModels = Effect.fn("discoverClaudeGatewayModels")(function* (
  config: Pick<ClaudeSettings, "homePath">,
  environment: NodeJS.ProcessEnv,
  cwd: string | undefined,
): Effect.fn.Return<
  ClaudeGatewayModels | undefined,
  never,
  FileSystem.FileSystem | Path.Path | HttpClient.HttpClient
> {
  const effectiveEnvironment = yield* resolveClaudeEffectiveEnvironment(config, environment, cwd);
  const gateway = resolveClaudeGateway(effectiveEnvironment);
  return gateway ? yield* listClaudeGatewayModels(gateway) : undefined;
});
