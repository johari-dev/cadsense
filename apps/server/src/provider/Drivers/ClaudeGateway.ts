/**
 * Which gateway Claude Code is pointed at, from a custom `ANTHROPIC_BASE_URL`
 * (Ollama, LM Studio, LiteLLM, vLLM, OpenRouter...). Claude Code's own model
 * list is static: verified against the CLI, its initialization result reports
 * the Anthropic aliases and never asks the gateway. `GatewayModels` does the
 * asking.
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
import { HttpClient } from "effect/unstable/http";

import { type Gateway, type GatewayModels, listGatewayModels } from "../GatewayModels.ts";
import {
  claudeSettingsPaths,
  findRepositoryRoot,
  resolveClaudeConfigDirPath,
} from "./ClaudeSkills.ts";

const ANTHROPIC_API_HOST = "api.anthropic.com";
const THIRD_PARTY_BACKEND_FLAGS = [
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
] as const;

const ClaudeSettingsEnv = fromLenientJson(
  Schema.Struct({ env: Schema.optional(Schema.Record(Schema.String, Schema.String)) }),
);
const decodeClaudeSettingsEnv = Schema.decodeUnknownEffect(ClaudeSettingsEnv);

/**
 * The environment the spawned CLI ends up with: the process environment,
 * overlaid by each settings file's `env` block in precedence order. Verified
 * against the CLI: an `ANTHROPIC_BASE_URL` in `settings.json` wins over the
 * same variable exported in the shell, and Ollama's and OpenRouter's setup
 * guides use either place.
 */
const resolveClaudeEffectiveEnvironment = Effect.fn("resolveClaudeEffectiveEnvironment")(function* (
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
});

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
function resolveClaudeGateway(environment: NodeJS.ProcessEnv): Gateway | undefined {
  const rawBaseUrl = environment.ANTHROPIC_BASE_URL?.trim();
  if (!rawBaseUrl) return undefined;
  if (THIRD_PARTY_BACKEND_FLAGS.some((flag) => isFlagSet(environment[flag]))) return undefined;
  if (!URL.canParse(rawBaseUrl)) return undefined;
  if (new URL(rawBaseUrl).hostname.toLowerCase() === ANTHROPIC_API_HOST) return undefined;

  const authToken = environment.ANTHROPIC_AUTH_TOKEN?.trim();
  const apiKey = environment.ANTHROPIC_API_KEY?.trim();
  const baseUrl = rawBaseUrl.replace(/\/+$/, "");
  return {
    baseUrl,
    modelsUrl: `${baseUrl}/v1/models`,
    headers: {
      "anthropic-version": "2023-06-01",
      ...(authToken ? { authorization: `Bearer ${authToken}` } : {}),
      ...(apiKey ? { "x-api-key": apiKey } : {}),
    },
  };
}

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
  GatewayModels | undefined,
  never,
  FileSystem.FileSystem | Path.Path | HttpClient.HttpClient
> {
  const effectiveEnvironment = yield* resolveClaudeEffectiveEnvironment(config, environment, cwd);
  const gateway = resolveClaudeGateway(effectiveEnvironment);
  return gateway ? yield* listGatewayModels(gateway) : undefined;
});
