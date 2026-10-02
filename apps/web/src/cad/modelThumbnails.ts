import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { resolveStorage } from "../lib/storage";
import type { CadSceneRenderer } from "./CadSceneRenderer";

const MAX_THUMBNAILS = 24;
const THUMBNAIL_SIZE = 128;
/** Longest side the overview is scaled to before scanning it for the model's pixels. */
const SCAN_SIZE = 256;
/** Summed RGB difference from the background that counts as part of the model. */
const MODEL_PIXEL_THRESHOLD = 12;
/** Space kept around the model, as a share of its larger side. */
const MARGIN = 0.08;

export const modelThumbnailKey = (environmentId: string, snapshotId: string) =>
  `${environmentId}:${snapshotId}`;

export const useModelThumbnails = create(
  persist(() => ({ images: {} as Record<string, string> }), {
    name: "cadsense:model-thumbnails",
    // Version 0 thumbnails copied the live camera, so many were off-center. Drop them.
    version: 1,
    migrate: () => ({ images: {} }),
    storage: createJSONStorage(() =>
      resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
    ),
  }),
);

const pending = new Set<string>();

/**
 * Cache a square preview of the already loaded scene, framed on the model rather than on the
 * user's camera. Never loads CAD just for a thumbnail.
 */
export async function captureModelThumbnail(
  environmentId: string,
  snapshotId: string,
  renderer: CadSceneRenderer,
): Promise<void> {
  const key = modelThumbnailKey(environmentId, snapshotId);
  if (pending.has(key) || useModelThumbnails.getState().images[key]) return;
  pending.add(key);
  try {
    // Let the panel's first layout and appearance pass settle before drawing the overview.
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
    if (renderer.displayedManifest()?.snapshotId !== snapshotId) return;
    const bitmap = await createImageBitmap(await renderer.captureOverview());
    try {
      const frame = modelFrame(bitmap);
      if (!frame) return;
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = THUMBNAIL_SIZE;
      const context = canvas.getContext("2d");
      if (!context) return;
      context.fillStyle = frame.background;
      context.fillRect(0, 0, THUMBNAIL_SIZE, THUMBNAIL_SIZE);
      // Source rectangles past the image edge are clipped, leaving the background fill there.
      context.drawImage(
        bitmap,
        frame.x,
        frame.y,
        frame.size,
        frame.size,
        0,
        0,
        THUMBNAIL_SIZE,
        THUMBNAIL_SIZE,
      );
      const entries = Object.entries(useModelThumbnails.getState().images).slice(
        -(MAX_THUMBNAILS - 1),
      );
      useModelThumbnails.setState({
        images: { ...Object.fromEntries(entries), [key]: canvas.toDataURL("image/jpeg", 0.85) },
      });
    } finally {
      bitmap.close();
    }
  } catch {
    // A moving or unloaded scene can fail the capture. Keep the project icon until the next load.
  } finally {
    pending.delete(key);
  }
}

/**
 * Finds the square, in overview pixels, centered on the model's silhouette. The overview's
 * corner is always background because the fitted camera leaves room around the model.
 */
function modelFrame(bitmap: ImageBitmap) {
  const scale = Math.min(1, SCAN_SIZE / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const probe = document.createElement("canvas");
  probe.width = width;
  probe.height = height;
  const context = probe.getContext("2d", { willReadFrequently: true });
  if (!context) return null;
  context.drawImage(bitmap, 0, 0, width, height);
  const { data } = context.getImageData(0, 0, width, height);
  const [red = 0, green = 0, blue = 0] = data;
  let left = width,
    right = -1,
    top = height,
    bottom = -1;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const difference =
        Math.abs(data[i]! - red) + Math.abs(data[i + 1]! - green) + Math.abs(data[i + 2]! - blue);
      if (difference <= MODEL_PIXEL_THRESHOLD) continue;
      left = Math.min(left, x);
      right = Math.max(right, x);
      top = Math.min(top, y);
      bottom = Math.max(bottom, y);
    }
  if (right < 0) return null;
  const size = (Math.max(right - left, bottom - top) * (1 + MARGIN * 2)) / scale;
  return {
    background: `rgb(${red} ${green} ${blue})`,
    x: (left + right) / 2 / scale - size / 2,
    y: (top + bottom) / 2 / scale - size / 2,
    size,
  };
}
