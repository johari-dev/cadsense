import { startsWith } from "../geometry/Model.ts";
import type { Oc } from "../geometry/occt.ts";
import type { BuiltinImpl } from "../runtime/Interpreter.ts";
import { ModelContext } from "../runtime/ModelContext.ts";
import {
  equals,
  formatValue,
  FsBuiltin,
  FsMap,
  FsTagged,
  untag,
  type FsValue,
} from "../runtime/Value.ts";
import { context, map, string } from "./args.ts";
import { idOf, kernel, resolve } from "./geometryArgs.ts";
import { stdEnum, stdTagged } from "./std.ts";
import type { StdBuiltinName } from "./stdBuiltinNames.generated.ts";

/** The token `@startFeature` returns. std stores it in `var token is map`, so it has to be a map. */
const tokenOf = (value: FsValue): number | null => {
  const t = untag(value);
  const n = t instanceof FsMap ? t.getField("token") : undefined;
  return typeof n === "number" ? n : null;
};

/** Status maps hold plain strings; std's `getFeatureStatus` re-tags them. */
const plainStatus = (status: FsMap) =>
  FsMap.fromEntries(
    status
      .entries()
      .map(
        ([key, value]) =>
          [key, key === "statusType" || key === "statusEnum" ? untag(value) : value] as const,
      ),
  );

const IDENTITY_TRANSFORM = FsMap.fromEntries([
  [
    "linear",
    [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ],
  ],
  ["translation", [0, 0, 0]],
]);

/** Builtins that only feed Onshape's UI (highlights, manipulators, dimension labels). Locally they do nothing. */
const UI_ONLY = [
  "recordQuery",
  "setFeatureComputedParameter",
  "setErrorEntities",
  "setHighlightedEntities",
  "setDimensionedEntities",
  "setExternalDisambiguation",
  "setFeatureHiddenParameters",
  "addManipulators",
  "addDebugEntities",
  "addAuxiliaryEntities",
  "addReferenceCSysFrame",
  "transferSubfeatureErrorDisplay",
  "setFeaturePatternInstanceData",
  "unsetFeaturePatternInstanceData",
  "setPatternData",
  "startTimer",
  "printTimer",
] as const satisfies readonly StdBuiltinName[];
const noop: BuiltinImpl = () => undefined;

/** Context builtins; contexts get geometry when the runtime has a kernel. */
export const contextBuiltins = (oc: Oc | null) =>
  ({
    ...(Object.fromEntries(UI_ONLY.map((name) => [name, noop])) as Record<
      (typeof UI_ONLY)[number],
      BuiltinImpl
    >),

    newContext: ([version]) => new FsBuiltin(new ModelContext(version, oc)),
    isContext: ([value]) => value instanceof FsBuiltin && value.native instanceof ModelContext,

    startFeature: ([ctx, id, definition], call) => {
      const fields = untag(definition);
      const asVersion = fields instanceof FsMap ? fields.getField("asVersion") : undefined;
      return FsMap.fromEntries([["token", context(call, ctx).start(id, asVersion)]]);
    },
    endFeature: ([ctx, id, token], call) => {
      context(call, ctx).end(tokenOf(token), id);
      return undefined;
    },
    abortFeature: ([ctx, id, token], call) => {
      context(call, ctx).abort(tokenOf(token), id);
      return undefined;
    },

    // A missing name returns `defaultValue` when std passes one, and throws otherwise.
    getVariable: ([ctx, args], call) => {
      const definition = map(call, args, "definition");
      const name = string(call, definition.getField("name"), "name");
      const c = context(call, ctx);
      if (c.hasVariable(name)) return c.getVariable(name);
      if (definition.has("defaultValue")) return definition.getField("defaultValue");
      return call.fail(`Variable "${name}" not found.`);
    },
    setVariable: ([ctx, args], call) => {
      const definition = map(call, args, "definition");
      context(call, ctx).setVariable(
        string(call, definition.getField("name"), "name"),
        definition.getField("value"),
        definition.getField("description"),
      );
      return undefined;
    },
    // std's Variable feature probes this without a default (in `try silent`) to keep query and
    // plain variable names apart, so a missing name must throw.
    getQueryVariable: ([ctx, args], call) => {
      const definition = map(call, args, "definition");
      const name = string(call, definition.getField("name"), "name");
      const query = context(call, ctx).getQueryVariable(name);
      if (query !== undefined) return query;
      if (definition.has("defaultValue")) return definition.getField("defaultValue");
      return call.fail(`Query variable "${name}" not found.`);
    },
    setQueryVariable: ([ctx, args], call) => {
      const definition = map(call, args, "definition");
      const value = definition.getField("value");
      if (!(untag(value) instanceof FsMap)) return call.fail("value must be a Query.");
      context(call, ctx).setQueryVariable(
        string(call, definition.getField("name"), "name"),
        value,
        definition.getField("description"),
      );
      return undefined;
    },
    getAllVariables: ([ctx], call) => context(call, ctx).variables(),
    getAllVariablesAndDescriptions: ([ctx], call) => context(call, ctx).variablesWithDescriptions(),

    functionReportFeatureStatus: ([ctx, id, status], call) => {
      context(call, ctx).setStatus(id, plainStatus(map(call, status, "status")));
      return undefined;
    },
    functionGetFeatureStatus: ([ctx, id], call) => context(call, ctx).status(id),
    clearFeatureStatus: ([ctx, id], call) => {
      context(call, ctx).clearStatus(id);
      return true;
    },

    // The active feature's version, or `asVersion` when given (sketch.fs passes its own before the
    // sketch's subfeature holds the context back).
    isAtVersionOrLater: ([ctx, version, asVersion], call) => {
      const current = asVersion ?? context(call, ctx).activeVersion;
      if (
        !(current instanceof FsTagged) ||
        !(version instanceof FsTagged) ||
        current.tag !== version.tag
      )
        return call.fail("isAtVersionOrLater needs FeatureScriptVersionNumber values.");
      return (
        (current.tag.ordinals.get(current.value as string) ?? -1) >=
        (version.tag.ordinals.get(version.value as string) ?? Number.POSITIVE_INFINITY)
      );
    },
    getCurrentVersion: ([ctx], call) => untag(context(call, ctx).activeVersion),
    getLastActiveId: ([ctx], call) => untag(context(call, ctx).lastActiveId),
    // The real id of the last operation (recorded around every op* builtin in createBuiltins).
    lastOperationId: ([ctx], call) =>
      context(call, ctx).lastOperation ??
      call.unsupported("lastOperationId: no operation has run in this context yet."),
    /** The id of the last operation that created or changed the first entity of `entity`. */
    lastModifyingOperationId: ([ctx, args], call) => {
      const { model, oc } = kernel(call, ctx);
      const entity = resolve(call, model, oc, map(call, args, "definition").getField("entity"))[0];
      if (!entity) return call.fail("lastModifyingOperationId: entity resolves to nothing.");
      return model.lastModifyingOperation(entity.id, entity.createdBy);
    },
    valuesSortedById: ([ctx, idToValue], call) => {
      const c = context(call, ctx);
      return map(call, idToValue, "idToValue")
        .entries()
        .map(([id, value]) => ({
          order:
            c.startOrder(id) ??
            call.unsupported(`valuesSortedById: ${formatValue(id)} never started in this context.`),
          value,
        }))
        .sort((a, b) => a.order - b.order)
        .map(({ value }) => value);
    },
    /** True when a key is the id of a sketch (the id passed to `newSketch`), not just a feature with one. */
    containsSketch: ([ctx, idToValue], call) => {
      const model = context(call, ctx);
      const sketches = [...model.geometry.entities.values()].flatMap((entity) =>
        entity.sketch ? [entity.sketch.sketchId] : [],
      );
      return map(call, idToValue, "idToValue")
        .entries()
        .some(([key]) => {
          if (!Array.isArray(untag(key)))
            return call.fail("containsSketch needs a map keyed by Id.");
          const id = idOf(key);
          return sketches.some(
            (sketchId) => sketchId.length === id.length && startsWith(sketchId, id),
          );
        });
    },
    // Std: "Only accessible during tables, editing logic and manipulator change function"; std's
    // callers catch the error and fall back.
    getFeatureName: (_args, call) =>
      call.fail(
        "getFeatureName can't be called inside a feature. Onshape allows it only in table functions, editing logic and manipulator change functions.",
      ),
    /** The `FeatureScript <version>;` of the module making the call, as std documents. */
    getLanguageVersion: (_args, call) =>
      call.module.ast.version ?? call.fail("The calling module has no FeatureScript version."),
    // Order disambiguation names entities across regenerations; a local run has only one.
    skipOrderDisambiguation: noop,
    // Converting to the current version (no version) changes nothing.
    convert: ([value, version], call) =>
      version === undefined
        ? value
        : call.unsupported("@convert to a FeatureScript version is not supported locally yet."),
    clampContextVersion: ([ctx, args], call) => {
      const loaded = context(call, map(call, args, "definition").getField("loadedContext"));
      if (!equals(loaded.version, context(call, ctx).version))
        return call.unsupported(
          "Clamping a context made at another FeatureScript version is not supported locally yet.",
        );
      return undefined;
    },
    isInFeaturePattern: () => false,
    isInSheetMetalFeature: () => false,
    // Parameter tolerances only exist in Onshape's feature dialog; locally no parameter is tolerant.
    getTolerantParameterIds: () => FsMap.empty,
    getParameterToleranceInfo: (_args, call) =>
      stdTagged(call, "toleranceTypes.fs", "ToleranceInfo", [
        ["toleranceType", stdEnum(call, "toleranceTypes.fs", "ToleranceType", "NONE")],
        ["usePrecisionOverride", false],
      ]),
    // Outside a feature pattern, both pattern transforms are the identity.
    getFullPatternTransform: () => IDENTITY_TRANSFORM,
    getRemainderPatternTransform: () => IDENTITY_TRANSFORM,

    print: ([text], call) => {
      call.interpreter.console.push(string(call, text, "value"));
      return undefined;
    },
    report: ([text], call) => {
      call.interpreter.console.push(String(untag(text)));
      return undefined;
    },
  }) satisfies Partial<Record<StdBuiltinName, BuiltinImpl>>;
