// @effect-diagnostics nodeBuiltinImport:off - reads recordings and writes the report and artifacts.
import * as NodeFS from "node:fs";
import { beforeAll, describe, expect, it } from "vite-plus/test";
import { loadRecording, RECORDINGS_DIR } from "../conformance/Case.ts";
import { CASES } from "../conformance/cases/index.ts";
import { compareCase, renderReport, type ReportEntry } from "../conformance/Compare.ts";
import { runLocal } from "../conformance/Local.ts";
import { FeatureScriptRuntime } from "../src/Runtime.ts";

/**
 * Runs every conformance case locally and compares it with its Onshape recording, offline. The
 * suite stays green whatever the comparison finds: `conformance/REPORT.md` lists every mismatch
 * (with both values and the area that owns it), every case or value the local runtime can't run,
 * and every case without a current recording. `test/conformance.compare.test.ts` tests the
 * comparison itself.
 *
 * What the harness could get wrong, and what guards it:
 * 1. A recording is never compared because its case was renamed or removed: every recording must
 *    name a case.
 * 2. One case throwing (a bug in the runner, not a FeatureScript fault) hides the rest: it fails
 *    the suite, naming the case.
 * 3. The report goes stale: it's rewritten on every run, and must name every case.
 * 4. It needs the network: it only reads `recordings/`.
 *
 * Each run also writes each case's local result to `.cadsense/fs-conformance/<case>.json`, next to
 * nothing else, so a mismatch can be inspected in full.
 */
const REPORT = new URL("../conformance/REPORT.md", import.meta.url);
const ARTIFACTS = new URL("../../../.cadsense/fs-conformance/", import.meta.url);

let runtime: FeatureScriptRuntime;
beforeAll(async () => {
  runtime = await FeatureScriptRuntime.withGeometry();
});

describe("conformance", () => {
  it("every recording belongs to a case", () => {
    const names = new Set(CASES.map((conformanceCase) => conformanceCase.name));
    const recordings = NodeFS.existsSync(RECORDINGS_DIR)
      ? NodeFS.readdirSync(RECORDINGS_DIR).filter(
          (file) => file.endsWith(".json") && file !== "onshape.json" && file !== "failures.json",
        )
      : [];
    expect(recordings.filter((file) => !names.has(file.slice(0, -".json".length)))).toEqual([]);
  });

  it("compares every case with its recording and writes REPORT.md", () => {
    NodeFS.mkdirSync(ARTIFACTS, { recursive: true });
    const entries: ReportEntry[] = CASES.map((conformanceCase) => {
      const stored = loadRecording(conformanceCase);
      const recording = stored?.kind === "current" ? stored.recording : null;
      let local;
      try {
        local = runLocal(runtime, conformanceCase);
      } catch (error) {
        throw new Error(`${conformanceCase.name} broke the harness`, { cause: error });
      }
      NodeFS.writeFileSync(
        new URL(`${conformanceCase.name}.json`, ARTIFACTS),
        `${JSON.stringify(local, null, 2)}\n`,
      );
      return {
        conformanceCase,
        recording,
        local,
        outcome: compareCase(conformanceCase, stored?.kind === "stale" ? stored : recording, local),
      };
    });
    const report = renderReport(entries);
    NodeFS.writeFileSync(REPORT, report);
    for (const conformanceCase of CASES) expect(report).toContain(conformanceCase.name);
  });
});
