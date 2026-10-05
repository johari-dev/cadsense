// @effect-diagnostics nodeBuiltinImport:off globalConsole:off preferSchemaOverJson:off
// Prints the drivetrain findings cad_checks reports for a stored snapshot, including spinning-part
// collisions, and where each check-placed marker would go. Either a directory holding manifest.json
// and assets/, or a CAD data directory (userdata/cad) plus a snapshot ID:
//   node apps/server/scripts/cad-drivetrain-probe.ts <dir> [snapshot-id] [--parts]
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import {
  loadCadSolidKernel,
  partOccurrences,
  readCadGeometryBounds,
  readCadTriangleMesh,
  runCadChecks,
} from "../src/cad/CadChecks.ts";
import { recognizeDrivetrainParts } from "../src/cad/CadDrivetrain.ts";

// Either a snapshot directory, or a CAD data directory plus a manifest name.
const dir = process.argv[2]!;
const manifestFile = NodeFS.existsSync(NodePath.join(dir, "manifest.json"))
  ? NodePath.join(dir, "manifest.json")
  : NodePath.join(dir, "manifests", `${process.argv[3]}.json`);
const manifest = JSON.parse(NodeFS.readFileSync(manifestFile, "utf8"));
const assets = new Map<string, string>(
  manifest.assets.map((a: { geometryKey: string; relativePath: string }) => [
    a.geometryKey,
    a.relativePath,
  ]),
);
const occurrences = partOccurrences(manifest);
const glbs = new Map(
  [...new Set(occurrences.map((o) => o.geometryKey))].flatMap((key) => {
    const file = assets.get(key);
    return file ? [[key, NodeFS.readFileSync(NodePath.join(dir, "assets", file))] as const] : [];
  }),
);
const meshes = new Map([...glbs].map(([key, glb]) => [key, readCadTriangleMesh(glb)]));
const bounds = new Map([...glbs].map(([key, glb]) => [key, readCadGeometryBounds(glb)]));
const parts = recognizeDrivetrainParts(occurrences, meshes);
if (process.argv.includes("--parts"))
  for (const p of parts)
    console.log(
      p.role.kind.padEnd(8),
      p.name.padEnd(60),
      "c",
      p.fit.center.map((v) => (v / 0.0254).toFixed(2)).join(","),
      "ax",
      p.fit.axis.map((v) => v.toFixed(2)).join(","),
      "r",
      (p.fit.radius / 0.0254).toFixed(3),
      "half",
      (p.fit.halfLength / 0.0254).toFixed(3),
    );
console.log(`recognized ${parts.length} of ${occurrences.length} parts`);
const kernel = await Effect.runPromise(loadCadSolidKernel);
const result = runCadChecks(
  manifest,
  bounds,
  new Set(["drivetrain", "mesh-interference"]),
  undefined,
  { meshes, kernel },
);
for (const f of result.findings) {
  if (f.check !== "drivetrain") continue;
  console.log(`\n[${f.kind}${f.problem ? " PROBLEM" : ""}] ${f.summary}`);
  const placement = result.placements.get(f);
  if (placement)
    console.log(
      `  marker ${placement.expected}: local ${placement.point.map((v) => v.toFixed(4)).join(",")} on ${placement.occurrenceId.slice(0, 8)}`,
    );
}
