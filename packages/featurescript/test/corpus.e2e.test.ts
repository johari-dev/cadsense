// @effect-diagnostics nodeBuiltinImport:off - reads corpus cases and writes artifacts to disk.
import * as NodeFS from "node:fs";
import * as NodeURL from "node:url";
import { beforeAll, describe, expect, it } from "vite-plus/test";
import { runPreview, writePreview } from "../src/preview/Preview.ts";
import { FeatureScriptRuntime } from "../src/Runtime.ts";

/**
 * The gate for local geometry: each `corpus/<case>/case.json` runs its features in one context and
 * checks statuses, volumes, Onshape-style topology counts and variables. Every run writes the same
 * artifacts the preview CLI does to `.cadsense/fs-corpus/<case>/`: a PNG per view (faces the last
 * feature created in amber), `result.glb` and `report.json`.
 */
interface CorpusCase {
  readonly description: string;
  readonly steps: readonly {
    readonly file: string;
    readonly feature: string;
    readonly parameters?: Readonly<Record<string, string>>;
  }[];
  readonly expect: {
    /** Where the expected values come from, e.g. a hand calculation or an Onshape recording. */
    readonly source: string;
    readonly statuses: readonly string[];
    readonly solids: readonly {
      readonly volumeMm3: number;
      readonly faces: number;
      readonly edges: number;
      readonly vertices: number;
    }[];
    /** Context variables the last feature set, as numbers (cases divide std's SI results by units). */
    readonly variables?: Readonly<Record<string, number>>;
  };
}

const CORPUS = new URL("../corpus/", import.meta.url);
const ARTIFACTS = new URL("../../../.cadsense/fs-corpus/", import.meta.url);
const cases = NodeFS.readdirSync(CORPUS).filter((name) =>
  NodeFS.existsSync(new URL(`${name}/case.json`, CORPUS)),
);

let runtime: FeatureScriptRuntime;
beforeAll(async () => {
  runtime = await FeatureScriptRuntime.withGeometry();
});

describe("corpus", () => {
  it.each(cases)("%s", (name) => {
    const dir = new URL(`${name}/`, CORPUS);
    const spec = JSON.parse(NodeFS.readFileSync(new URL("case.json", dir), "utf8")) as CorpusCase;
    const result = runPreview(
      runtime,
      spec.steps.map((step) => ({
        path: `corpus/${name}/${step.file}`,
        source: NodeFS.readFileSync(new URL(step.file, dir), "utf8"),
        feature: step.feature,
        ...(step.parameters ? { parameters: step.parameters } : {}),
      })),
    );
    writePreview(result, NodeURL.fileURLToPath(new URL(`${name}/`, ARTIFACTS)), {
      case: name,
      description: spec.description,
      expected: spec.expect,
    });

    const runs = result.features.map((feature) => feature.run);
    expect(runs.map((run) => run?.fault?.message ?? null)).toEqual(spec.steps.map(() => null));
    expect(runs.map((run) => run?.status)).toEqual(spec.expect.statuses);
    const variables = runs.at(-1)?.variables;
    for (const [variable, wanted] of Object.entries(spec.expect.variables ?? {})) {
      const actual = variables?.getField(variable);
      expect(typeof actual, variable).toBe("number");
      expect(Math.abs((actual as number) - wanted), variable).toBeLessThan(
        1e-6 * Math.max(1, Math.abs(wanted)),
      );
    }
    expect(result.solids.length).toBe(spec.expect.solids.length);
    spec.expect.solids.forEach((wanted, i) => {
      const actual = result.solids[i]!;
      expect(Math.abs(actual.volumeMm3 - wanted.volumeMm3) / wanted.volumeMm3).toBeLessThan(1e-4);
      expect({ faces: actual.faces, edges: actual.edges, vertices: actual.vertices }).toEqual({
        faces: wanted.faces,
        edges: wanted.edges,
        vertices: wanted.vertices,
      });
    });
  });
});
