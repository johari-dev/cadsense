import { CadCameraPose, CadSnapshotManifest, type CadViewState } from "@cadsense/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it, vi } from "vite-plus/test";
import { createCadSceneRenderer } from "./CadSceneRenderer";
import {
  BoxGeometry,
  Camera,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  Quaternion,
  Vector3,
  type Plane,
} from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import * as CadBudget from "@cadsense/shared/cadSceneBudget";

const calls = vi.hoisted(() => ({ render: vi.fn(), dispose: vi.fn(), forceContextLoss: vi.fn() }));
vi.mock("./CadOutline", () => ({
  createCadOutline: () => ({ render() {}, dispose() {} }),
  supportsCadOutline: () => true,
}));
vi.mock("three", async (importOriginal) => {
  const actual = await importOriginal<typeof import("three")>();
  return {
    ...actual,
    WebGLRenderer: class {
      outputColorSpace = "";
      clippingPlanes: Plane[] = [];
      setClearColor() {}
      setPixelRatio() {}
      setSize() {}
      clearDepth() {}
      getContext() {
        return { isContextLost: () => false };
      }
      render(scene: unknown, camera: Camera) {
        camera.updateMatrixWorld();
        calls.render(scene, camera, this.clippingPlanes);
      }
      dispose = calls.dispose;
      forceContextLoss = calls.forceContextLoss;
    },
  };
});
vi.mock("three/addons/loaders/GLTFLoader.js", async () => {
  const { Group } = await import("three");
  return {
    GLTFLoader: class {
      async parseAsync() {
        const scene = new Group();
        return { scene, scenes: [scene] };
      }
    },
  };
});

const id = "1".repeat(64);
const isCameraPose = Schema.is(CadCameraPose);
// Valid empty GLB: lifecycle tests fake the graphics boundary, not asset admission.
const geometry = () => {
  const json = new TextEncoder().encode(JSON.stringify({ asset: { version: "2.0" }, nodes: [] }));
  const length = Math.ceil(json.length / 4) * 4;
  const bytes = new Uint8Array(20 + length);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, bytes.length, true);
  view.setUint32(12, length, true);
  view.setUint32(16, 0x4e4f534a, true);
  bytes.fill(32, 20);
  bytes.set(json, 20);
  return bytes.buffer;
};
const geometryKey = "2".repeat(64);
const partSource = {
  host: "https://cad.onshape.com",
  documentId: "1".repeat(24),
  documentMicroversion: "2".repeat(24),
  documentVersion: null,
  elementId: "3".repeat(24),
  configuration: "default",
  fullConfiguration: "default",
  partId: "part",
  tessellationProfile: "test",
};
const manifest = Schema.decodeUnknownSync(CadSnapshotManifest)({
  schemaVersion: 1,
  snapshotId: "00000000-0000-4000-8000-000000000001",
  rootId: id,
  projectId: "project",
  createdAt: "2026-09-05T00:00:00Z",
  root: {
    host: partSource.host,
    documentId: partSource.documentId,
    elementId: partSource.elementId,
    kind: "part-studio",
    originalRevision: { kind: "m", id: partSource.documentMicroversion },
    microversionId: partSource.documentMicroversion,
    configuration: "default",
    tessellationProfile: "test",
  },
  nodes: [
    {
      id,
      parentId: null,
      occurrencePath: [],
      instanceId: null,
      name: "root",
      kind: "part-studio",
      suppressed: false,
      defaultVisible: true,
      sourcePartKey: null,
      transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
    },
  ],
  parts: [
    {
      geometryKey,
      source: partSource,
      geometryRequired: true,
      metadata: {
        name: "part",
        bodyType: "solid",
        isHidden: false,
        isMesh: false,
        partIdentity: null,
        configurationId: null,
        appearance: null,
        material: null,
      },
    },
  ],
  assets: [
    {
      geometryKey,
      sha256: geometryKey,
      byteLength: geometry().byteLength,
      relativePath: `${geometryKey}.glb`,
      format: "glb",
    },
  ],
  dependencies: [partSource],
});
const state: CadViewState = {
  rootId: id,
  snapshotId: manifest.snapshotId,
  revision: 0,
  camera: { kind: "preset", preset: "isometric", fit: [] },
  visibility: {},
  isolatedOccurrenceIds: [],
  explosion: 0,
};
const canvasHarness = () => {
  let captureCallback: BlobCallback | undefined;
  // Browser boundary fake: only the methods used by this renderer are represented.
  const canvas = Object.assign(new EventTarget(), {
    style: {},
    ownerDocument: new EventTarget(),
    getRootNode: () => canvas.ownerDocument,
    clientWidth: 800,
    clientHeight: 600,
    setPointerCapture: () => {},
    releasePointerCapture: () => {},
    toBlob: (callback: BlobCallback) => {
      captureCallback = callback;
    },
  }) as unknown as HTMLCanvasElement;
  return {
    canvas,
    completeCapture: () => captureCallback?.(new Blob(["png"], { type: "image/png" })),
  };
};

describe("CAD renderer lifecycle without WebGL", () => {
  it("notifies marker subscribers after rendered camera and scene changes and releases subscriptions", async () => {
    const renderer = createCadSceneRenderer({ canvas: canvasHarness().canvas });
    const frames = vi.fn();
    const unsubscribe = renderer.subscribeFrames(frames);
    try {
      await renderer.load(manifest, async () => geometry());
      renderer.apply(state);
      expect(frames).toHaveBeenCalledTimes(1);
      renderer.resize(1280, 960);
      expect(frames).toHaveBeenCalledTimes(2);
      renderer.restoreCommentFraming({ x: 0.1, y: 0 });
      expect(frames).toHaveBeenCalledTimes(3);
      renderer.endCommentReview();
      expect(frames).toHaveBeenCalledTimes(4);
      unsubscribe();
      renderer.apply(state);
      expect(frames).toHaveBeenCalledTimes(4);
    } finally {
      unsubscribe();
      renderer.dispose();
    }
  });
  it("overlaps bounded asset downloads and does not expose a partial scene", async () => {
    const h = canvasHarness();
    const renderer = createCadSceneRenderer({ canvas: h.canvas });
    const assets = Array.from({ length: 12 }, (_, i) => ({
      ...manifest.assets[0]!,
      geometryKey: i.toString(16).padStart(64, "0"),
      sha256: i.toString(16).padStart(64, "0"),
    }));
    const large = { ...manifest, assets };
    const releases: Array<() => void> = [];
    const read = vi.fn(
      () => new Promise<ArrayBuffer>((resolve) => releases.push(() => resolve(geometry()))),
    );
    const loading = renderer.load(large, read);
    try {
      await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(6));
      expect(renderer.cachedManifest(large.snapshotId)).toBeNull();
      while (releases.length) releases.shift()!();
      await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(12));
      while (releases.length) releases.shift()!();
      await loading;
      expect(renderer.cachedManifest(large.snapshotId)).toBe(large);
    } finally {
      renderer.dispose();
      while (releases.length) releases.shift()!();
      await loading.catch(() => {});
    }
  });
  it("does not verify a target through another visible component during inspection", async () => {
    vi.stubGlobal(
      "OffscreenCanvas",
      class {
        getContext() {
          return null;
        }
      },
    );
    const scene = await new GLTFLoader().parseAsync(geometry(), "");
    scene.scene.add(new Mesh(new BoxGeometry(0.02, 0.02, 0.02), new MeshBasicMaterial()));
    const parser = vi.spyOn(GLTFLoader.prototype, "parseAsync").mockResolvedValueOnce(scene);
    const renderer = createCadSceneRenderer({ canvas: canvasHarness().canvas });
    try {
      await renderer.load(
        {
          ...manifest,
          nodes: [
            { ...manifest.nodes[0]!, kind: "part", sourcePartKey: geometryKey },
            {
              ...manifest.nodes[0]!,
              id: "3".repeat(64),
              kind: "part",
              sourcePartKey: geometryKey,
              transform: [2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 1],
            },
          ],
        },
        async () => geometry(),
      );
      renderer.resize(1280, 960);
      renderer.apply(state);
      const hits = renderer.commentWork({
        kind: "inspect",
        targets: [
          {
            candidateId: "inside",
            occurrenceId: id,
            point: [0, 0, 0.01],
          },
        ],
      });
      expect(hits[0]?.reason).toBe("occluded");
    } finally {
      renderer.dispose();
      parser.mockRestore();
      vi.unstubAllGlobals();
    }
  });
  it("can restore a comment camera after rotating to reveal the underside of a part", async () => {
    const scene = await new GLTFLoader().parseAsync(geometry(), "");
    scene.scene.add(new Mesh(new BoxGeometry(0.02, 0.02, 0.02), new MeshBasicMaterial()));
    const parser = vi.spyOn(GLTFLoader.prototype, "parseAsync").mockResolvedValueOnce(scene);
    const renderer = createCadSceneRenderer({ canvas: canvasHarness().canvas });
    try {
      await renderer.load(
        {
          ...manifest,
          nodes: [{ ...manifest.nodes[0]!, kind: "part", sourcePartKey: geometryKey }],
        },
        async () => geometry(),
      );
      renderer.resize(800, 600);
      renderer.apply(state);
      renderer.focusComment(
        {
          kind: "point",
          label: "Underside",
          occurrenceId: id,
          point: [0, 0, -0.01],
          normal: [0, 0, -1],
          captureId: "capture",
          inspectionId: "inspection",
          confirmationReason: "Verified underside",
        },
        { width: 400, height: 600, centerX: 200, centerY: 300 },
        true,
      );
      const pose = renderer.cameraPose();
      expect(pose.position[2]).toBeLessThan(0);
      expect(isCameraPose(pose)).toBe(true);
      expect(() =>
        renderer.apply({ ...state, camera: { kind: "pose", pose, fit: null } }),
      ).not.toThrow();
    } finally {
      renderer.dispose();
      parser.mockRestore();
    }
  });
  it.each(["perspective", "orthographic"] as const)(
    "centers an arbitrary world point and scales magnification in %s captures",
    async (projection) => {
      const h = canvasHarness();
      const renderer = createCadSceneRenderer({ canvas: h.canvas });
      const pose = {
        position: [0.2, -0.3, 0.15] as const,
        target: [0.02, 0, 0.01] as const,
        up: [0, 1, 1] as const,
        projection,
        zoom: 1,
      };
      try {
        await renderer.load(manifest, async () => geometry());
        renderer.resize(800, 600);
        let baseline = 0;
        for (const zoom of [1, 2, 0.5]) {
          const custom = { ...pose, zoom };
          expect(
            renderer.apply({ ...state, camera: { kind: "pose", pose: custom, fit: null } }),
          ).toEqual(custom);
          const camera: Camera = calls.render.mock.calls.at(-1)![1];
          const center = new Vector3(...pose.target).project(camera);
          expect(center.x).toBeCloseTo(0, 10);
          expect(center.y).toBeCloseTo(0, 10);
          const point = new Vector3(...pose.target)
            .addScaledVector(new Vector3().setFromMatrixColumn(camera.matrixWorld, 0), 0.01)
            .project(camera);
          if (zoom === 1) baseline = point.x;
          expect(point.x).toBeCloseTo(baseline * zoom, 10);
          const captured = renderer.capture();
          h.completeCapture();
          expect((await captured).type).toBe("image/png");
          renderer.resize(800, 900);
          const resized: Camera = calls.render.mock.calls.at(-1)![1];
          expect(new Vector3(...pose.target).project(resized).x).toBeCloseTo(0, 10);
          renderer.resize(800, 600);
        }
      } finally {
        renderer.dispose();
      }
    },
  );

  it("reuses warm scenes without reading assets and preserves the same-scene transition origin", async () => {
    const h = canvasHarness();
    const renderer = createCadSceneRenderer({ canvas: h.canvas, cacheScenes: true });
    const read = vi.fn(async () => geometry());
    const second = { ...manifest, snapshotId: "00000000-0000-4000-8000-000000000002" };
    try {
      expect(renderer.displayedManifest()).toBeNull();
      expect(await renderer.load(manifest, read)).toBe(false);
      expect(renderer.displayedManifest()).toBe(manifest);
      renderer.apply(state);
      expect(await renderer.load(manifest, read)).toBe(true);
      // The current view remains capturable while a different thread supplies its next view.
      const captured = renderer.capture();
      h.completeCapture();
      await captured;
      expect(await renderer.load(second, read)).toBe(false);
      expect(renderer.displayedManifest()).toBe(second);
      renderer.apply({ ...state, snapshotId: second.snapshotId });
      expect(await renderer.load(manifest, read)).toBe(false);
      expect(renderer.displayedManifest()).toBe(manifest);
      expect(read).toHaveBeenCalledTimes(2);
      expect(renderer.cachedManifest(manifest.snapshotId)).toBe(manifest);
    } finally {
      renderer.dispose();
    }
  });
  it("keeps a full robot warm across thread reattachment and a small-project round trip", async () => {
    const measurement = vi.spyOn(CadBudget, "measureCadGeometry").mockReturnValue({
      decodedBytes: 1100 * 1024 * 1024,
      triangles: 0,
      drawCalls: 0,
      nodeCount: 0,
    });
    const renderer = createCadSceneRenderer({ canvas: canvasHarness().canvas, cacheScenes: true });
    const read = vi.fn(async () => geometry());
    const second = { ...manifest, snapshotId: "00000000-0000-4000-8000-000000000002" };
    try {
      await renderer.load(manifest, read);
      renderer.apply(state);
      renderer.suspend();
      renderer.resume();
      expect(await renderer.load(manifest, read)).toBe(true);
      expect(read).toHaveBeenCalledTimes(1);
      measurement.mockReturnValue({
        decodedBytes: 10 * 1024 * 1024,
        triangles: 0,
        drawCalls: 0,
        nodeCount: 0,
      });
      await renderer.load(second, read);
      renderer.suspend();
      renderer.resume();
      await renderer.load(manifest, read);
      expect(read).toHaveBeenCalledTimes(2);
    } finally {
      renderer.dispose();
      measurement.mockRestore();
    }
  });
  it("evicts least-recent scenes at the aggregate memory limit", async () => {
    const measurement = vi.spyOn(CadBudget, "measureCadGeometry").mockReturnValue({
      decodedBytes: 600 * 1024 * 1024,
      triangles: 0,
      drawCalls: 0,
      nodeCount: 0,
    });
    const h = canvasHarness();
    const renderer = createCadSceneRenderer({ canvas: h.canvas, cacheScenes: true });
    const second = { ...manifest, snapshotId: "00000000-0000-4000-8000-000000000002" };
    const third = { ...manifest, snapshotId: "00000000-0000-4000-8000-000000000003" };
    try {
      await renderer.load(manifest, async () => geometry());
      await renderer.load(second, async () => geometry());
      await renderer.load(manifest, async () => {
        throw new Error("Unexpected read");
      });
      await renderer.load(third, async () => geometry());
      expect(renderer.cachedManifest(second.snapshotId)).toBeNull();
      expect(renderer.cachedManifest(manifest.snapshotId)).toBe(manifest);
      expect(renderer.cachedManifest(third.snapshotId)).toBe(third);
    } finally {
      renderer.dispose();
      measurement.mockRestore();
    }
    expect(renderer.cachedManifest(manifest.snapshotId)).toBeNull();
  });
  it("bounds small scene retention to three and continues unfinished loads while detached", async () => {
    const h = canvasHarness();
    const renderer = createCadSceneRenderer({ canvas: h.canvas, cacheScenes: true });
    try {
      for (const suffix of [1, 2, 3, 4]) {
        await renderer.load(
          { ...manifest, snapshotId: `00000000-0000-4000-8000-00000000000${suffix}` },
          async () => geometry(),
        );
      }
      expect(renderer.cachedManifest(manifest.snapshotId)).toBeNull();
      let finish!: (value: ArrayBuffer) => void;
      const loading = renderer.load(
        manifest,
        () =>
          new Promise<ArrayBuffer>((resolve) => {
            finish = resolve;
          }),
      );
      renderer.suspend();
      finish(geometry());
      await expect(loading).resolves.toBe(false);
      expect(renderer.cachedManifest(manifest.snapshotId)).toBe(manifest);
      renderer.resume();
      expect(await renderer.load(manifest, async () => geometry())).toBe(true);
    } finally {
      renderer.dispose();
    }
  });
  it("cannot activate a cancelled background load after another snapshot is displayed", async () => {
    const renderer = createCadSceneRenderer({ canvas: canvasHarness().canvas, cacheScenes: true });
    const second = { ...manifest, snapshotId: "00000000-0000-4000-8000-000000000002" };
    let finish!: (value: ArrayBuffer) => void;
    const old = renderer.load(
      manifest,
      () =>
        new Promise<ArrayBuffer>((resolve) => {
          finish = resolve;
        }),
    );
    try {
      renderer.cancelLoad();
      await renderer.load(second, async () => geometry());
      expect(renderer.displayedManifest()).toBe(second);
      finish(geometry());
      await expect(old).rejects.toMatchObject({ reason: "superseded" });
      expect(renderer.displayedManifest()).toBe(second);
      expect(renderer.cachedManifest(manifest.snapshotId)).toBeNull();
    } finally {
      renderer.dispose();
    }
  });
  it.each(
    (["front", "top", "bottom"] as const).flatMap((preset) =>
      [1, -1].map((limit) => ({ preset, limit })),
    ),
  )("keeps world-Z navigation limit $limit after $preset", async ({ preset, limit }) => {
    const h = canvasHarness();
    const ended = vi.fn();
    const renderer = createCadSceneRenderer({ canvas: h.canvas, onInteractionEnd: ended });
    try {
      await renderer.load(manifest, async () => geometry());
      renderer.apply({ ...state, camera: { kind: "preset", preset, fit: [] } });
      renderer.setInteractive(true);
      const pointer = (type: string, y: number) =>
        Object.assign(new Event(type), {
          pointerId: 1,
          pointerType: "mouse",
          button: 0,
          clientX: 200,
          clientY: y,
          pageX: 200,
          pageY: y,
          ctrlKey: false,
          shiftKey: false,
          metaKey: false,
        });
      h.canvas.dispatchEvent(pointer("pointerdown", 200));
      h.canvas.ownerDocument.dispatchEvent(pointer("pointermove", 200 + limit * 1200));
      h.canvas.ownerDocument.dispatchEvent(pointer("pointerup", 200 + limit * 1200));
      const after = ended.mock.calls.at(-1)![0];
      const direction = new Vector3(...after.position)
        .sub(new Vector3(...after.target))
        .normalize();
      expect(direction.z).toBeCloseTo(limit, 6);
    } finally {
      renderer.dispose();
    }
  });
  it.each(["top", "bottom", "front", "back", "left", "right", "isometric"] as const)(
    "can drag away from %s after replacing the camera",
    async (preset) => {
      const h = canvasHarness();
      const ended = vi.fn();
      const renderer = createCadSceneRenderer({ canvas: h.canvas, onInteractionEnd: ended });
      try {
        await renderer.load(manifest, async () => geometry());
        renderer.apply(state);
        const before = renderer.apply({ ...state, camera: { kind: "preset", preset, fit: [] } });
        renderer.setInteractive(true);
        const pointer = (type: string, x: number) =>
          Object.assign(new Event(type), {
            pointerId: 1,
            pointerType: "mouse",
            button: 0,
            clientX: x,
            clientY: preset === "top" ? 400 - x : preset === "bottom" ? x : 200,
            pageX: x,
            pageY: preset === "top" ? 400 - x : preset === "bottom" ? x : 200,
            ctrlKey: false,
            shiftKey: false,
            metaKey: false,
          });
        h.canvas.dispatchEvent(pointer("pointerdown", 200));
        h.canvas.ownerDocument.dispatchEvent(pointer("pointermove", 260));
        h.canvas.ownerDocument.dispatchEvent(pointer("pointerup", 260));
        expect(ended).toHaveBeenCalledOnce();
        const after = ended.mock.calls[0]![0];
        expect(
          new Vector3(...after.position).distanceTo(new Vector3(...before.position)),
        ).toBeGreaterThan(0.1);
        expect(after.target).toEqual(before.target);
        const saved = {
          ...state,
          camera: { kind: "pose", fit: null, pose: after },
        } satisfies CadViewState;
        const restored = renderer.apply(saved);
        expect(
          new Vector3(...restored.position).distanceTo(new Vector3(...after.position)),
        ).toBeLessThan(1e-8);
      } finally {
        renderer.dispose();
      }
    },
  );
  it("pans in screen space and retains its target after camera rebinding and save", async () => {
    const h = canvasHarness();
    const ended = vi.fn();
    const renderer = createCadSceneRenderer({ canvas: h.canvas, onInteractionEnd: ended });
    try {
      await renderer.load(manifest, async () => geometry());
      renderer.resize(800, 600);
      for (const preset of ["top", "front", "bottom", "right", "isometric"] as const) {
        const before = renderer.apply({ ...state, camera: { kind: "preset", preset, fit: [] } });
        renderer.setInteractive(true);
        const camera: Camera = calls.render.mock.calls.at(-1)![1];
        const right = new Vector3().setFromMatrixColumn(camera.matrix, 0);
        const pointer = (type: string, x: number) =>
          Object.assign(new Event(type), {
            pointerId: 1,
            pointerType: "mouse",
            button: 2,
            clientX: x,
            clientY: 200,
            pageX: x,
            pageY: 200,
            ctrlKey: false,
            shiftKey: false,
            metaKey: false,
          });
        h.canvas.dispatchEvent(pointer("pointerdown", 200));
        h.canvas.ownerDocument.dispatchEvent(pointer("pointermove", 260));
        h.canvas.ownerDocument.dispatchEvent(pointer("pointerup", 260));
        const after = ended.mock.calls.at(-1)![0];
        expect(after.up).toEqual(before.up);
        const delta = new Vector3(...after.target).sub(new Vector3(...before.target));
        expect(delta.length()).toBeGreaterThan(0.01);
        expect(delta.clone().normalize().dot(right)).toBeCloseTo(-1, 6);
        const eyeDelta = new Vector3(...after.position).sub(new Vector3(...before.position));
        expect(eyeDelta.distanceTo(delta)).toBeLessThan(1e-8);
        const restored = renderer.apply({
          ...state,
          camera: { kind: "pose", fit: null, pose: after },
        });
        expect(restored.target).toEqual(after.target);
      }
    } finally {
      renderer.dispose();
    }
  });
  it("redraws changed appearance without changing the view or accepting a stale capture", async () => {
    const h = canvasHarness();
    const renderer = createCadSceneRenderer({ canvas: h.canvas });
    try {
      await renderer.load(manifest, async () => geometry());
      const pose = renderer.apply(state);
      const before = calls.render.mock.calls.length;
      renderer.setAppearance({ background: 0xfafafa, dark: false });
      expect(calls.render.mock.calls.length).toBe(before + 1);
      renderer.setAppearance({ background: 0xfafafa, dark: false });
      expect(calls.render.mock.calls.length).toBe(before + 1);
      expect(renderer.apply(state)).toEqual(pose);
      const capture = renderer.capture();
      renderer.setAppearance({ background: 0x18212b, dark: true });
      h.completeCapture();
      await expect(capture).rejects.toMatchObject({ reason: "superseded" });
    } finally {
      renderer.dispose();
    }
  });
  it("coalesces camera transitions and stops scheduling when settled, snapped, or disposed", async () => {
    const clock = vi.spyOn(performance, "now").mockReturnValue(0);
    const frames = new Map<number, FrameRequestCallback>();
    let id = 0;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frames.set(++id, callback);
      return id;
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
    const h = canvasHarness();
    const renderer = createCadSceneRenderer({ canvas: h.canvas });
    const frame = (time: number) => {
      const queued = [...frames.values()];
      frames.clear();
      for (const callback of queued) callback(time);
    };
    try {
      await renderer.load(manifest, async () => geometry());
      renderer.apply(state);
      const initialRotation = (calls.render.mock.calls.at(-1)![1] as Camera).quaternion.clone();
      renderer.transition({ ...state, explosion: 0.5 });
      expect(frames.size).toBe(1);
      renderer.transition({ ...state, camera: { kind: "preset", preset: "back", fit: [] } }, 400);
      expect(frames.size).toBe(1);
      frame(performance.now() + 200);
      expect(frames.size).toBe(1);
      const destinationRotation = new Quaternion().setFromRotationMatrix(
        new Matrix4().lookAt(new Vector3(0, 1, 0), new Vector3(), new Vector3(0, 0, 1)),
      );
      const halfway = (calls.render.mock.calls.at(-1)![1] as Camera).quaternion;
      // Most travel happens early, leaving time for a gentle, exact settle.
      expect(halfway.angleTo(initialRotation.slerp(destinationRotation, 0.875))).toBeLessThan(1e-6);
      frame(performance.now() + 400);
      expect(frames.size).toBe(0);
      renderer.apply(state);
      renderer.transition({ ...state, explosion: 1 });
      frame(259);
      expect(frames.size).toBe(1);
      frame(260);
      expect(frames.size).toBe(0);
      renderer.apply(state);
      renderer.transition({ ...state, camera: { kind: "preset", preset: "top", fit: [] } });
      frame(279);
      expect(frames.size).toBe(1);
      frame(280);
      expect(frames.size).toBe(0);
      renderer.transition(state);
      frame(100);
      const interrupted = (calls.render.mock.calls.at(-1)![1] as Camera).quaternion.clone();
      clock.mockReturnValue(100);
      renderer.transition({ ...state, camera: { kind: "preset", preset: "front", fit: [] } });
      frame(100);
      expect(
        (calls.render.mock.calls.at(-1)![1] as Camera).quaternion.angleTo(interrupted),
      ).toBeLessThan(1e-6);
      expect(frames.size).toBe(1);
      frame(380);
      expect(frames.size).toBe(0);
      renderer.transition(state);
      renderer.apply(state);
      expect(frames.size).toBe(0);
      renderer.transition(state);
      renderer.dispose();
      expect(frames.size).toBe(0);
    } finally {
      renderer.dispose();
      vi.unstubAllGlobals();
      clock.mockRestore();
    }
  });
  it("keeps the prior snapshot usable if candidate loading fails and never renders partial loads", async () => {
    const h = canvasHarness();
    const renderer = createCadSceneRenderer({ canvas: h.canvas });
    const before = calls.render.mock.calls.length;
    await renderer.load(manifest, async () => geometry());
    expect(calls.render.mock.calls.length).toBe(before);
    renderer.apply(state);
    const failed = { ...manifest, snapshotId: "00000000-0000-4000-8000-000000000002" };
    await expect(
      renderer.load(failed, async () => {
        throw new Error("unavailable");
      }),
    ).rejects.toMatchObject({ reason: "invalid-snapshot" });
    expect(() => renderer.apply(state)).not.toThrow();
    renderer.dispose();
  });
  it("rejects stale captures even when a replacement view has the same semantic revision", async () => {
    const h = canvasHarness();
    const renderer = createCadSceneRenderer({ canvas: h.canvas });
    await renderer.load(manifest, async () => geometry());
    renderer.apply(state);
    const capture = renderer.capture();
    renderer.apply({ ...state, camera: { kind: "preset", preset: "front", fit: [] } });
    h.completeCapture();
    await expect(capture).rejects.toMatchObject({ reason: "superseded" });
    renderer.dispose();
  });
  it("reports context loss and refuses rendering until the host replaces the renderer", async () => {
    const h = canvasHarness();
    const unavailable = vi.fn();
    const renderer = createCadSceneRenderer({ canvas: h.canvas, onUnavailable: unavailable });
    h.canvas.dispatchEvent(new Event("webglcontextlost", { cancelable: true }));
    expect(unavailable).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "renderer-unavailable" }),
    );
    expect(() => renderer.apply(state)).toThrow("renderer-unavailable");
    renderer.dispose();
  });
  it("disposes exactly once and prevents an in-flight load from rebinding afterward", async () => {
    const h = canvasHarness();
    const renderer = createCadSceneRenderer({ canvas: h.canvas });
    let complete: (value: ArrayBuffer) => void = () => {
      throw new Error("Reader not started");
    };
    const loading = renderer.load(
      manifest,
      () =>
        new Promise<ArrayBuffer>((resolve) => {
          complete = resolve;
        }),
    );
    const before = calls.dispose.mock.calls.length;
    renderer.dispose();
    renderer.dispose();
    complete(geometry());
    await expect(loading).rejects.toMatchObject({ reason: "renderer-unavailable" });
    expect(calls.dispose.mock.calls.length).toBe(before + 1);
  });
});

it("uses the same section planes for displayed frames and captures, then clears them on reset", async () => {
  const h = canvasHarness();
  const renderer = createCadSceneRenderer({ canvas: h.canvas });
  try {
    await renderer.load(manifest, async () => geometry());
    renderer.apply({ ...state, sectionPlanes: [{ normal: [0, 0, 1], constant: -0.25 }] });
    const displayed = calls.render.mock.calls.at(-1)![2] as Plane[];
    expect(displayed[0]!.normal.toArray()).toEqual([0, 0, 1]);
    expect(displayed[0]!.constant).toBe(-0.25);
    const capture = renderer.capture();
    h.completeCapture();
    await capture;
    expect(calls.render.mock.calls.at(-1)![2]).toBe(displayed);
    renderer.apply(state);
    expect(calls.render.mock.calls.at(-1)![2]).toEqual([]);
  } finally {
    renderer.dispose();
  }
});

it("cannot verify clipped or translucent targets by choosing an alternate inspection angle", async () => {
  vi.stubGlobal(
    "OffscreenCanvas",
    class {
      getContext() {
        return null;
      }
    },
  );
  const scene = await new GLTFLoader().parseAsync(geometry(), "");
  scene.scene.add(new Mesh(new BoxGeometry(0.02, 0.02, 0.02), new MeshBasicMaterial()));
  const parser = vi.spyOn(GLTFLoader.prototype, "parseAsync").mockResolvedValueOnce(scene);
  const renderer = createCadSceneRenderer({ canvas: canvasHarness().canvas });
  const work = {
    kind: "inspect" as const,
    targets: [{ candidateId: "target", occurrenceId: id, point: [0, 0, 0.01] as const }],
  };
  try {
    await renderer.load(
      { ...manifest, nodes: [{ ...manifest.nodes[0]!, kind: "part", sourcePartKey: geometryKey }] },
      async () => geometry(),
    );
    renderer.resize(800, 600);
    renderer.apply({ ...state, sectionPlanes: [{ normal: [0, 0, -1], constant: -0.02 }] });
    expect(renderer.commentWork(work)[0]?.reason).toBe("occluded");
    const scenePass = calls.render.mock.calls.at(-2)!;
    const markerPass = calls.render.mock.calls.at(-1)!;
    expect(scenePass[2]).toHaveLength(1);
    expect(markerPass[2]).toEqual([]);
    expect(markerPass[0].children[0].children[0].material.color.getHex()).toBe(0xff6262);
    renderer.apply({ ...state, ghost: { occurrenceIds: [id], opacity: 0.2 } });
    expect(renderer.commentWork(work)[0]?.reason).toBe("occluded");
    renderer.apply(state);
    expect(renderer.commentWork(work)[0]?.reason).toBe("visible");
  } finally {
    renderer.dispose();
    parser.mockRestore();
    vi.unstubAllGlobals();
  }
});

it("does not reveal a hidden clipped target or arm review visibility when focus fails", async () => {
  const scene = await new GLTFLoader().parseAsync(geometry(), "");
  scene.scene.add(new Mesh(new BoxGeometry(0.02, 0.02, 0.02), new MeshBasicMaterial()));
  const parser = vi.spyOn(GLTFLoader.prototype, "parseAsync").mockResolvedValueOnce(scene);
  const renderer = createCadSceneRenderer({ canvas: canvasHarness().canvas });
  const hidden: CadViewState = {
    ...state,
    visibility: { [id]: false },
    sectionPlanes: [{ normal: [0, 0, -1], constant: -0.02 }],
  };
  try {
    await renderer.load(
      { ...manifest, nodes: [{ ...manifest.nodes[0]!, kind: "part", sourcePartKey: geometryKey }] },
      async () => geometry(),
    );
    renderer.resize(800, 600);
    renderer.apply(hidden);
    const displayedScene = calls.render.mock.calls.at(-1)![0];
    const visibleMeshes = () => {
      let count = 0;
      displayedScene.traverseVisible((object: unknown) => {
        if (object instanceof Mesh) count++;
      });
      return count;
    };
    expect(visibleMeshes()).toBe(0);
    expect(
      renderer.focusComment(
        {
          kind: "part",
          label: "Hidden part",
          occurrenceId: id,
          preciseLocationLimitation: "Whole part",
        },
        { width: 800, height: 600, centerX: 400, centerY: 300 },
        true,
      ),
    ).toContain("Location clipped");
    expect(visibleMeshes()).toBe(0);
    renderer.apply({ ...hidden, sectionPlanes: [] });
    expect(visibleMeshes()).toBe(0);
  } finally {
    renderer.dispose();
    parser.mockRestore();
  }
});

it("chooses the angle that reveals visible targets even when hidden targets favor another angle", async () => {
  vi.stubGlobal(
    "OffscreenCanvas",
    class {
      getContext() {
        return null;
      }
    },
  );
  const scene = await new GLTFLoader().parseAsync(geometry(), "");
  scene.scene.add(new Mesh(new BoxGeometry(0.02, 0.02, 0.02), new MeshBasicMaterial()));
  const parser = vi.spyOn(GLTFLoader.prototype, "parseAsync").mockResolvedValueOnce(scene);
  const renderer = createCadSceneRenderer({ canvas: canvasHarness().canvas });
  const hiddenIds = ["3".repeat(64), "4".repeat(64)];
  try {
    await renderer.load(
      {
        ...manifest,
        nodes: [id, ...hiddenIds].map((occurrenceId) => ({
          ...manifest.nodes[0]!,
          id: occurrenceId,
          kind: "part" as const,
          sourcePartKey: geometryKey,
        })),
      },
      async () => geometry(),
    );
    renderer.resize(800, 600);
    renderer.apply({
      ...state,
      visibility: Object.fromEntries(hiddenIds.map((id) => [id, false])),
    });
    const hits = renderer.commentWork({
      kind: "inspect",
      targets: [
        { candidateId: "underside", occurrenceId: id, point: [0, 0, -0.01] },
        ...hiddenIds.map((occurrenceId) => ({
          candidateId: occurrenceId,
          occurrenceId,
          point: [0, 0, 0.01] as const,
        })),
      ],
    });
    expect(hits.map((hit) => hit.reason)).toEqual(["visible", "occluded", "occluded"]);
  } finally {
    renderer.dispose();
    parser.mockRestore();
    vi.unstubAllGlobals();
  }
});
