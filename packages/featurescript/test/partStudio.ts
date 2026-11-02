import { ordered } from "../src/geometry/Model.ts";
import type { Oc } from "../src/geometry/occt.ts";
import { FeatureScriptRuntime, type PartStudioRun } from "../src/Runtime.ts";
import { STD_PREFIX, type ModuleInstance } from "../src/runtime/Modules.ts";
import { FsMap, untag, type FsValue } from "../src/runtime/Value.ts";
import { defaultDefinition, featureSpecs } from "../src/spec/FeatureSpec.ts";

/**
 * A Part Studio for end-to-end tests: std's own features run top level the way Onshape's feature
 * list runs them (defaults from the precondition, then the given inputs), next to small custom
 * features written inline. Inputs are FeatureScript expressions, as in `corpus/*\/case.json`.
 */
export type Step =
  | {
      /** A std feature, e.g. `{ std: "variable.fs", feature: "assignVariable" }`. */
      readonly std: string;
      readonly feature: string;
      readonly parameters?: Readonly<Record<string, string>>;
    }
  | {
      /** Statements run inside a custom feature's body, with `context`, `id` and `definition`. */
      readonly body: string;
      /** The feature's definition, e.g. `{ asVersion: "FeatureScriptVersionNumber.V681_..." }`. */
      readonly parameters?: Readonly<Record<string, string>>;
    };

export const partStudio = async () => {
  const runtime = await FeatureScriptRuntime.withGeometry();
  let counter = 0;
  /** Expressions see all of std, like a Part Studio's inputs. */
  const scope = runtime.load(
    "test/partStudioScope.fs",
    'FeatureScript 3083;\nimport(path : "onshape/std/geometry.fs", version : "3083.0");\n',
  );
  const custom = (body: string): ModuleInstance =>
    runtime.load(
      `test/partStudio${counter++}.fs`,
      `FeatureScript 3083;
import(path : "onshape/std/geometry.fs", version : "3083.0");
annotation { "Feature Type Name" : "Test" }
export const test = defineFeature(function(context is Context, id is Id, definition is map)
    precondition {}
    {
${body}
    });
`,
    );

  const inputs = (parameters: Readonly<Record<string, string>> = {}) =>
    FsMap.fromEntries(
      Object.entries(parameters).map(
        ([name, source]) => [name, runtime.evaluate(scope, source)] as const,
      ),
    );

  /** Runs the steps as `Feature1`, `Feature2`, ... in one context. */
  const run = (steps: readonly Step[]): PartStudioRun =>
    runtime.runFeatures(
      steps.map((step) => {
        if ("body" in step)
          return {
            module: custom(step.body),
            feature: "test",
            definition: inputs(step.parameters),
          };
        const module = runtime.load(`${STD_PREFIX}${step.std}`);
        const spec = featureSpecs(runtime.interpreter, module).find(
          (candidate) => candidate.name === step.feature,
        );
        if (!spec) throw new Error(`std ${step.std} has no feature ${step.feature}.`);
        return {
          module,
          feature: step.feature,
          definition: defaultDefinition(spec, inputs(step.parameters)),
        };
      }),
    );

  return { runtime, run, evaluate: (source: string) => runtime.evaluate(scope, source) };
};

/** A variable the last feature left, as a plain number (std values divided by their units in FS). */
export const variable = (run: PartStudioRun, name: string, feature = -1): FsValue =>
  run.features.at(feature)!.variables.getField(name);
export const numberVariable = (run: PartStudioRun, name: string, feature = -1): number => {
  const value = untag(variable(run, name, feature));
  if (typeof value !== "number") throw new Error(`Variable ${name} is not a number.`);
  return value;
};

/** Solid volumes in mm³, in creation order. */
export const solidVolumes = (run: PartStudioRun): number[] =>
  ordered(run.geometry!, (entity) => entity.type === "BODY" && entity.bodyType === "SOLID").map(
    (body) => {
      const oc: Oc = run.oc!;
      const props = new oc.GProp_GProps();
      oc.BRepGProp.VolumeProperties(body.shape, props, false, false, false);
      return props.Mass() * 1e9;
    },
  );
