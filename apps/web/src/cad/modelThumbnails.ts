import { useAtomValue } from "@effect/atom-react";
import { resolveAssetUrl } from "@cadsense/client-runtime/state/assets";
import {
  CAD_THUMBNAIL_MAX_DATA_URL_LENGTH,
  type AssetCreateUrlResult,
  type EnvironmentId,
} from "@cadsense/contracts";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { cadThumbnailUrl } from "../state/cadThumbnails";
import { usePreparedConnection } from "../state/session";
import type { CadSceneRenderer } from "./CadSceneRenderer";

/** Largest side a thumbnail is shown at, in CSS pixels (the 176x132 home preview's height). */
const DISPLAY_SIZE = 132;
/** Longest data URL kept, in characters: about 60 KB of image. */
const THUMBNAIL_BUDGET = CAD_THUMBNAIL_MAX_DATA_URL_LENGTH;
/** Longest side the overview is scaled to before scanning it for the model's pixels. */
const SCAN_SIZE = 256;
/** Summed RGB difference from the background that counts as part of the model. */
const MODEL_PIXEL_THRESHOLD = 12;
/** Space kept around the model, as a share of its larger side. */
const MARGIN = 0.08;

// Thumbnails used to be kept in each origin's localStorage. The server keeps them now.
try {
  globalThis.localStorage?.removeItem("cadsense:model-thumbnails");
} catch {
  // Storage can be unavailable; the old entry is only wasted space.
}

/** True only when the server answered that the snapshot has no saved thumbnail. */
export const isModelThumbnailMissing = (result: AsyncResult.AsyncResult<unknown, unknown>) =>
  AsyncResult.isFailure(result) &&
  Predicate.isTagged(Cause.squash(result.cause), "AssetCadThumbnailNotFoundError");

const NO_THUMBNAIL = Atom.make(AsyncResult.initial<AssetCreateUrlResult, unknown>()).pipe(
  Atom.withLabel("cad-thumbnail:none"),
);

/**
 * The server-saved thumbnail of a CAD snapshot: its URL once one exists, and whether the server
 * reported none, so the CAD panel knows to capture it.
 */
export function useModelThumbnail(environmentId: EnvironmentId, snapshotId: string | undefined) {
  const connection = usePreparedConnection(environmentId);
  const query: Atom.Atom<AsyncResult.AsyncResult<AssetCreateUrlResult, unknown>> = snapshotId
    ? cadThumbnailUrl(environmentId, snapshotId)
    : NO_THUMBNAIL;
  const result = useAtomValue(query);
  return {
    url:
      AsyncResult.isSuccess(result) && Option.isSome(connection)
        ? resolveAssetUrl(connection.value.httpBaseUrl, result.value.relativeUrl)
        : null,
    missing: isModelThumbnailMissing(result),
  };
}

const pending = new Set<string>();
const saved = new Set<string>();

/**
 * Saves a square preview of the already loaded scene to the server, framed on the model rather
 * than on the user's camera. Call it only while `useModelThumbnail` reports the snapshot missing;
 * each snapshot is captured at most once per page load. Never loads CAD just for a thumbnail.
 */
export async function saveModelThumbnail(
  environmentId: string,
  snapshotId: string,
  renderer: CadSceneRenderer,
  save: (image: string) => Promise<boolean>,
): Promise<void> {
  const key = `${environmentId}:${snapshotId}`;
  if (pending.has(key) || saved.has(key)) return;
  pending.add(key);
  try {
    // Let the panel's first layout and appearance pass settle before drawing the overview.
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
    if (renderer.displayedManifest()?.snapshotId !== snapshotId) return;
    const bitmap = await createImageBitmap(await renderer.captureOverview());
    let image: string | null = null;
    try {
      const frame = modelFrame(bitmap);
      if (!frame) return;
      // Twice the displayed size in device pixels, so the preview stays sharp when scaled.
      const size = Math.min(640, Math.max(256, Math.round(DISPLAY_SIZE * 2 * devicePixelRatio)));
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = size;
      const context = canvas.getContext("2d");
      if (!context) return;
      context.fillStyle = frame.background;
      context.fillRect(0, 0, size, size);
      context.imageSmoothingQuality = "high";
      // Source rectangles past the image edge are clipped, leaving the background fill there.
      context.drawImage(bitmap, frame.x, frame.y, frame.size, frame.size, 0, 0, size, size);
      image = encodeThumbnail(canvas);
    } finally {
      bitmap.close();
    }
    if (image && (await save(image))) saved.add(key);
  } catch {
    // A moving or unloaded scene can fail the capture. Keep the project icon until the next load.
  } finally {
    pending.delete(key);
  }
}

/**
 * WebP where the browser encodes it (Chromium and Electron do), else JPEG, at the best quality
 * that fits THUMBNAIL_BUDGET. Null if even the lowest quality is too large.
 */
function encodeThumbnail(canvas: HTMLCanvasElement) {
  const type = canvas.toDataURL("image/webp", 0.5).startsWith("data:image/webp")
    ? "image/webp"
    : "image/jpeg";
  for (const quality of [0.88, 0.75, 0.6]) {
    const image = canvas.toDataURL(type, quality);
    if (image.length <= THUMBNAIL_BUDGET) return image;
  }
  return null;
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
