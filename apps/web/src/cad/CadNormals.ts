import * as THREE from "three";

/** Faces meeting at a sharper angle than this get separate normals along their shared edge. */
const CREASE_DEGREES = 40;
const CREASE_COS = Math.cos(THREE.MathUtils.degToRad(CREASE_DEGREES));
// Creased normals never lean further than the crease angle from their own face (they average
// faces inside that cone), so corners well past it show the normals were averaged across creases.
const SMOOTHED_COS = Math.cos(THREE.MathUtils.degToRad(CREASE_DEGREES + 5));
// A few stray corners come from slivers; real cross-crease averaging touches most hole rims.
const SMOOTHED_FRACTION = 0.001;

/** Whether no more than a stray few corners lean past the crease angle from their face. */
const respectsCreases = (
  positions: Float32Array,
  normals: Float32Array,
  groups: readonly Uint32Array[],
) => {
  let corners = 0;
  for (const group of groups) corners += group.length;
  const limit = corners * SMOOTHED_FRACTION;
  let smoothed = 0;
  for (const group of groups)
    for (let i = 0; i < group.length; i += 3) {
      const a = group[i]! * 3,
        b = group[i + 1]! * 3,
        c = group[i + 2]! * 3;
      const ux = positions[b]! - positions[a]!,
        uy = positions[b + 1]! - positions[a + 1]!,
        uz = positions[b + 2]! - positions[a + 2]!;
      const vx = positions[c]! - positions[a]!,
        vy = positions[c + 1]! - positions[a + 1]!,
        vz = positions[c + 2]! - positions[a + 2]!;
      const nx = uy * vz - uz * vy,
        ny = uz * vx - ux * vz,
        nz = ux * vy - uy * vx;
      const bound = SMOOTHED_COS * Math.sqrt(nx * nx + ny * ny + nz * nz);
      if (normals[a]! * nx + normals[a + 1]! * ny + normals[a + 2]! * nz < bound) smoothed++;
      if (normals[b]! * nx + normals[b + 1]! * ny + normals[b + 2]! * nz < bound) smoothed++;
      if (normals[c]! * nx + normals[c + 1]! * ny + normals[c + 2]! * nz < bound) smoothed++;
      if (smoothed > limit) return false;
    }
  return true;
};

/**
 * Crease-aware normals for triangles that share `positions`. Each corner averages, by area, the
 * faces around its vertex that lie within the crease angle of its own face; corners of one vertex
 * with equal results share an output vertex, so flat fans and smooth surfaces stay indexed while
 * a flat face and the wall of a hole through it split. Returns null when `normals` already
 * respect creases. `groups` are index lists (one per primitive) into the shared positions.
 */
export const creaseNormals = (
  positions: Float32Array,
  normals: Float32Array | null,
  groups: readonly Uint32Array[],
) => {
  if (normals && respectsCreases(positions, normals, groups)) return null;
  const vertices = positions.length / 3;
  let corners = 0;
  for (const group of groups) corners += group.length;
  const triangles = corners / 3;
  const index = new Uint32Array(corners);
  let at = 0;
  for (const group of groups) {
    index.set(group, at);
    at += group.length;
  }
  // Area-weighted (cross product) and unit face normals.
  const area = new Float32Array(triangles * 3);
  const unit = new Float32Array(triangles * 3);
  for (let t = 0; t < triangles; t++) {
    const a = index[t * 3]! * 3,
      b = index[t * 3 + 1]! * 3,
      c = index[t * 3 + 2]! * 3;
    const ux = positions[b]! - positions[a]!,
      uy = positions[b + 1]! - positions[a + 1]!,
      uz = positions[b + 2]! - positions[a + 2]!;
    const vx = positions[c]! - positions[a]!,
      vy = positions[c + 1]! - positions[a + 1]!,
      vz = positions[c + 2]! - positions[a + 2]!;
    const nx = uy * vz - uz * vy,
      ny = uz * vx - ux * vz,
      nz = ux * vy - uy * vx;
    area[t * 3] = nx;
    area[t * 3 + 1] = ny;
    area[t * 3 + 2] = nz;
    const length = Math.sqrt(nx * nx + ny * ny + nz * nz);
    if (!length) continue;
    unit[t * 3] = nx / length;
    unit[t * 3 + 1] = ny / length;
    unit[t * 3 + 2] = nz / length;
  }
  // Corners around each vertex, in compressed rows.
  const start = new Uint32Array(vertices + 1);
  for (let corner = 0; corner < corners; corner++) start[index[corner]! + 1]!++;
  for (let v = 0; v < vertices; v++) start[v + 1]! += start[v]!;
  const fill = start.slice(0, vertices);
  const around = new Uint32Array(corners);
  for (let corner = 0; corner < corners; corner++) around[fill[index[corner]!]!++] = corner;

  let capacity = Math.max(vertices, 16);
  let outPositions = new Float32Array(capacity * 3);
  let outNormals = new Float32Array(capacity * 3);
  let emitted = 0;
  const emit = (v: number, x: number, y: number, z: number) => {
    if (emitted === capacity) {
      capacity *= 2;
      const grownPositions = new Float32Array(capacity * 3);
      grownPositions.set(outPositions);
      outPositions = grownPositions;
      const grownNormals = new Float32Array(capacity * 3);
      grownNormals.set(outNormals);
      outNormals = grownNormals;
    }
    outPositions[emitted * 3] = positions[v * 3]!;
    outPositions[emitted * 3 + 1] = positions[v * 3 + 1]!;
    outPositions[emitted * 3 + 2] = positions[v * 3 + 2]!;
    outNormals[emitted * 3] = x;
    outNormals[emitted * 3 + 1] = y;
    outNormals[emitted * 3 + 2] = z;
    return emitted++;
  };
  const outIndex = new Uint32Array(corners);
  // Per-vertex scratch: corners with the same face direction form one facet, so a flat fan of
  // any size costs one comparison per corner instead of one per pair.
  let facetOf = new Uint32Array(64);
  let facetTriangle = new Uint32Array(64);
  let facetArea = new Float64Array(64 * 3);
  let facetNormal = new Float64Array(64 * 3);
  let facetVertex = new Int32Array(64);
  for (let v = 0; v < vertices; v++) {
    const first = start[v]!,
      count = start[v + 1]! - first;
    if (!count) continue;
    if (count > facetOf.length) {
      facetOf = new Uint32Array(count);
      facetTriangle = new Uint32Array(count);
      facetArea = new Float64Array(count * 3);
      facetNormal = new Float64Array(count * 3);
      facetVertex = new Int32Array(count);
    }
    let facets = 0;
    let degenerate = false;
    for (let k = 0; k < count; k++) {
      const t = Math.floor(around[first + k]! / 3);
      const x = unit[t * 3]!,
        y = unit[t * 3 + 1]!,
        z = unit[t * 3 + 2]!;
      if (x === 0 && y === 0 && z === 0) {
        facetOf[k] = 0xffffffff;
        degenerate = true;
        continue;
      }
      let facet = 0;
      for (; facet < facets; facet++) {
        const r = facetTriangle[facet]! * 3;
        if (x * unit[r]! + y * unit[r + 1]! + z * unit[r + 2]! > 0.99999) break;
      }
      if (facet === facets) {
        facetTriangle[facet] = t;
        facetArea[facet * 3] = facetArea[facet * 3 + 1] = facetArea[facet * 3 + 2] = 0;
        facets++;
      }
      facetOf[k] = facet;
      for (let axis = 0; axis < 3; axis++)
        facetArea[facet * 3 + axis] = facetArea[facet * 3 + axis]! + area[t * 3 + axis]!;
    }
    // Each facet's normal sums the facets within the crease angle of it; facets with equal
    // results share one output vertex.
    for (let i = 0; i < facets; i++) {
      const r = facetTriangle[i]! * 3;
      let x = 0,
        y = 0,
        z = 0;
      for (let j = 0; j < facets; j++) {
        const s = facetTriangle[j]! * 3;
        if (
          unit[r]! * unit[s]! + unit[r + 1]! * unit[s + 1]! + unit[r + 2]! * unit[s + 2]! <
          CREASE_COS
        )
          continue;
        x += facetArea[j * 3]!;
        y += facetArea[j * 3 + 1]!;
        z += facetArea[j * 3 + 2]!;
      }
      const length = Math.sqrt(x * x + y * y + z * z);
      facetNormal[i * 3] = x / length;
      facetNormal[i * 3 + 1] = y / length;
      facetNormal[i * 3 + 2] = z / length;
      let shared = -1;
      for (let j = 0; j < i && shared < 0; j++)
        if (
          facetNormal[i * 3]! * facetNormal[j * 3]! +
            facetNormal[i * 3 + 1]! * facetNormal[j * 3 + 1]! +
            facetNormal[i * 3 + 2]! * facetNormal[j * 3 + 2]! >
          0.999999
        )
          shared = facetVertex[j]!;
      facetVertex[i] =
        shared >= 0
          ? shared
          : emit(v, facetNormal[i * 3]!, facetNormal[i * 3 + 1]!, facetNormal[i * 3 + 2]!);
    }
    // Zero-area corners draw nothing; they reuse any vertex here, or keep the input normal.
    const fallback = degenerate
      ? facets
        ? facetVertex[0]!
        : normals
          ? emit(v, normals[v * 3]!, normals[v * 3 + 1]!, normals[v * 3 + 2]!)
          : emit(v, 0, 0, 1)
      : 0;
    for (let k = 0; k < count; k++)
      outIndex[around[first + k]!] =
        facetOf[k] === 0xffffffff ? fallback : facetVertex[facetOf[k]!]!;
  }
  const result: Uint32Array[] = [];
  at = 0;
  for (const group of groups) {
    result.push(outIndex.slice(at, at + group.length));
    at += group.length;
  }
  return {
    positions: outPositions.slice(0, emitted * 3),
    normals: outNormals.slice(0, emitted * 3),
    groups: result,
  };
};

/**
 * Replaces normals that were averaged across sharp edges, in place, before occurrence cloning.
 * Older 3MF-converted assets share one normal per vertex between a flat face and the walls of
 * the holes through it, which streaks the face with light and dark wedges. Meshes that share a
 * position buffer (one primitive per 3MF color) are rewritten together. Geometry that already
 * respects creases, or carries attributes this cannot carry over, is left alone.
 */
export const creaseCadNormals = (root: THREE.Object3D) => {
  const buffers = new Map<
    THREE.BufferAttribute | THREE.InterleavedBufferAttribute,
    {
      positions: Float32Array;
      normal: THREE.BufferAttribute;
      normals: Float32Array;
      geometries: THREE.BufferGeometry[];
    } | null
  >();
  root.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    const geometry: THREE.BufferGeometry = object.geometry;
    const position = geometry.getAttribute("position");
    const normal = geometry.getAttribute("normal");
    if (!position) return;
    const positions = position.array;
    const normals = normal?.array;
    const supported =
      position instanceof THREE.BufferAttribute &&
      normal instanceof THREE.BufferAttribute &&
      positions instanceof Float32Array &&
      normals instanceof Float32Array &&
      position.itemSize === 3 &&
      normal.itemSize === 3 &&
      geometry.getIndex() !== null &&
      Object.keys(geometry.attributes).length === 2 &&
      !Object.keys(geometry.morphAttributes).length &&
      !geometry.groups.length;
    const buffer = buffers.get(position);
    // Every primitive on one position buffer must be supported and share its normals.
    if (!supported || buffer === null || (buffer && buffer.normal !== normal)) {
      buffers.set(position, null);
      return;
    }
    if (!buffer) buffers.set(position, { positions, normal, normals, geometries: [geometry] });
    else if (!buffer.geometries.includes(geometry)) buffer.geometries.push(geometry);
  });
  let rewritten = 0;
  for (const buffer of buffers.values()) {
    if (!buffer) continue;
    const creased = creaseNormals(
      buffer.positions,
      buffer.normals,
      buffer.geometries.map((geometry) => Uint32Array.from(geometry.getIndex()?.array ?? [])),
    );
    if (!creased) continue;
    const positions = new THREE.BufferAttribute(creased.positions, 3);
    const normals = new THREE.BufferAttribute(creased.normals, 3);
    const small = creased.positions.length / 3 <= 0xffff;
    buffer.geometries.forEach((geometry, i) => {
      const index = creased.groups[i]!;
      geometry.setAttribute("position", positions);
      geometry.setAttribute("normal", normals);
      geometry.setIndex(new THREE.BufferAttribute(small ? Uint16Array.from(index) : index, 1));
      rewritten++;
    });
  }
  return { rewritten };
};
