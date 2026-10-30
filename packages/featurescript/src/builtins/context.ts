import type { BuiltinImpl } from "../runtime/Interpreter.ts";
import { ModelContext } from "../runtime/ModelContext.ts";
import { FsBuiltin, FsMap, FsTagged, untag, type FsValue } from "../runtime/Value.ts";
import { context, map, string } from "./args.ts";
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

export const CONTEXT_BUILTINS = {
  ...(Object.fromEntries(UI_ONLY.map((name) => [name, noop])) as Record<
    (typeof UI_ONLY)[number],
    BuiltinImpl
  >),

  newContext: ([version]) => new FsBuiltin(new ModelContext(version)),
  isContext: ([value]) => value instanceof FsBuiltin && value.native instanceof ModelContext,
  // Sketches arrive with the geometry kernel; until then nothing is a sketch.
  isSketch: () => false,

  startFeature: ([ctx, id], call) => FsMap.fromEntries([["token", context(call, ctx).start(id)]]),
  endFeature: ([ctx, id, token], call) => {
    context(call, ctx).end(tokenOf(token), id);
    return undefined;
  },
  abortFeature: ([ctx, id, token], call) => {
    context(call, ctx).abort(tokenOf(token), id);
    return undefined;
  },

  getVariable: ([ctx, args], call) => {
    const name = string(call, map(call, args, "definition").getField("name"), "name");
    const c = context(call, ctx);
    if (!c.hasVariable(name)) call.fail(`Variable "${name}" not found.`);
    return c.getVariable(name);
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

  isAtVersionOrLater: ([ctx, version], call) => {
    const current = context(call, ctx).version;
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
  getCurrentVersion: ([ctx], call) => untag(context(call, ctx).version),
  getLastActiveId: ([ctx], call) => untag(context(call, ctx).lastActiveId),
  isInFeaturePattern: () => false,
  isInSheetMetalFeature: () => false,
  getFullPatternTransform: () =>
    FsMap.fromEntries([
      [
        "linear",
        [
          [1, 0, 0],
          [0, 1, 0],
          [0, 0, 1],
        ],
      ],
      ["translation", [0, 0, 0]],
    ]),

  print: ([text], call) => {
    call.interpreter.console.push(string(call, text, "value"));
    return undefined;
  },
  report: ([text], call) => {
    call.interpreter.console.push(String(untag(text)));
    return undefined;
  },
} satisfies Partial<Record<StdBuiltinName, BuiltinImpl>>;
