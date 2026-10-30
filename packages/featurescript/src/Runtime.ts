// @effect-diagnostics nodeBuiltinImport:off - the runtime reads vendored std files from disk.
import * as NodeFS from "node:fs";
import { createBuiltins } from "./builtins/index.ts";
import type { GeometryState } from "./geometry/Model.ts";
import { loadOcct, type Oc } from "./geometry/occt.ts";
import { importStep } from "./geometry/Step.ts";
import { FsFault, FsThrow, type FsFrame } from "./runtime/Errors.ts";
import { Interpreter } from "./runtime/Interpreter.ts";
import { ModelContext } from "./runtime/ModelContext.ts";
import { ModuleLoader, STD_PREFIX, type ModuleInstance } from "./runtime/Modules.ts";
import { formatValue, FsBuiltin, FsMap, untag, type FsValue } from "./runtime/Value.ts";
import { formatDiagnostic, locate } from "./syntax/Diagnostic.ts";
import { parseExpression } from "./syntax/Parser.ts";
import { sourceFile } from "./syntax/Source.ts";

/** The vendored std, next to `src/` in the package. Bundled builds copy it and pass `stdDir`. */
export const STD_DIR = new URL("../std/", import.meta.url);

/**
 * Bodies from a base STEP file are created by this pseudo-feature, so `qCreatedBy(makeId("Base"))`
 * finds them. Features run after it as `Feature1`, `Feature2`, ...
 */
export const BASE_FEATURE_ID = ["Base"] as const;

/** Reads `onshape/std/*.fs` from the vendored std in `dir`. */
export const readStd = (path: string, dir: URL = STD_DIR): string | undefined => {
  if (!path.startsWith(STD_PREFIX)) return undefined;
  const name = path.slice(STD_PREFIX.length);
  if (!/^[A-Za-z0-9_.]+\.fs$/.test(name)) return undefined;
  try {
    return NodeFS.readFileSync(new URL(name, dir), "utf8");
  } catch {
    return undefined;
  }
};

export interface RuntimeOptions {
  /** Sources for non-std modules, by import path. */
  readonly readModule?: (path: string) => string | undefined;
  readonly maxSteps?: number;
  /** Where the vendored std lives, as a directory URL ending in `/`. Defaults to {@link STD_DIR}. */
  readonly stdDir?: URL;
  /** The geometry kernel. Without it, geometry builtins stop the run as unsupported. */
  readonly oc?: Oc | null;
}

export type FeatureStatusType = "OK" | "INFO" | "WARNING" | "ERROR";

/** A stop FeatureScript can't catch, such as an unsupported builtin. */
export interface RunFault {
  readonly reason: FsFault["reason"];
  readonly message: string;
  readonly stack: readonly FsFrame[];
}

/** One feature's outcome. */
export interface FeatureRun {
  readonly status: FeatureStatusType;
  /** The `ErrorStringEnum` member reported, e.g. `REGEN_ERROR` or `CUSTOM_ERROR`. */
  readonly statusEnum: string | null;
  /** The custom message from `regenError("...")`, if any. */
  readonly message: string | null;
  /** Context variables after the feature. A failed feature's are rolled back. */
  readonly variables: FsMap;
  readonly console: readonly string[];
  readonly fault: RunFault | null;
  /**
   * Exceptions raised and caught during the feature (std reports these as notices). When a feature
   * fails with a generic `REGEN_ERROR`, the first one is usually the cause.
   */
  readonly exceptions: readonly { readonly message: string; readonly stack: readonly FsFrame[] }[];
}

/** A feature to run: a `defineFeature` constant, its definition, and its feature id. */
export interface FeatureStep {
  readonly module: ModuleInstance;
  readonly feature: string;
  readonly definition?: FsMap;
}

/** Several features run in order in one context, like a Part Studio's feature list. */
export interface PartStudioRun {
  readonly features: readonly FeatureRun[];
  /** The context's geometry after the last feature; null without a kernel. */
  readonly geometry: GeometryState | null;
  readonly oc: Oc | null;
}

/**
 * Loads modules and runs FeatureScript against the vendored std. One runtime keeps std's evaluated
 * constants between runs; each run gets a new context.
 */
export class FeatureScriptRuntime {
  readonly loader: ModuleLoader;
  readonly interpreter: Interpreter;

  constructor(options: RuntimeOptions = {}) {
    const { readModule, stdDir } = options;
    this.loader = new ModuleLoader((path) => readStd(path, stdDir) ?? readModule?.(path));
    this.interpreter = new Interpreter(
      this.loader,
      createBuiltins(options.oc ?? null),
      options.maxSteps === undefined ? {} : { maxSteps: options.maxSteps },
    );
  }

  /** A runtime with the OpenCascade geometry kernel loaded. */
  static async withGeometry(
    options: Omit<RuntimeOptions, "oc"> = {},
  ): Promise<FeatureScriptRuntime> {
    return new FeatureScriptRuntime({ ...options, oc: await loadOcct() });
  }

  load(path: string, source?: string): ModuleInstance {
    return this.loader.load(path, source);
  }

  /** Calls a top-level std function by file and name, e.g. `("context.fs", "newContext")`. */
  callStd(file: string, name: string, args: readonly FsValue[] = []): FsValue {
    const module = this.loader.load(`${STD_PREFIX}${file}`);
    return this.interpreter.callFunction(this.interpreter.topLevelValue(module, name), args);
  }

  /**
   * Evaluates a FeatureScript expression in `module`'s scope, e.g. a parameter value such as
   * `qContainsPoint(qCreatedBy(makeId("Feature1"), EntityType.FACE), vector(0, 0, 10) * millimeter)`.
   */
  evaluate(module: ModuleInstance, source: string): FsValue {
    const file = sourceFile(`${module.path} (expression)`, source);
    const { expression, diagnostics } = parseExpression(file);
    if (!expression || diagnostics.length)
      throw new Error(diagnostics.map((d) => formatDiagnostic(locate(file, d))).join("\n"));
    return this.interpreter.evaluate(expression, module);
  }

  /** Runs one feature as `Feature1` of a new context. */
  runFeature(module: ModuleInstance, feature: string, definition: FsMap = FsMap.empty): FeatureRun {
    return this.runFeatures([{ module, feature, definition }]).features[0]!;
  }

  /**
   * Runs features in order in one new context, as `Feature1`, `Feature2`, ..., on top of the bodies in
   * `base` (a STEP file) if given. Errors a feature raises
   * become its status, as in Onshape. A fault stops the run; later features don't run.
   * Parameters that reference earlier features are queries, which resolve when the feature runs.
   */
  runFeatures(
    steps: readonly FeatureStep[],
    options: { readonly base?: Uint8Array } = {},
  ): PartStudioRun {
    const context = this.callStd("context.fs", "newContext");
    const model = (untag(context) as FsBuiltin<ModelContext>).native;
    if (options.base) {
      if (!model.oc)
        throw new Error(
          "A base model needs the geometry kernel; use FeatureScriptRuntime.withGeometry().",
        );
      model.geometry = importStep(model.oc, model.geometry, options.base, BASE_FEATURE_ID);
    }
    const results: FeatureRun[] = [];
    for (const [index, step] of steps.entries()) {
      const consoleStart = this.interpreter.console.length;
      const noticesStart = this.interpreter.notices.length;
      const id = this.callStd("context.fs", "makeId", [`Feature${index + 1}`]);
      let fault: RunFault | null = null;
      try {
        const feature = this.interpreter.topLevelValue(step.module, step.feature);
        this.interpreter.callFunction(feature, [context, id, step.definition ?? FsMap.empty]);
      } catch (error) {
        if (error instanceof FsFault)
          fault = { reason: error.reason, message: error.message, stack: error.fsStack };
        else if (error instanceof FsThrow)
          fault = {
            reason: "internal",
            message: `Uncaught: ${formatValue(error.value)}`,
            stack: error.stack,
          };
        else throw error;
      }
      const status = model.status(id);
      const statusType = untag(status.getField("statusType"));
      const statusEnum = untag(status.getField("statusEnum"));
      const message = untag(status.getField("statusMsg"));
      results.push({
        status: fault
          ? "ERROR"
          : statusType === "INFO" || statusType === "WARNING" || statusType === "ERROR"
            ? statusType
            : "OK",
        statusEnum: typeof statusEnum === "string" ? statusEnum : null,
        message: typeof message === "string" ? message : null,
        variables: model.variables(),
        console: this.interpreter.console.slice(consoleStart),
        fault,
        exceptions: this.interpreter.notices.slice(noticesStart).map((notice) => ({
          message: typeof notice.value === "string" ? notice.value : formatValue(notice.value),
          stack: notice.stack,
        })),
      });
      if (fault) break;
    }
    return { features: results, geometry: model.oc ? model.geometry : null, oc: model.oc };
  }
}
