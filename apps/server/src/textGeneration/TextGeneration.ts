import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import {
  type ChatAttachment,
  DEFAULT_TEXT_GENERATION_MODEL_BY_PROVIDER,
  isProviderAvailable,
  type ModelSelection,
  type ProviderInstanceId,
  type ServerProvider,
} from "@cadsense/contracts";
import { createModelSelection } from "@cadsense/shared/model";

import * as ProviderInstanceRegistry from "../provider/Services/ProviderInstanceRegistry.ts";
import type { ProviderInstance } from "../provider/ProviderDriver.ts";

export type TextGenerationProvider = "codex" | "claudeAgent";

export class ThreadTitleGenerationError extends Schema.TaggedErrorClass<ThreadTitleGenerationError>()(
  "ThreadTitleGenerationError",
  {
    operation: Schema.Literal("generateThreadTitle"),
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.detail;
  }
}

export interface ThreadTitleGenerationInput {
  cwd: string;
  message: string;
  /** Present when replacing an existing title from the current thread history. */
  previousTitle?: string | undefined;
  attachments?: ReadonlyArray<ChatAttachment> | undefined;
  /** What model and provider to use for generation. */
  modelSelection: ModelSelection;
  /**
   * The model the chat runs on. Titles fall back to it when the title model
   * cannot run, since the chat has shown it works.
   */
  chatModelSelection?: ModelSelection | undefined;
}

export interface ThreadTitleGenerationResult {
  title: string;
}

/**
 * TextGeneration - Service tag for generated thread titles.
 */
export class TextGeneration extends Context.Service<
  TextGeneration,
  {
    /** Generate a concise thread title from a first message or thread history. */
    readonly generateThreadTitle: (
      input: ThreadTitleGenerationInput,
    ) => Effect.Effect<ThreadTitleGenerationResult, ThreadTitleGenerationError>;
  }
>()("@cadsense/server/textGeneration/TextGeneration") {}

const resolveInstance = (
  registry: ProviderInstanceRegistry.ProviderInstanceRegistry["Service"],
  instanceId: ProviderInstanceId,
): Effect.Effect<ProviderInstance["textGeneration"], ThreadTitleGenerationError> =>
  registry.getInstance(instanceId).pipe(
    Effect.flatMap((instance) =>
      instance
        ? Effect.succeed(instance.textGeneration)
        : Effect.fail(
            new ThreadTitleGenerationError({
              operation: "generateThreadTitle",
              detail: `No provider instance registered for id '${instanceId}'.`,
            }),
          ),
    ),
  );

/** A provider that can run a turn right now: the model picker's rule. */
const isReadyProvider = (provider: ServerProvider): boolean =>
  provider.enabled && isProviderAvailable(provider) && provider.status === "ready";

const servesModel = (provider: ServerProvider, model: string): boolean =>
  provider.models.some((entry) => entry.slug === model || entry.aliases?.includes(model));

/** The provider's usual cheap title model, when it still lists it. */
const cheapTitleModel = (provider: ServerProvider): string | undefined => {
  const titleModel = DEFAULT_TEXT_GENERATION_MODEL_BY_PROVIDER[provider.driver];
  return titleModel && servesModel(provider, titleModel) ? titleModel : undefined;
};

/** The provider's default model (a gateway's configured model), else its first. */
const defaultModel = (provider: ServerProvider): string | undefined =>
  (provider.models.find((entry) => entry.isDefault) ?? provider.models[0])?.slug;

/**
 * The model titles are generated with. The "Text generation model" setting
 * is kept unless its provider has proven it cannot run it: the provider is
 * ready but no longer lists the model (pointed at a local gateway such as
 * Ollama, which lists only its own models, so the default `gpt-5.6-luna`
 * would fail), or it is disabled, unavailable or in error (not installed,
 * signed out). Then titles use, in order:
 *
 *  1. a ready provider's usual cheap title model (`gpt-5.6-luna`,
 *     `claude-haiku-4-5`), the setting's provider first, then settings order;
 *  2. the chat's own model, when its provider is ready and lists it. A
 *     gateway list has no cheap title model and its first entry may not
 *     support tools, which the Claude CLI needs for structured output;
 *  3. a ready provider's default or first model, in the same order.
 *
 * A provider still being checked keeps the setting, so a startup probe never
 * moves titles to another provider. With nothing ready the setting is kept
 * and fails as before.
 */
export function resolveTextGenerationModelSelection(
  selection: ModelSelection,
  providers: ReadonlyArray<ServerProvider>,
  chatSelection?: ModelSelection,
): ModelSelection {
  const findProvider = (instanceId: ModelSelection["instanceId"]) =>
    providers.find((provider) => provider.instanceId === instanceId);
  const selected = findProvider(selection.instanceId);
  if (selected?.enabled && isProviderAvailable(selected) && selected.status !== "error") {
    if (selected.status !== "ready" || servesModel(selected, selection.model)) return selection;
  }

  const ready = [
    ...(selected && isReadyProvider(selected) ? [selected] : []),
    ...providers.filter((provider) => provider !== selected && isReadyProvider(provider)),
  ];
  const pickFrom = (choose: (provider: ServerProvider) => string | undefined) => {
    for (const provider of ready) {
      const model = choose(provider);
      if (model) return createModelSelection(provider.instanceId, model);
    }
    return undefined;
  };
  const chatProvider = chatSelection ? findProvider(chatSelection.instanceId) : undefined;
  const chatModel =
    chatSelection &&
    chatProvider &&
    isReadyProvider(chatProvider) &&
    servesModel(chatProvider, chatSelection.model)
      ? chatSelection
      : undefined;
  return pickFrom(cheapTitleModel) ?? chatModel ?? pickFrom(defaultModel) ?? selection;
}

export const makeTextGenerationFromRegistry = (
  registry: ProviderInstanceRegistry.ProviderInstanceRegistry["Service"],
): TextGeneration["Service"] =>
  TextGeneration.of({
    generateThreadTitle: (input) =>
      registry.listInstances.pipe(
        Effect.flatMap((instances) =>
          Effect.forEach(instances, (instance) => instance.snapshot.getSnapshot),
        ),
        Effect.map((providers) =>
          resolveTextGenerationModelSelection(
            input.modelSelection,
            providers,
            input.chatModelSelection,
          ),
        ),
        Effect.flatMap((modelSelection) =>
          resolveInstance(registry, modelSelection.instanceId).pipe(
            Effect.flatMap((textGeneration) =>
              textGeneration.generateThreadTitle({ ...input, modelSelection }),
            ),
          ),
        ),
      ),
  });

export const make = Effect.gen(function* () {
  const registry = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  return makeTextGenerationFromRegistry(registry);
});

export const layer = Layer.effect(TextGeneration, make);
