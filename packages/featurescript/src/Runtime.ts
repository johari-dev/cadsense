// @effect-diagnostics nodeBuiltinImport:off - the runtime reads vendored std files from disk.
import * as NodeFS from "node:fs";
import { BUILTINS } from "./builtins/index.ts";
import { FsFault, FsThrow, type FsFrame } from "./runtime/Errors.ts";
import { Interpreter } from "./runtime/Interpreter.ts";
import { ModelContext } from "./runtime/ModelContext.ts";
import { ModuleLoader, STD_PREFIX, type ModuleInstance } from "./runtime/Modules.ts";
import { formatValue, FsBuiltin, FsMap, untag, type FsValue } from "./runtime/Value.ts";

const STD_DIR = new URL("../std/", import.meta.url);

/** Reads `onshape/std/*.fs` from the vendored std. */
export const readStd = (path: string): string | undefined => {
  if (!path.startsWith(STD_PREFIX)) return undefined;
  const name = path.slice(STD_PREFIX.length);
  if (!/^[A-Za-z0-9_.]+\.fs$/.test(name)) return undefined;
  try {
    return NodeFS.readFileSync(new URL(name, STD_DIR), "utf8");
  } catch {
    return undefined;
  }
};

export interface RuntimeOptions {
  /** Sources for non-std modules, by import path. */
  readonly readModule?: (path: string) => string | undefined;
  readonly maxSteps?: number;
}

export type FeatureStatusType = "OK" | "INFO" | "WARNING" | "ERROR";

/** The result of running one feature in a fresh context. */
export interface FeatureRun {
  readonly status: FeatureStatusType;
  /** The `ErrorStringEnum` member reported, e.g. `REGEN_ERROR` or `CUSTOM_ERROR`. */
  readonly statusEnum: string | null;
  /** The custom message from `regenError("...")`, if any. */
  readonly message: string | null;
  /** Context variables after the run. A failed feature's are rolled back. */
  readonly variables: FsMap;
  readonly console: readonly string[];
  /** Set when the run stopped for a reason FeatureScript can't catch, e.g. an unsupported builtin. */
  readonly fault: {
    readonly reason: FsFault["reason"];
    readonly message: string;
    readonly stack: readonly FsFrame[];
  } | null;
}

/**
 * Loads modules and runs FeatureScript against the vendored std. One runtime keeps std's evaluated
 * constants between runs; each feature run gets a new context.
 */
export class FeatureScriptRuntime {
  readonly loader: ModuleLoader;
  readonly interpreter: Interpreter;

  constructor(options: RuntimeOptions = {}) {
    const readModule = options.readModule;
    this.loader = new ModuleLoader((path) => readStd(path) ?? readModule?.(path));
    this.interpreter = new Interpreter(
      this.loader,
      BUILTINS,
      options.maxSteps === undefined ? {} : { maxSteps: options.maxSteps },
    );
  }

  load(path: string, source?: string): ModuleInstance {
    return this.loader.load(path, source);
  }

  /** Calls a top-level std function by module and name, e.g. `("context.fs", "newContext")`. */
  callStd(file: string, name: string, args: readonly FsValue[] = []): FsValue {
    const module = this.loader.load(`${STD_PREFIX}${file}`);
    return this.interpreter.callFunction(this.interpreter.topLevelValue(module, name), args);
  }

  /**
   * Runs `featureName` (a `defineFeature` constant in `module`) as feature `Feature1` of a new context.
   * Errors the feature raises become its status, as in Onshape.
   */
  runFeature(
    module: ModuleInstance,
    featureName: string,
    definition: FsMap = FsMap.empty,
  ): FeatureRun {
    const consoleStart = this.interpreter.console.length;
    const context = this.callStd("context.fs", "newContext");
    const id = this.callStd("context.fs", "makeId", ["Feature1"]);
    const model = (untag(context) as FsBuiltin<ModelContext>).native;
    let fault: FeatureRun["fault"] = null;
    try {
      const feature = this.interpreter.topLevelValue(module, featureName);
      this.interpreter.callFunction(feature, [context, id, definition]);
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
    return {
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
    };
  }
}
