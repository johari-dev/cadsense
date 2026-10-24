// Loads one cached part GLB as a welded mesh in part coordinates.
import { Mesh } from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { weldMesh, type PartMesh } from "./analysis";

export const loadGlbPart = async (bytes: ArrayBuffer): Promise<PartMesh> => {
  const gltf = await new GLTFLoader().parseAsync(bytes, "");
  gltf.scene.updateMatrixWorld(true);
  const positions: number[] = [];
  const indices: number[] = [];
  gltf.scene.traverse((object) => {
    if (!(object instanceof Mesh)) return;
    const geometry = object.geometry.clone().applyMatrix4(object.matrixWorld);
    const base = positions.length / 3;
    const attribute = geometry.getAttribute("position");
    for (let i = 0; i < attribute.count; i++)
      positions.push(attribute.getX(i), attribute.getY(i), attribute.getZ(i));
    const index = geometry.getIndex();
    if (index) for (let i = 0; i < index.count; i++) indices.push(base + index.getX(i));
    else for (let i = 0; i < attribute.count; i++) indices.push(base + i);
  });
  return weldMesh(positions, indices);
};
