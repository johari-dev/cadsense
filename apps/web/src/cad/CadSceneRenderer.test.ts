import { CadSnapshotManifest, type CadViewState } from "@cadsense/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it, vi } from "vite-plus/test";
import { createCadSceneRenderer } from "./CadSceneRenderer";

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
      render = calls.render;
      dispose = calls.dispose;
      forceContextLoss = calls.forceContextLoss;
    },
  };
});
vi.mock("three/addons/controls/OrbitControls.js", async () => {
  const { EventDispatcher, Vector3 } = await import("three");
  return {
    OrbitControls: class extends EventDispatcher {
      constructor(public object: unknown) {
        super();
      }
      target = new Vector3();
      enabled = false;
      enableDamping = false;
      autoRotate = false;
      update() {}
      dispose() {}
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
      byteLength: 4,
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
    toBlob: (callback: BlobCallback) => {
      captureCallback = callback;
    },
  }) as HTMLCanvasElement;
  return {
    canvas,
    completeCapture: () => captureCallback?.(new Blob(["png"], { type: "image/png" })),
  };
};

describe("CAD renderer lifecycle without WebGL", () => {
  it("keeps the prior snapshot usable if candidate loading fails and never renders partial loads", async () => {
    const h = canvasHarness();
    const renderer = createCadSceneRenderer({ canvas: h.canvas });
    const before = calls.render.mock.calls.length;
    await renderer.load(manifest, async () => new ArrayBuffer(4));
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
    await renderer.load(manifest, async () => new ArrayBuffer(4));
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
    complete(new ArrayBuffer(4));
    await expect(loading).rejects.toMatchObject({ reason: "renderer-unavailable" });
    expect(calls.dispose.mock.calls.length).toBe(before + 1);
  });
});
