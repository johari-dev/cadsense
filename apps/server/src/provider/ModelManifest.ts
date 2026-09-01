/**
 * Bundled model classification used to keep older provider models out of the
 * primary picker. Updating the desktop application updates this manifest.
 */
import type { ProviderDriverKind, ServerProviderModel } from "@cadsense/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import bundledManifestJson from "./model-manifest.json" with { type: "json" };
import type { ServerProviderDraft } from "./providerSnapshot.ts";

const ModelManifestSchema = Schema.Struct({
  version: Schema.Literal(1),
  currentModels: Schema.Record(Schema.String, Schema.Array(Schema.String)),
});
export type ModelManifestData = typeof ModelManifestSchema.Type;

export const BUNDLED_MODEL_MANIFEST: ModelManifestData =
  Schema.decodeUnknownSync(ModelManifestSchema)(bundledManifestJson);

/** True when the manifest classifies `slug` as legacy for `driverKind`. */
export function isLegacyModel(
  manifest: ModelManifestData,
  driverKind: ProviderDriverKind,
  slug: string,
): boolean {
  const currentModels = manifest.currentModels[driverKind];
  if (!currentModels) return false;
  return !currentModels.includes(slug);
}

/**
 * Reclassifies every built-in model on a snapshot draft against the bundled
 * manifest. Custom models are user-defined and never reclassified.
 */
export function applyModelManifest(
  draft: ServerProviderDraft,
  manifest: ModelManifestData,
  driverKind: ProviderDriverKind,
): ServerProviderDraft {
  return { ...draft, models: classifyModels(draft.models, manifest, driverKind) };
}

export function classifyModels(
  models: ReadonlyArray<ServerProviderModel>,
  manifest: ModelManifestData,
  driverKind: ProviderDriverKind,
): ReadonlyArray<ServerProviderModel> {
  return models.map((model) => {
    if (model.isCustom) return model;
    if (isLegacyModel(manifest, driverKind, model.slug)) {
      return model.isLegacy ? model : { ...model, isLegacy: true };
    }
    if (!model.isLegacy) return model;
    const { isLegacy: _isLegacy, ...rest } = model;
    return rest;
  });
}

export class ModelManifest extends Context.Service<
  ModelManifest,
  {
    readonly current: Effect.Effect<ModelManifestData>;
  }
>()("@cadsense/server/provider/ModelManifest") {}

export const BundledModelManifest: ModelManifest["Service"] = {
  current: Effect.succeed(BUNDLED_MODEL_MANIFEST),
};

export const layer = Layer.succeed(ModelManifest, BundledModelManifest);
export const layerTest = layer;
