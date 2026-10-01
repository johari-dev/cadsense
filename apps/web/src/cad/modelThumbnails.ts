import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { resolveStorage } from "../lib/storage";
import type { CadSceneRenderer } from "./CadSceneRenderer";

const MAX_THUMBNAILS = 24;
export const modelThumbnailKey = (environmentId: string, snapshotId: string) =>
  `${environmentId}:${snapshotId}`;

export const useModelThumbnails = create(
  persist(() => ({ images: {} as Record<string, string> }), {
    name: "cadsense:model-thumbnails",
    storage: createJSONStorage(() =>
      resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
    ),
  }),
);

const pending = new Set<string>();

/** Cache a small preview from the already loaded scene; never load CAD just for a thumbnail. */
export async function captureModelThumbnail(
  environmentId: string,
  snapshotId: string,
  renderer: CadSceneRenderer,
): Promise<void> {
  const key = modelThumbnailKey(environmentId, snapshotId);
  if (pending.has(key) || useModelThumbnails.getState().images[key]) return;
  pending.add(key);
  try {
    let captured: Blob | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      // The first layout and appearance pass can invalidate a capture from the load callback.
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      );
      if (renderer.displayedManifest()?.snapshotId !== snapshotId) return;
      try {
        captured = await renderer.capture();
        break;
      } catch {
        // Retry after layout settles; a user interaction can supersede this frame too.
      }
    }
    if (!captured) return;
    const bitmap = await createImageBitmap(captured);
    try {
      const canvas = document.createElement("canvas");
      canvas.width = 160;
      canvas.height = 120;
      const context = canvas.getContext("2d");
      if (!context) return;
      context.fillStyle = "#262626";
      context.fillRect(0, 0, 160, 120);
      const scale = Math.min(160 / bitmap.width, 120 / bitmap.height);
      const width = bitmap.width * scale;
      const height = bitmap.height * scale;
      context.drawImage(bitmap, (160 - width) / 2, (120 - height) / 2, width, height);
      const entries = Object.entries(useModelThumbnails.getState().images).slice(
        -(MAX_THUMBNAILS - 1),
      );
      useModelThumbnails.setState({
        images: { ...Object.fromEntries(entries), [key]: canvas.toDataURL("image/jpeg", 0.8) },
      });
    } finally {
      bitmap.close();
    }
  } catch {
    // A moving or unloaded scene can supersede capture. Keep the project icon until the next load.
  } finally {
    pending.delete(key);
  }
}
