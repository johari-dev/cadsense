// @effect-diagnostics nodeBuiltinImport:off - reads corpus cases and writes artifacts to disk.
import * as NodeFS from "node:fs";
import * as NodePerfHooks from "node:perf_hooks";
import { beforeAll, describe, expect, it } from "vite-plus/test";
import { toGlb } from "../src/geometry/Glb.ts";
import { ordered, startsWith } from "../src/geometry/Model.ts";
import { tessellate } from "../src/geometry/Tessellate.ts";
import { FeatureScriptRuntime } from "../src/Runtime.ts";
import { FsMap } from "../src/runtime/Value.ts";
import { defaultDefinition, featureSpecs } from "../src/spec/FeatureSpec.ts";
import { renderPng } from "./render.ts";

/**
 * The gate for local geometry: each `corpus/<case>/case.json` runs its features in one context and
 * checks statuses, volumes and Onshape-style topology counts. Every run writes an artifact to
 * `.cadsense/fs-corpus/<case>/`: `result.png` (faces the last feature created in amber),
 * `result.glb`, and `report.json`.
 */
interface CorpusCase {
  readonly description: string;
  readonly steps: readonly {
    readonly file: string;
    readonly feature: string;
    readonly parameters?: Readonly<Record<string, string>>;
  }[];
  readonly expect: {
    readonly source: string;
    readonly statuses: readonly string[];
    readonly solids: readonly {
      readonly volumeMm3: number;
      readonly faces: number;
      readonly edges: number;
      readonly vertices: number;
    }[];
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
    const steps = spec.steps.map((step) => {
      const module = runtime.load(
        `corpus/${name}/${step.file}`,
        NodeFS.readFileSync(new URL(step.file, dir), "utf8"),
      );
      const featureSpec = featureSpecs(runtime.interpreter, module).find(
        (candidate) => candidate.name === step.feature,
      );
      if (!featureSpec) throw new Error(`${step.file} has no feature ${step.feature}`);
      const parameters = FsMap.fromEntries(
        Object.entries(step.parameters ?? {}).map(
          ([key, source]) => [key, runtime.evaluate(module, source)] as const,
        ),
      );
      return {
        module,
        feature: step.feature,
        definition: defaultDefinition(featureSpec, parameters),
      };
    });

    const started = NodePerfHooks.performance.now();
    const run = runtime.runFeatures(steps);
    const elapsedMs = NodePerfHooks.performance.now() - started;
    const oc = run.oc!;
    const geometry = run.geometry!;
    const solids = ordered(
      geometry,
      (entity) => entity.type === "BODY" && entity.bodyType === "SOLID",
    ).map((body) => {
      const props = new oc.GProp_GProps();
      oc.BRepGProp.VolumeProperties(body.shape, props, false, false, false);
      const count = (type: string) =>
        ordered(geometry, (entity) => entity.body === body.id && entity.type === type).length;
      return {
        id: body.id,
        createdBy: body.createdBy.join("."),
        volumeMm3: props.Mass() * 1e9,
        faces: count("FACE"),
        edges: count("EDGE"),
        vertices: count("VERTEX"),
      };
    });

    const lastFeature = [`Feature${steps.length}`];
    const meshes = tessellate(oc, geometry, {
      highlight: (face) => startsWith(face.createdBy, lastFeature),
    });
    const out = new URL(`${name}/`, ARTIFACTS);
    NodeFS.mkdirSync(out, { recursive: true });
    NodeFS.writeFileSync(new URL("result.glb", out), toGlb(meshes));
    NodeFS.writeFileSync(new URL("result.png", out), renderPng(meshes));
    NodeFS.writeFileSync(
      new URL("report.json", out),
      `${JSON.stringify({ case: name, description: spec.description, elapsedMs: Math.round(elapsedMs), features: run.features.map((feature) => ({ status: feature.status, statusEnum: feature.statusEnum, message: feature.message, fault: feature.fault })), solids, expected: spec.expect }, null, 2)}\n`,
    );

    expect(run.features.map((feature) => feature.fault?.message ?? null)).toEqual(
      spec.steps.map(() => null),
    );
    expect(run.features.map((feature) => feature.status)).toEqual(spec.expect.statuses);
    expect(solids.length).toBe(spec.expect.solids.length);
    spec.expect.solids.forEach((wanted, i) => {
      const actual = solids[i]!;
      expect(Math.abs(actual.volumeMm3 - wanted.volumeMm3) / wanted.volumeMm3).toBeLessThan(1e-4);
      expect({ faces: actual.faces, edges: actual.edges, vertices: actual.vertices }).toEqual({
        faces: wanted.faces,
        edges: wanted.edges,
        vertices: wanted.vertices,
      });
    });
  });
});
