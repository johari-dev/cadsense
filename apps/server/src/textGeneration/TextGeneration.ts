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

/**
 * The model to title with on `provider`: its usual cheap title model when it
 * still lists it, else its default (a gateway's configured model) or first.
 */
const titleModelFor = (provider: ServerProvider): string | undefined => {
  const titleModel = DEFAULT_TEXT_GENERATION_MODEL_BY_PROVIDER[provider.driver];
  if (titleModel && servesModel(provider, titleModel)) return titleModel;
  return (provider.models.find((entry) => entry.isDefault) ?? provider.models[0])?.slug;
};

/**
 * The model titles are generated with. The "Text generation model" setting
 * is kept unless its provider has proven it cannot run it:
 *
 *  - provider ready but no longer listing the model (pointed at a local
 *    gateway such as Ollama, which lists only its own models, so the
 *    default `gpt-5.6-luna` would fail): a model that provider lists;
 *  - provider disabled, unavailable or in error (not installed, signed
 *    out): a model the first ready provider in settings order lists.
 *
 * Either way `titleModelFor` picks it.
 *
 * A provider still being checked keeps the setting, so a startup probe never
 * moves titles to another provider. With no ready fallback the setting is
 * kept and fails as before.
 */
export function resolveTextGenerationModelSelection(
  selection: ModelSelection,
  providers: ReadonlyArray<ServerProvider>,
): ModelSelection {
  const selected = providers.find((provider) => provider.instanceId === selection.instanceId);
  if (selected?.enabled && isProviderAvailable(selected) && selected.status !== "error") {
    if (selected.status !== "ready" || servesModel(selected, selection.model)) return selection;
    const model = titleModelFor(selected);
    return model ? createModelSelection(selected.instanceId, model) : selection;
  }
  const fallback = providers.find(
    (provider) => isReadyProvider(provider) && titleModelFor(provider) !== undefined,
  );
  const model = fallback ? titleModelFor(fallback) : undefined;
  return fallback && model ? createModelSelection(fallback.instanceId, model) : selection;
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
          resolveTextGenerationModelSelection(input.modelSelection, providers),
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
