// Compare decoded triangles, normals, placements and rendered materials through Three's real loader.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeModule from "node:module";
import * as NodeURL from "node:url";
import * as NodeCrypto from "node:crypto";
import { snapshotGeometryKey } from "../src/onshape/OnshapeSnapshotManifest.ts";

const require = NodeModule.createRequire(new URL("../../web/package.json", import.meta.url));
const { GLTFLoader } = await import(
  NodeURL.pathToFileURL(require.resolve("three/addons/loaders/GLTFLoader.js"))
);
const { Vector3, Matrix3, Box3 } = await import(NodeURL.pathToFileURL(require.resolve("three")));
const [manifestPath, baselineAssets, candidates, output] = process.argv.slice(2);
if (!manifestPath || !baselineAssets || !candidates || !output)
  throw new Error(
    "Usage: node onshape-geometry-fidelity.mjs MANIFEST BASELINE_ASSETS CANDIDATE_DIR OUTPUT",
  );
const manifest = JSON.parse(await NodeFSP.readFile(manifestPath, "utf8"));
const candidateManifest = process.env.ONSHAPE_CANDIDATE_MANIFEST
  ? JSON.parse(await NodeFSP.readFile(process.env.ONSHAPE_CANDIDATE_MANIFEST, "utf8"))
  : undefined;
const loader = new GLTFLoader();
const canonicalNumber = (n) => (Object.is(n, -0) ? 0 : n);
// Ignore only near-zero normal noise. Positions and material values remain exact.
const normalZeroTolerance = 1e-15;
const digest = (data) => NodeCrypto.createHash("sha256").update(data).digest("hex");
async function inspect(bytes) {
  const { scene } = await loader.parseAsync(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    "",
  );
  scene.updateMatrixWorld(true);
  const bounds = new Box3().setFromObject(scene);
  const triangles = [];
  const equivalentTriangles = [];
  const materials = new Set();
  const v = new Vector3();
  scene.traverse((object) => {
    if (!object.isMesh) return;
    const g = object.geometry;
    const p = g.attributes.position;
    const n = g.attributes.normal;
    const normalMatrix = new Matrix3().getNormalMatrix(object.matrixWorld);
    const count = g.index ? g.index.count : p.count;
    for (let i = 0; i < count; i += 3) {
      const material = Array.isArray(object.material)
        ? object.material[
            g.groups.find((group) => i >= group.start && i < group.start + group.count)
              ?.materialIndex ?? 0
          ]
        : object.material;
      const m = JSON.stringify({
        color: material.color.toArray().map(canonicalNumber),
        opacity: canonicalNumber(material.opacity),
        transparent: material.transparent,
        side: material.side,
        metalness: material.metalness,
        roughness: material.roughness,
      });
      materials.add(m);
      const vertices = [0, 1, 2].map((offset) => {
        const index = g.index ? g.index.getX(i + offset) : i + offset;
        const position = v
          .fromBufferAttribute(p, index)
          .applyMatrix4(object.matrixWorld)
          .toArray()
          .map(canonicalNumber);
        const normal = n
          ? v
              .fromBufferAttribute(n, index)
              .applyNormalMatrix(normalMatrix)
              .toArray()
              .map(canonicalNumber)
          : [];
        return [position, normal];
      });
      // Preserve winding while ignoring the first vertex and triangle ordering.
      for (const [target, normalizeNormals] of [
        [triangles, false],
        [equivalentTriangles, true],
      ]) {
        const serialized = vertices.map(([position, normal]) =>
          JSON.stringify([
            position,
            normalizeNormals
              ? normal.map((n) => (Math.abs(n) < normalZeroTolerance ? 0 : n))
              : normal,
          ]),
        );
        const rotations = serialized.map((_, j) =>
          [...serialized.slice(j), ...serialized.slice(0, j)].join(";"),
        );
        target.push(`${rotations.sort()[0]}|${m}`);
      }
    }
    g.dispose();
  });
  return {
    triangles: triangles.length,
    geometryHash: digest(triangles.sort().join("\n")),
    equivalentGeometryHash: digest(equivalentTriangles.sort().join("\n")),
    materials: [...materials].sort(),
    bounds: [bounds.min.toArray().map(canonicalNumber), bounds.max.toArray().map(canonicalNumber)],
  };
}
const report = [];
for (const asset of manifest.assets) {
  const part = manifest.parts.find((part) => part.geometryKey === asset.geometryKey);
  const candidateKey = candidateManifest
    ? snapshotGeometryKey({
        ...part.source,
        tessellationProfile: candidateManifest.root.tessellationProfile,
      })
    : asset.geometryKey;
  const candidate = candidateManifest?.assets.find(
    (candidate) => candidate.geometryKey === candidateKey,
  );
  const candidatePath = NodePath.join(
    candidates,
    candidate?.relativePath ?? `${asset.geometryKey}.glb`,
  );
  try {
    await NodeFSP.access(candidatePath);
  } catch {
    continue;
  }
  const baselineBytes = await NodeFSP.readFile(NodePath.join(baselineAssets, asset.relativePath));
  const candidateBytes = await NodeFSP.readFile(candidatePath);
  if (
    digest(baselineBytes) !== asset.sha256 ||
    (candidate && digest(candidateBytes) !== candidate.sha256)
  )
    throw new Error(`Asset hash mismatch: ${asset.geometryKey}`);
  if (baselineBytes.equals(candidateBytes)) {
    report.push({
      key: asset.geometryKey,
      exactGeometry: true,
      equivalentGeometry: true,
      identicalBytes: true,
    });
    continue;
  }
  const before = await inspect(baselineBytes);
  const after = await inspect(candidateBytes);
  report.push({
    key: asset.geometryKey,
    exactGeometry: before.geometryHash === after.geometryHash,
    equivalentGeometry: before.equivalentGeometryHash === after.equivalentGeometryHash,
    before,
    after,
  });
}
await NodeFSP.writeFile(output, JSON.stringify(report, null, 2));
console.log(
  JSON.stringify(
    {
      compared: report.length,
      exact: report.filter((part) => part.exactGeometry).length,
      equivalent: report.filter((part) => part.equivalentGeometry).length,
      normalZeroTolerance,
      differences: report
        .filter((part) => !part.exactGeometry)
        .map((part) => ({
          key: part.key,
          before: part.before.triangles,
          after: part.after.triangles,
          beforeBounds: part.before.bounds,
          afterBounds: part.after.bounds,
        })),
    },
    null,
    2,
  ),
);
if (
  report.some((part) => !part.equivalentGeometry) ||
  (candidateManifest && report.length !== manifest.assets.length)
)
  process.exitCode = 1;
