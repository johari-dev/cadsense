import type { CadPartAppearance } from "@cadsense/contracts";
import * as THREE from "three";

/** Older Onshape part GLTFs store display RGB as linear factors. Use saved part metadata
 * to distinguish those exports from already-correct linear colors; never recolor faces
 * with the part's single color. Runs once per decoded asset, before occurrence cloning.
 */
export const prepareCadMaterials = (
  root: THREE.Object3D,
  appearances: ReadonlyArray<typeof CadPartAppearance.Type | null>,
  defaultFinish: ReadonlySet<THREE.Material> = new Set(),
) => {
  const materials = new Set<THREE.MeshStandardMaterial>();
  root.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    for (const material of Array.isArray(object.material) ? object.material : [object.material])
      if (material instanceof THREE.MeshStandardMaterial) materials.add(material);
  });
  const near = (a: THREE.Color, b: THREE.Color) =>
    Math.max(Math.abs(a.r - b.r), Math.abs(a.g - b.g), Math.abs(a.b - b.b)) < 1e-6;
  let encodedEvidence = false;
  let linearEvidence = false;
  // Bulk exports omit part appearance metadata, but their material names retain
  // display RGB. Require Onshape's complete numeric signature and a matching
  // factor; arbitrary names and already-linear exports remain untouched.
  for (const material of materials) {
    if (material.map || material.vertexColors) continue;
    if (!/^(?:[01]\.\d{6}_){4}[01]\.\d{6}$/.test(material.name)) continue;
    const values = material.name.split("_").map(Number);
    if (values.some((value) => value > 1)) continue;
    const encoded = new THREE.Color(values[0]!, values[1]!, values[2]!);
    const linear = encoded.clone().convertSRGBToLinear();
    if (near(encoded, linear)) continue;
    encodedEvidence ||= near(material.color, encoded);
    linearEvidence ||= near(material.color, linear);
  }
  for (const appearance of appearances) {
    if (!appearance) continue;
    const { red, green, blue } = appearance.color;
    const encoded = new THREE.Color(red / 255, green / 255, blue / 255);
    const linear = encoded.clone().convertSRGBToLinear();
    // Endpoint colors alone cannot distinguish encodings. Leave ambiguous exports untouched.
    if (near(encoded, linear)) continue;
    for (const material of materials) {
      if (material.map || material.vertexColors) continue;
      encodedEvidence ||= near(material.color, encoded);
      linearEvidence ||= near(material.color, linear);
    }
  }
  if (!encodedEvidence || linearEvidence) return;
  for (const material of materials) {
    if (material.map || material.vertexColors) continue;
    material.color.convertSRGBToLinear();
    // This synchronous export omits surface finish. A restrained highlight restores
    // shape cues without inventing metallic properties or changing explicit textures.
    if (defaultFinish.has(material) && material.metalness === 0 && !material.roughnessMap)
      material.roughness = 0.4;
  }
};
