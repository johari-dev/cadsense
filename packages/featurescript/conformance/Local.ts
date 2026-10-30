import type { FeatureRun, FeatureScriptRuntime, FeatureStep } from "../src/Runtime.ts";
import type { FaultReason } from "../src/runtime/Errors.ts";
import { ModuleLoadError, type ModuleInstance } from "../src/runtime/Modules.ts";
import { FsMap } from "../src/runtime/Value.ts";
import { defaultDefinition, featureSpecs, type FeatureInput } from "../src/spec/FeatureSpec.ts";
import { formatDiagnostic, locate } from "../src/syntax/Diagnostic.ts";
import {
  localExpression,
  localProbe,
  PROBE_VARIABLE,
  probeModelSchema,
  readSource,
  type ConformanceCase,
  type ProbeModel,
  type ProbeResult,
  type SpecInput,
} from "./Case.ts";
import { fromLocal, isPlainMap, type Plain } from "./Plain.ts";

/** A case as the local runtime ran it, in the same shape as a recording where they overlap. */
export interface LocalRun {
  /** Per source file: true, or why it doesn't load. */
  readonly compiled: Readonly<Record<string, true | string>>;
  readonly features: readonly LocalFeature[];
  /** Why the case can't run locally yet: the unsupported builtin that stopped a feature. */
  readonly unsupported: string | null;
  /**
   * Any other fault that stopped a feature: a name that doesn't resolve, a bug in the runtime, a
   * step limit. Unlike an unsupported builtin, it's a mismatch.
   */
  readonly stopped: (LocalFault & { readonly feature: number }) | null;
  /**
   * The probe's answer, without the parts that stopped the run (see `probeFaults`). If the model
   * part stopped, its statuses, bodies and variables are empty.
   */
  readonly result: ProbeResult | null;
  /** Probe parts that stopped the run (`model`, or a value's name), with the fault. */
  readonly probeFaults: Readonly<Record<string, LocalFault>>;
  /** Each feature's dialog inputs as the local spec reads them: `[{ id, items? }]`, in order. */
  readonly inputs: Readonly<Record<string, readonly SpecInput[]>>;
}

/** Input ids in order, with a list input's item ids under `items`: what `Compare.ts` reduces Onshape's spec to. */
const specInputIds = (inputs: readonly FeatureInput[]): SpecInput[] =>
  inputs.map((input) =>
    input.kind === "array" ? { id: input.id, items: specInputIds(input.items) } : { id: input.id },
  );

/** A fault that stopped the local run, which FeatureScript can't catch. */
export interface LocalFault {
  readonly reason: FaultReason;
  readonly message: string;
}

export interface LocalFeature {
  readonly feature: string;
  readonly status: FeatureRun["status"];
  readonly statusEnum: string | null;
  readonly message: string | null;
}

const casePath = (file: string) => `conformance/cases/${file}`;

/**
 * Runs a case in a fresh context: its features as `Feature1`, `Feature2`, ..., then the probe. A
 * feature that stops on an unsupported builtin makes the case unsupported; any other fault is
 * kept in `stopped`. A probe part that stops is recorded in `probeFaults`, and the rest of the
 * probe runs again without it.
 */
export function runLocal(
  runtime: FeatureScriptRuntime,
  conformanceCase: ConformanceCase,
): LocalRun {
  runtime.loader.unloadUserModules();
  const files = [...new Set(conformanceCase.features.map((feature) => feature.source))];
  const sources = new Map(files.map((file) => [casePath(file), readSource(file)]));
  const featureIds = conformanceCase.features.map((_, i) => `Feature${i + 1}`);
  const probePath = `conformance/probe/${conformanceCase.name}.fs`;
  sources.set(probePath, localProbe(conformanceCase, featureIds));
  runtime.loader.useSources(sources);

  const compiled: Record<string, true | string> = {};
  const modules = new Map<string, ModuleInstance>();
  for (const file of files) {
    try {
      modules.set(file, runtime.load(casePath(file), sources.get(casePath(file))));
      compiled[file] = true;
    } catch (error) {
      if (!(error instanceof ModuleLoadError)) throw error;
      const first = error.diagnostics[0];
      compiled[file] =
        error.file && first ? formatDiagnostic(locate(error.file, first)) : error.message;
    }
  }
  if (modules.size < files.length)
    return {
      compiled,
      features: [],
      unsupported: null,
      stopped: null,
      result: null,
      probeFaults: {},
      inputs: {},
    };

  const inputs: Record<string, readonly SpecInput[]> = {};
  const caseSteps: FeatureStep[] = conformanceCase.features.map((feature) => {
    const module = modules.get(feature.source)!;
    const spec = featureSpecs(runtime.interpreter, module).find(
      (candidate) => candidate.name === feature.feature,
    );
    if (!spec) throw new Error(`${feature.source} has no feature named ${feature.feature}.`);
    inputs[feature.feature] = specInputIds(spec.inputs);
    const parameters = FsMap.fromEntries(
      Object.entries(feature.parameters ?? {}).map(
        ([id, parameter]) =>
          [id, runtime.evaluate(module, localExpression(parameter, featureIds))] as const,
      ),
    );
    return { module, feature: feature.feature, definition: defaultDefinition(spec, parameters) };
  });

  const probe = runtime.load(probePath, sources.get(probePath));
  const valueNames = Object.keys(conformanceCase.values ?? {});
  const probeParts = [
    { name: "model", feature: "readModel" },
    ...valueNames.map((name, i) => ({ name, feature: `readValue${i}` })),
  ];

  let features: readonly LocalFeature[] = [];
  // A model probe that faults leaves an empty reading; `probeFaults.model` says why.
  let model: ProbeModel = { statuses: [], bodies: [], variables: {} };
  const values: Record<string, Plain> = {};
  const probeFaults: Record<string, LocalFault> = {};
  // Each pass runs the case and the probe parts left; a part that faults is skipped next pass.
  let remaining = probeParts;
  while (remaining.length > 0) {
    const run = runtime.runFeatures([
      ...caseSteps,
      ...remaining.map((part) => ({ module: probe, feature: part.feature })),
    ]);
    const caseRuns = run.features.slice(0, caseSteps.length);
    features = caseRuns.map((featureRun, i) => ({
      feature: conformanceCase.features[i]!.feature,
      status: featureRun.status,
      statusEnum: featureRun.statusEnum,
      message: featureRun.message,
    }));
    const faulted = caseRuns.findIndex((featureRun) => featureRun.fault);
    const caseFault = caseRuns[faulted]?.fault;
    if (caseFault) {
      const unsupported = caseFault.reason === "unsupported-builtin";
      return {
        compiled,
        features,
        unsupported: unsupported ? caseFault.message : null,
        stopped: unsupported
          ? null
          : { feature: faulted, reason: caseFault.reason, message: caseFault.message },
        result: null,
        probeFaults,
        inputs,
      };
    }
    const probeRuns = run.features.slice(caseSteps.length);
    for (const [i, probeRun] of probeRuns.entries()) {
      const part = remaining[i]!;
      if (probeRun.fault) {
        probeFaults[part.name] = { reason: probeRun.fault.reason, message: probeRun.fault.message };
        continue;
      }
      const result = fromLocal(probeRun.variables.getField(PROBE_VARIABLE));
      if (!isPlainMap(result))
        throw new Error(
          `The ${part.name} probe for ${conformanceCase.name} stored ${JSON.stringify(result)}.`,
        );
      // Our own probe, so a reading that doesn't match the schema is a harness bug: it throws.
      if (part.name === "model")
        model = probeModelSchema.decode(result, `${conformanceCase.name} local model`);
      else {
        const valueMap = result.values;
        if (isPlainMap(valueMap) && part.name in valueMap)
          values[part.name] = valueMap[part.name] ?? null;
      }
    }
    remaining = remaining.slice(probeRuns.length);
  }
  return {
    compiled,
    features,
    unsupported: null,
    stopped: null,
    result: { ...model, values },
    probeFaults,
    inputs,
  };
}
