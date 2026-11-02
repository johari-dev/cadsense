// @effect-diagnostics nodeBuiltinImport:off - reads the vendored std's ErrorStringEnum.
import * as NodeFS from "node:fs";
import { STD_DIR } from "../src/Runtime.ts";
import {
  caseHash,
  DEFAULT_TOLERANCE,
  type Area,
  type ConformanceCase,
  type Recording,
  type SpecInput,
  type StaleRecording,
  type Tolerance,
} from "./Case.ts";
import type { LocalFault, LocalRun } from "./Local.ts";
import { isPlainMap, type Plain, type PlainMap } from "./Plain.ts";

/** One difference between Onshape and the local runtime, at a path into the probe's result. */
export interface Mismatch {
  /** E.g. `bodies[0].volume`, `values.blockTopOrigin[2]`, `features[1].status`, `compiled(x.fs)`. */
  readonly path: string;
  readonly area: Area;
  readonly onshape: Plain;
  readonly local: Plain;
}

export type CaseOutcome =
  | { readonly kind: "not recorded" }
  | { readonly kind: "stale"; readonly recordedAt: string }
  /** A feature stopped the local run (an unsupported builtin), so there's nothing to compare. */
  | { readonly kind: "unsupported"; readonly reason: string }
  | {
      readonly kind: "compared";
      readonly mismatches: readonly Mismatch[];
      /** Probe parts the local runtime couldn't run (`model` or a value), with why. */
      readonly unsupportedValues: Readonly<Record<string, string>>;
    };

/** Stands in for a value one side doesn't have. */
const MISSING = "<missing>";
/** A local fault as a mismatch's local value, e.g. `unresolved-name: missingFunction not found.` */
const faultText = (fault: LocalFault) => `${fault.reason}: ${fault.message}`;

const EXACT: Tolerance = { relative: 0, absolute: 0 };
/** Bodies: box corners within 1e-6 m, volume, area and length within 1e-6 relative, counts exact. */
const BODY_TOLERANCES: Readonly<Record<string, Tolerance>> = {
  box: { relative: 0, absolute: 1e-6 },
  volume: { relative: 1e-6, absolute: 1e-18 },
  area: { relative: 1e-6, absolute: 1e-15 },
  length: { relative: 1e-6, absolute: 1e-12 },
};

/** A probe value that threw: `{ "error" : ... }`. */
const isError = (value: Plain | undefined): value is PlainMap =>
  isPlainMap(value) && Object.keys(value).length === 1 && "error" in value;

/** The members of std's `ErrorStringEnum`, read from the vendored std. */
const ERROR_STRING_ENUM: ReadonlySet<string> = (() => {
  const source = NodeFS.readFileSync(new URL("errorstringenum.gen.fs", STD_DIR), "utf8");
  const body = /export enum ErrorStringEnum\s*\{([\s\S]*?)\n\}/.exec(source)?.[1];
  if (!body) throw new Error("std's errorstringenum.gen.fs has no ErrorStringEnum.");
  return new Set([...body.matchAll(/^\s*([A-Z][A-Z0-9_]*),?\s*$/gm)].map((match) => match[1]!));
})();

/**
 * What identifies an error, so two errors match when it does. A `regenError` is a map whose
 * `message` is its `ErrorStringEnum`, plus the script's own `customMessage` for `CUSTOM_ERROR` (or a
 * string's text after the enum); a
 * local builtin failure is a string led by the enum (`"CANNOT_RESOLVE_PLANE: no face to
 * evaluate."`). Only for real members of std's `ErrorStringEnum` may the rest of the wording
 * differ. Any other error (a language error, a thrown string, an uppercase word that isn't a
 * member) is identified by its whole text, with runs of whitespace as one space and the ends
 * trimmed: a map's `message`, else the string itself, else its JSON.
 */
function errorIdentity(error: Plain | undefined): string {
  const enumOf = (text: string) => {
    const code = /^([A-Z][A-Z0-9_]*)(?::|$)/.exec(text)?.[1];
    return code && ERROR_STRING_ENUM.has(code) ? code : null;
  };
  const message = isPlainMap(error) && typeof error.message === "string" ? error.message : error;
  const code = typeof message === "string" ? enumOf(message) : null;
  // A custom error's message comes from the script, so it identifies the failure: a map's
  // customMessage, or the rest of a string led by the enum.
  if (code === "CUSTOM_ERROR")
    return `${code}: ${
      isPlainMap(error)
        ? String(error.customMessage)
        : String(message)
            .replace(/^CUSTOM_ERROR:?/, "")
            .replace(/\s+/g, " ")
            .trim()
    }`;
  if (code) return code;
  const text = typeof message === "string" ? message : JSON.stringify(message ?? null);
  return `text: ${text.replace(/\s+/g, " ").trim()}`;
}

/**
 * Reports every place `onshape` and `local` differ beyond `tolerance`. Arrays of different lengths
 * are one difference, at the array.
 */
function compareValues(
  onshape: Plain | undefined,
  local: Plain | undefined,
  path: string,
  tolerance: Tolerance,
  report: (path: string, onshape: Plain, local: Plain) => void,
): void {
  if (onshape === undefined && local === undefined) return;
  if (onshape === undefined || local === undefined)
    return report(path, onshape ?? MISSING, local ?? MISSING);
  if (isError(onshape) || isError(local)) {
    if (
      !isError(onshape) ||
      !isError(local) ||
      errorIdentity(onshape.error) !== errorIdentity(local.error)
    )
      report(path, onshape, local);
    return;
  }
  if (typeof onshape === "number" && typeof local === "number") {
    const allowed = Math.max(
      tolerance.absolute,
      tolerance.relative * Math.max(Math.abs(onshape), Math.abs(local)),
    );
    if (Math.abs(onshape - local) > allowed) report(path, onshape, local);
    return;
  }
  if (Array.isArray(onshape) && Array.isArray(local)) {
    if (onshape.length !== local.length) return report(path, onshape, local);
    onshape.forEach((item, i) => compareValues(item, local[i], `${path}[${i}]`, tolerance, report));
    return;
  }
  if (isPlainMap(onshape) && isPlainMap(local)) {
    for (const key of [...new Set([...Object.keys(onshape), ...Object.keys(local)])].sort())
      compareValues(onshape[key], local[key], `${path}.${key}`, tolerance, report);
    return;
  }
  if (onshape !== local) report(path, onshape, local);
}

const flags = (body: PlainMap) => JSON.stringify([body.types, body.sketch, body.construction]);
const measure = (body: PlainMap) => {
  const value = body.volume ?? body.area ?? body.length;
  return typeof value === "number" ? value : null;
};
/** How far apart two bodies are: their box corners' total distance, then their measures. */
function distance(a: PlainMap, b: PlainMap): number {
  const boxA = Array.isArray(a.box) ? a.box : [];
  const boxB = Array.isArray(b.box) ? b.box : [];
  let total = boxA.length === 6 && boxB.length === 6 ? 0 : 1;
  for (let i = 0; i < 6; i++) {
    const p = boxA[i];
    const q = boxB[i];
    if (typeof p === "number" && typeof q === "number") total += Math.abs(p - q);
  }
  const m = measure(a);
  const n = measure(b);
  if (m !== null && n !== null)
    total += (1e-3 * Math.abs(m - n)) / Math.max(Math.abs(m), Math.abs(n), 1e-30);
  return total;
}

/**
 * Pairs Onshape's bodies with the local ones. Query order is itself unconfirmed, so bodies pair by
 * kind (types, sketch, construction) and then by nearest box, and bodies tied on box and measure by
 * fewest differing fields, so the order either side lists them in doesn't matter; bodies of
 * different kinds pair only if their boxes nearly coincide (within 0.1 mm in total). Returns pairs
 * of indices, and the indices left over on each side.
 */
function pairBodies(onshape: readonly PlainMap[], local: readonly PlainMap[]) {
  const pairs: [number, number][] = [];
  const usedOnshape = new Set<number>();
  const usedLocal = new Set<number>();
  for (const sameKind of [true, false]) {
    const candidates: [number, number, number, number][] = [];
    onshape.forEach((a, i) =>
      local.forEach((b, j) => {
        if (usedOnshape.has(i) || usedLocal.has(j) || (flags(a) === flags(b)) !== sameKind) return;
        const d = distance(a, b);
        if (sameKind || d < 1e-4) candidates.push([d, differences(a, b), i, j]);
      }),
    );
    for (const [, , i, j] of candidates.sort((x, y) => x[0] - y[0] || x[1] - y[1])) {
      if (usedOnshape.has(i) || usedLocal.has(j)) continue;
      usedOnshape.add(i);
      usedLocal.add(j);
      pairs.push([i, j]);
    }
  }
  return {
    pairs: pairs.sort((x, y) => x[0] - y[0]),
    onshapeOnly: onshape.map((_, i) => i).filter((i) => !usedOnshape.has(i)),
    localOnly: local.map((_, j) => j).filter((j) => !usedLocal.has(j)),
  };
}

/** How many of two bodies' fields differ beyond their tolerances. */
function differences(a: PlainMap, b: PlainMap): number {
  let count = 0;
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)]))
    compareValues(a[key], b[key], key, BODY_TOLERANCES[key] ?? EXACT, () => count++);
  return count;
}

/** Dialog inputs reduced to their ids and item ids, the part both specs agree on how to say. */
const inputIds = (inputs: readonly SpecInput[]): PlainMap[] =>
  inputs.map((input) =>
    input.items ? { id: input.id, items: inputIds(input.items) } : { id: input.id },
  );

/**
 * Compares a case as Onshape recorded it with the local run. Stale and missing recordings aren't
 * compared, and a case a feature of which stops the local run is unsupported. Otherwise every
 * difference is a mismatch: compile results, feature statuses, each body, each variable and value.
 */
export function compareCase(
  conformanceCase: ConformanceCase,
  recording: Recording | StaleRecording | null,
  local: LocalRun,
): CaseOutcome {
  if (!recording) return { kind: "not recorded" };
  if ("kind" in recording || recording.hash !== caseHash(conformanceCase))
    return { kind: "stale", recordedAt: recording.recordedAt };

  const mismatches: Mismatch[] = [];
  const areaOf = (name: string) => conformanceCase.areas?.[name] ?? conformanceCase.area;
  const reporter =
    (area: Area) =>
    (path: string, onshape: Plain, localValue: Plain): void => {
      mismatches.push({ path, area, onshape, local: localValue });
    };

  for (const source of recording.sources) {
    const compiledLocally = local.compiled[source.file] === true;
    if (source.compiled !== compiledLocally)
      reporter("language")(`compiled(${source.file})`, source.compiled, compiledLocally);
  }
  const compiled = (files: readonly boolean[]) => files.every(Boolean);
  if (
    !compiled(recording.sources.map((source) => source.compiled)) ||
    !compiled(Object.values(local.compiled).map((result) => result === true))
  )
    return { kind: "compared", mismatches, unsupportedValues: {} };
  if (local.unsupported) return { kind: "unsupported", reason: local.unsupported };

  // The dialog: Onshape's spec and the local one list the same inputs, in the same order.
  for (const source of recording.sources)
    for (const [feature, spec] of Object.entries(source.specs)) {
      const localInputs = local.inputs[feature];
      if (!localInputs) continue;
      const onshapeIds = inputIds(spec.parameters);
      const localIds = inputIds(localInputs);
      if (JSON.stringify(onshapeIds) !== JSON.stringify(localIds))
        reporter("the panel")(`inputs(${feature})`, onshapeIds, localIds);
    }

  // A fault other than an unsupported builtin stops the local run: it's a mismatch at that feature,
  // and the features after it and the probe never ran locally.
  const stopped = local.stopped;
  recording.features.forEach((feature, i) => {
    if (stopped && i >= stopped.feature) return;
    compareValues(
      feature.status,
      local.features[i]?.status,
      `features[${i}].status`,
      EXACT,
      reporter(areaOf("features")),
    );
  });
  if (stopped) {
    reporter(areaOf("features"))(
      `features[${stopped.feature}].fault`,
      recording.features[stopped.feature]?.status ?? MISSING,
      faultText(stopped),
    );
    return { kind: "compared", mismatches, unsupportedValues: {} };
  }

  const unsupportedValues = Object.fromEntries(
    Object.entries(local.probeFaults).flatMap(([name, fault]) =>
      fault.reason === "unsupported-builtin" ? [[name, fault.message]] : [],
    ),
  );
  const onshapeResult = recording.probe?.result;
  if (!onshapeResult || !local.result) {
    reporter(conformanceCase.area)(
      "probe",
      onshapeResult ? "ran" : MISSING,
      local.result ? "ran" : MISSING,
    );
    return { kind: "compared", mismatches, unsupportedValues };
  }

  const modelFault = local.probeFaults.model;
  if (modelFault && modelFault.reason !== "unsupported-builtin")
    reporter(conformanceCase.area)("model", "ran", faultText(modelFault));
  if (!("model" in local.probeFaults)) {
    compareValues(
      onshapeResult.statuses,
      local.result.statuses,
      "statuses",
      EXACT,
      reporter(areaOf("statuses")),
    );

    const onshapeBodies: readonly PlainMap[] = onshapeResult.bodies;
    const localBodies: readonly PlainMap[] = local.result.bodies;
    const bodyArea = (...pair: readonly (PlainMap | undefined)[]) =>
      pair.some((body) => body?.sketch === true) ? "sketches" : areaOf("bodies");
    const { pairs, onshapeOnly, localOnly } = pairBodies(onshapeBodies, localBodies);
    for (const [i, j] of pairs) {
      const a = onshapeBodies[i]!;
      const b = localBodies[j]!;
      for (const key of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort())
        compareValues(
          a[key],
          b[key],
          `bodies[${i}].${key}`,
          BODY_TOLERANCES[key] ?? EXACT,
          reporter(bodyArea(a, b)),
        );
    }
    for (const i of onshapeOnly)
      reporter(bodyArea(onshapeBodies[i]))(`bodies[${i}]`, onshapeBodies[i]!, MISSING);
    for (const j of localOnly)
      reporter(bodyArea(localBodies[j]))(`bodies[local ${j}]`, MISSING, localBodies[j]!);

    const onshapeVariables = onshapeResult.variables;
    const localVariables = local.result.variables;
    for (const name of [
      ...new Set([...Object.keys(onshapeVariables), ...Object.keys(localVariables)]),
    ].sort())
      compareValues(
        onshapeVariables[name],
        localVariables[name],
        `variables.${name}`,
        conformanceCase.tolerances?.[name] ?? DEFAULT_TOLERANCE,
        reporter(areaOf(name)),
      );
  }

  const onshapeValues = onshapeResult.values;
  const localValues = local.result.values;
  for (const name of [
    ...new Set([...Object.keys(onshapeValues), ...Object.keys(localValues)]),
  ].sort()) {
    const fault = local.probeFaults[name];
    if (fault) {
      if (fault.reason !== "unsupported-builtin")
        reporter(areaOf(name))(`values.${name}`, onshapeValues[name] ?? MISSING, faultText(fault));
      continue;
    }
    compareValues(
      onshapeValues[name],
      localValues[name],
      `values.${name}`,
      conformanceCase.tolerances?.[name] ?? DEFAULT_TOLERANCE,
      reporter(areaOf(name)),
    );
  }
  return { kind: "compared", mismatches, unsupportedValues };
}

export interface ReportEntry {
  readonly conformanceCase: ConformanceCase;
  readonly recording: Recording | null;
  readonly local: LocalRun;
  readonly outcome: CaseOutcome;
}

/** A value for a Markdown table cell: its JSON, cut at 300 characters. */
const cell = (value: Plain | string): string => {
  const json = typeof value === "string" ? value : JSON.stringify(value);
  return (json.length > 300 ? `${json.slice(0, 300)}...` : json)
    .replaceAll("|", "\\|")
    .replaceAll("\n", " ");
};
/** A Markdown table with its columns padded, the way the repo's formatter writes them. */
function table(header: readonly string[], rows: readonly (readonly string[])[]): string[] {
  const widths = header.map((title, i) =>
    Math.max(3, title.length, ...rows.map((row) => row[i]!.length)),
  );
  const line = (cells: readonly string[]) =>
    `| ${cells.map((value, i) => value.padEnd(widths[i]!)).join(" | ")} |`;
  return [line(header), line(widths.map((width) => "-".repeat(width))), ...rows.map(line)];
}

/** What a local run did, in a few words. */
const localOutcome = (local: LocalRun): string => {
  const broken = Object.entries(local.compiled).find(([, result]) => result !== true);
  if (broken) return `doesn't compile: ${String(broken[1])}`;
  if (local.unsupported) return `stops: ${local.unsupported}`;
  if (local.stopped)
    return `fails at feature ${local.stopped.feature}: ${faultText(local.stopped)}`;
  const faults = Object.entries(local.probeFaults).map(([name, fault]) =>
    fault.reason === "unsupported-builtin" ? name : `${name} (${fault.reason})`,
  );
  return faults.length ? `runs; can't read ${faults.join(", ")}` : "runs";
};

/**
 * `REPORT.md`: every mismatch with both values and its area, every case or value the local runtime
 * can't run, and the cases with no current recording.
 */
export function renderReport(entries: readonly ReportEntry[]): string {
  const of = <K extends CaseOutcome["kind"]>(kind: K) =>
    entries.flatMap((entry) =>
      entry.outcome.kind === kind
        ? [{ ...entry, outcome: entry.outcome as Extract<CaseOutcome, { kind: K }> }]
        : [],
    );
  const compared = of("compared");
  const mismatched = compared.filter((entry) => entry.outcome.mismatches.length > 0);
  // Recorded or not, a case a feature of which stops the local run can't be compared.
  const unsupported = entries.flatMap(({ conformanceCase, local }) =>
    local.unsupported ? [{ conformanceCase, reason: local.unsupported }] : [],
  );
  const versions = [
    ...new Set(
      entries.flatMap((entry) =>
        entry.recording?.onshapeVersion ? [entry.recording.onshapeVersion] : [],
      ),
    ),
  ];
  const lines = [
    "# FeatureScript conformance report",
    "",
    "Generated by `test/conformance.test.ts`; don't edit it. Each case in `cases/` ran in Onshape",
    "(`recordings/`, made by `record.ts`) and in the local runtime (std 3083), and this lists where",
    "they differ. Numbers match within 1e-6 relative (volumes, areas, lengths, values), 1e-6 m",
    "(box corners) or exactly (counts); errors match when both sides throw.",
    "",
    `${entries.length} cases: ${compared.length - mismatched.length} match, ${mismatched.length} differ, ` +
      `${of("not recorded").length} not recorded, ${of("stale").length} stale. ` +
      `${unsupported.length} can't run locally.` +
      (versions.length ? ` Onshape ran them at FeatureScript ${versions.join(", ")}.` : ""),
  ];

  lines.push("", "## Mismatches", "");
  if (mismatched.length === 0) lines.push("None.");
  for (const { conformanceCase, recording, outcome } of mismatched) {
    lines.push(
      `### ${conformanceCase.name}`,
      "",
      `${conformanceCase.description} Covers ${conformanceCase.covers}. Recorded ${recording?.recordedAt.slice(0, 10) ?? "?"}` +
        (recording?.partStudio ? ` ([Part Studio](${recording.partStudio}))` : "") +
        ".",
      "",
      ...table(
        ["Where", "Onshape", "Local", "Area"],
        outcome.mismatches.map((mismatch) => [
          `\`${cell(mismatch.path)}\``,
          cell(mismatch.onshape),
          cell(mismatch.local),
          mismatch.area,
        ]),
      ),
      "",
    );
  }

  // Each case above ends with a blank line; the next heading brings its own.
  if (lines.at(-1) === "") lines.pop();
  lines.push("", "## Cases the local runtime can't run", "");
  if (unsupported.length === 0) lines.push("None.");
  else
    lines.push(
      ...table(
        ["Case", "Covers", "Stops at"],
        unsupported.map(({ conformanceCase, reason }) => [
          conformanceCase.name,
          cell(conformanceCase.covers),
          cell(reason),
        ]),
      ),
    );

  const values = entries.flatMap(({ conformanceCase, local }) =>
    Object.entries(local.probeFaults).flatMap(([name, fault]) =>
      fault.reason === "unsupported-builtin"
        ? [{ conformanceCase, name, reason: fault.message }]
        : [],
    ),
  );
  if (values.length > 0)
    lines.push(
      "",
      "## Probe values the local runtime can't read",
      "",
      ...table(
        ["Case", "Value", "Stops at"],
        values.map(({ conformanceCase, name, reason }) => [
          conformanceCase.name,
          name,
          cell(reason),
        ]),
      ),
    );

  const unrecorded = [...of("not recorded"), ...of("stale")];
  lines.push("", "## Not recorded", "");
  if (unrecorded.length === 0) lines.push("None.");
  else
    lines.push(
      "Run `record.ts` for these (see its header). Stale ones changed after they were recorded.",
      "",
      ...table(
        ["Case", "Covers", "Recording", "Local run"],
        unrecorded.map(({ conformanceCase, outcome, local }) => [
          conformanceCase.name,
          cell(conformanceCase.covers),
          outcome.kind === "stale" ? `stale (${outcome.recordedAt.slice(0, 10)})` : "none",
          cell(localOutcome(local)),
        ]),
      ),
    );

  const matching = compared.filter((entry) => entry.outcome.mismatches.length === 0);
  lines.push(
    "",
    "## Matching",
    "",
    matching.length
      ? matching.map(({ conformanceCase }) => conformanceCase.name).join(", ")
      : "None.",
    "",
  );
  return lines.join("\n");
}
