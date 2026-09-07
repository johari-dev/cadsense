import { CadSnapshotManifest, type CadViewState } from "@cadsense/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it, vi } from "vite-plus/test";
import { createCadSceneRenderer } from "./CadSceneRenderer";
import { Camera, Matrix4, Quaternion, Vector3 } from "three";

const calls = vi.hoisted(() => ({ render: vi.fn(), dispose: vi.fn(), forceContextLoss: vi.fn() }));
vi.mock("three", async (importOriginal) => {
  const actual = await importOriginal<typeof import("three")>();
  return {
    ...actual,
    WebGLRenderer: class {
      outputColorSpace = "";
      setClearColor() {}
      setPixelRatio() {}
      setSize() {}
      getContext() {
        return { isContextLost: () => false };
      }
      render(scene: unknown, camera: Camera) {
        camera.updateMatrixWorld();
        calls.render(scene, camera);
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
      renderer.transition({ ...state, camera: { kind: "preset", preset: "back", fit: [] } });
      expect(frames.size).toBe(1);
      frame(performance.now() + 120);
      expect(frames.size).toBe(1);
      const destinationRotation = new Quaternion().setFromRotationMatrix(
        new Matrix4().lookAt(new Vector3(0, 1, 0), new Vector3(), new Vector3(0, 0, 1)),
      );
      const halfway = (calls.render.mock.calls.at(-1)![1] as Camera).quaternion;
      expect(halfway.angleTo(initialRotation.slerp(destinationRotation, 0.5))).toBeLessThan(1e-6);
      frame(performance.now() + 300);
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
