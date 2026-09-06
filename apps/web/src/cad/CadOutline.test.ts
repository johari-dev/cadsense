import { describe, expect, it, vi } from "vite-plus/test";
import * as THREE from "three";
import { cadOutlineSize, createCadOutline, supportsCadOutline } from "./CadOutline";

vi.mock("three", async (original) => {
  const actual = await original<typeof import("three")>();
  return {
    ...actual,
    WebGLRenderer: class {
      autoClear = true;
      target: THREE.WebGLRenderTarget | null = null;
      color = new actual.Color(0x141414);
      alpha = 0.7;
      render = vi.fn();
      getDrawingBufferSize(size: THREE.Vector2) {
        return size.set(1280, 960);
      }
      getRenderTarget() {
        return this.target;
      }
      setRenderTarget(target: THREE.WebGLRenderTarget | null) {
        this.target = target;
      }
      getClearColor(color: THREE.Color) {
        return color.copy(this.color);
      }
      getClearAlpha() {
        return this.alpha;
      }
      setClearColor(color: THREE.Color, alpha: number) {
        this.color.copy(color);
        this.alpha = alpha;
      }
    },
  };
});

describe("CAD outline overlay", () => {
  it("does not draw opaque-shell outlines over translucent, cutout or double-sided surfaces", () => {
    const geometry = new THREE.BoxGeometry();
    expect(supportsCadOutline(new THREE.Mesh(geometry, new THREE.MeshStandardMaterial()))).toBe(
      true,
    );
    for (const props of [
      { transparent: true, opacity: 0.4 },
      { alphaTest: 0.5 },
      { side: THREE.DoubleSide },
      { depthWrite: false },
    ])
      expect(
        supportsCadOutline(new THREE.Mesh(geometry, new THREE.MeshStandardMaterial(props))),
      ).toBe(false);
  });
  it("bounds normal/depth targets to 16 MiB without upscaling small panels", () => {
    expect(cadOutlineSize(320, 200)).toEqual({ width: 320, height: 200 });
    for (const [width, height] of [
      [7680, 4320],
      [1920, 4000],
      [12000, 100],
    ]) {
      const size = cadOutlineSize(width!, height!);
      expect(size.width * size.height * 8).toBeLessThanOrEqual(16 * 1024 * 1024);
      expect(size.width / size.height).toBeCloseTo(width! / height!, 0);
    }
  });
  it.each([false, true])("restores renderer and scene state even on failure (%s)", (fail) => {
    const renderer = new THREE.WebGLRenderer();
    const outline = createCadOutline(renderer);
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0xffffff);
    const background = scene.background;
    const originalColor = renderer.getClearColor(new THREE.Color());
    const camera = new THREE.PerspectiveCamera();
    if (fail)
      vi.mocked(renderer.render).mockImplementationOnce(() => {
        throw new Error("context lost");
      });
    if (fail) expect(() => outline.render(scene, camera, 1)).toThrow("context lost");
    else outline.render(scene, camera, 1);
    expect(scene.background).toBe(background);
    expect(scene.overrideMaterial).toBe(null);
    expect(renderer.getRenderTarget()).toBe(null);
    expect(renderer.autoClear).toBe(true);
    expect(renderer.getClearColor(new THREE.Color())).toEqual(originalColor);
    expect(renderer.getClearAlpha()).toBe(0.7);
    outline.dispose();
  });
});
