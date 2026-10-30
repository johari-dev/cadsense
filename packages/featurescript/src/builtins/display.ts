import type { Entity } from "../geometry/Model.ts";
import { evaluateQuery } from "../geometry/Query.ts";
import type { BuiltinImpl } from "../runtime/Interpreter.ts";
import type { ModelContext } from "../runtime/ModelContext.ts";
import { FsMap, keyOf, untag, type FsValue } from "../runtime/Value.ts";
import { context, map } from "./args.ts";
import type { StdBuiltinName } from "./stdBuiltinNames.generated.ts";

/**
 * What Onshape draws for a feature besides its geometry. Std says this display "is not rolled back
 * even if the feature fails", so it lives beside the context's rollback state, by feature id.
 * Display builtins never change a feature's status or message: what they can't record they skip,
 * with the reason.
 */
export interface FeatureDisplay {
  /** Entities `setErrorEntities` marked, as they were when it ran; Onshape shows them in red. */
  readonly errorEntities: readonly Entity[];
  /** Why some error entities couldn't be found to draw: a query this runtime can't evaluate. */
  readonly undrawnErrorEntities: readonly string[];
  /**
   * Manipulators `addManipulators` added, by key; the keys of the `newManipulators` its
   * "Manipulator Change Function" gets. Later calls add to earlier ones.
   */
  readonly manipulators: FsMap;
}

const EMPTY: FeatureDisplay = {
  errorEntities: [],
  undrawnErrorEntities: [],
  manipulators: FsMap.empty,
};
const displays = new WeakMap<ModelContext, Map<string, FeatureDisplay>>();

/** The display recorded for feature `id` in `model`'s context. */
export const featureDisplay = (model: ModelContext, id: FsValue): FeatureDisplay =>
  displays.get(model)?.get(keyOf(untag(id))) ?? EMPTY;

const update = (
  model: ModelContext,
  id: FsValue,
  change: (display: FeatureDisplay) => FeatureDisplay,
) => {
  const byFeature = displays.get(model) ?? new Map<string, FeatureDisplay>();
  displays.set(model, byFeature);
  byFeature.set(keyOf(untag(id)), change(featureDisplay(model, id)));
};

/**
 * The entities `query` names now, or why they can't be found. A query this runtime can't evaluate
 * (or a value that isn't one) mustn't fail or stop the feature for the sake of drawing it.
 */
function displayed(
  model: ModelContext,
  query: FsValue,
): { readonly entities: readonly Entity[] } | { readonly undrawn: string } {
  const skip = (message: string): never => {
    throw new Undrawn(message);
  };
  try {
    if (!model.oc) return { entities: [] };
    return {
      entities: evaluateQuery(
        { oc: model.oc, state: model.geometry, fail: skip, unsupported: skip },
        query,
      ),
    };
  } catch (error) {
    if (error instanceof Undrawn) return { undrawn: error.message };
    throw error;
  }
}
class Undrawn extends Error {}

/** `existing` plus `added`, each entity once. */
const union = (existing: readonly Entity[], added: readonly Entity[]) => [
  ...existing,
  ...added.filter((entity) => !existing.some((other) => other.id === entity.id)),
];

/** Feature display builtins; they record what a preview should draw and change no geometry. */
export const DISPLAY_BUILTINS = {
  /**
   * `setErrorEntities(context, id, { entities })`, which std's `processError` also calls with a
   * thrown `regenError`'s map. The query is evaluated now, before std rolls the feature back, so
   * entities the failed feature made can still be drawn.
   */
  setErrorEntities: ([ctx, id, definition], call) => {
    const model = context(call, ctx);
    const found = displayed(model, map(call, definition, "definition").getField("entities"));
    update(model, id, (display) =>
      "undrawn" in found
        ? { ...display, undrawnErrorEntities: [...display.undrawnErrorEntities, found.undrawn] }
        : { ...display, errorEntities: union(display.errorEntities, found.entities) },
    );
    return undefined;
  },
  /** `addManipulators(context, id, manipulators)`: std has checked each is a `Manipulator`. */
  addManipulators: ([ctx, id, manipulators], call) => {
    const added = map(call, manipulators, "manipulators");
    update(context(call, ctx), id, (display) => ({
      ...display,
      manipulators: added
        .entries()
        .reduce((all, [key, manipulator]) => all.set(key, manipulator), display.manipulators),
    }));
    return undefined;
  },
  /** Shows a subfeature's error entities as the feature's own (`processSubfeatureStatus`). */
  transferSubfeatureErrorDisplay: ([ctx, id, definition], call) => {
    const model = context(call, ctx);
    const sub = featureDisplay(model, map(call, definition, "definition").getField("subfeatureId"));
    update(model, id, (display) => ({
      ...display,
      errorEntities: union(display.errorEntities, sub.errorEntities),
      undrawnErrorEntities: [...display.undrawnErrorEntities, ...sub.undrawnErrorEntities],
    }));
    return undefined;
  },
} satisfies Partial<Record<StdBuiltinName, BuiltinImpl>>;
