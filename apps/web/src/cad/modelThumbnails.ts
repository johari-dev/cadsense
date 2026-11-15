import { useAtomValue } from "@effect/atom-react";
import { resolveAssetUrl } from "@cadsense/client-runtime/state/assets";
import {
  CAD_BACKDROP_MAX_DATA_URL_LENGTH,
  CAD_THUMBNAIL_MAX_DATA_URL_LENGTH,
  type AssetCreateUrlResult,
  type EnvironmentId,
} from "@cadsense/contracts";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { cadThumbnailUrl, type CadPreviewKind } from "../state/cadThumbnails";
import { usePreparedConnection } from "../state/session";
import type { CadOverviewRegion, CadSceneRenderer } from "./CadSceneRenderer";

/** Largest side a thumbnail is captured for, in CSS pixels. The sidebar shows it far smaller. */
const DISPLAY_SIZE = 132;
/** Longest data URL kept, in characters: about 60 KB of image. */
const THUMBNAIL_BUDGET = CAD_THUMBNAIL_MAX_DATA_URL_LENGTH;
/** Longest side the overview is scaled to before scanning it for the model's pixels. */
const SCAN_SIZE = 256;
/** Summed RGB difference from the background that counts as part of the model. */
const MODEL_PIXEL_THRESHOLD = 12;
/** Space kept around the model, as a share of its larger side. */
const MARGIN = 0.08;
/** Longest backdrop data URL kept, in characters: about 300 KB of image. */
const BACKDROP_BUDGET = CAD_BACKDROP_MAX_DATA_URL_LENGTH;
/**
 * Longest side a backdrop is drawn at, in pixels. The CAD panel's viewport is drawn at this size
 * for the capture, whatever size the panel is, and zoomed in on the model, because the new
 * thread view shows the model up to 860 CSS pixels tall on displays of twice that density.
 */
const BACKDROP_OVERVIEW_SIZE = 2048;
/** Longest side the plain overview is scaled to when a backdrop capture looks for the model. */
const BACKDROP_LOCATE_SIZE = 512;
/** Room the zoomed capture keeps around the model, as a share of the model's larger side. */
const BACKDROP_REGION_MARGIN = 0.04;
/** Sizes a backdrop is tried at, largest first, until one fits BACKDROP_BUDGET. */
const BACKDROP_SCALES = [1, 0.75, 0.5];
/** Alpha, out of 255, above which a cutout pixel counts as part of the model. */
const CUTOUT_ALPHA_THRESHOLD = 8;
/**
 * Mean brightness, 0 to 1, a dark model is brightened toward, and the most it is multiplied by.
 * A pixel's brightness is its strongest channel, so a saturated red part is bright, not dark.
 */
const BACKDROP_TARGET_BRIGHTNESS = 0.65;
const BACKDROP_MAX_GAIN = 1.8;

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
 * One of a CAD snapshot's server-saved preview images, the thumbnail unless `kind` says the
 * backdrop: its URL once one exists, and whether the server reported none, so the CAD panel
 * knows to capture it.
 */
export function useModelThumbnail(
  environmentId: EnvironmentId,
  snapshotId: string | undefined,
  kind: CadPreviewKind = "thumbnail",
) {
  const connection = usePreparedConnection(environmentId);
  const query: Atom.Atom<AsyncResult.AsyncResult<AssetCreateUrlResult, unknown>> = snapshotId
    ? cadThumbnailUrl(environmentId, snapshotId, kind)
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
 * Captures one preview image of the already loaded scene and saves it to the server, at most
 * once per snapshot, kind, and page load. `capture` returns the image as a data URL, or null
 * when there is nothing worth saving.
 */
async function saveModelImage(
  key: string,
  snapshotId: string,
  renderer: CadSceneRenderer,
  capture: () => Promise<string | null>,
  save: (image: string) => Promise<boolean>,
): Promise<void> {
  if (pending.has(key) || saved.has(key)) return;
  pending.add(key);
  try {
    // Let the panel's first layout and appearance pass settle before drawing the overview.
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
    if (renderer.displayedManifest()?.snapshotId !== snapshotId) return;
    const image = await capture();
    if (image && (await save(image))) saved.add(key);
  } catch {
    // A moving or unloaded scene can fail the capture. Keep the placeholder until the next load.
  } finally {
    pending.delete(key);
  }
}

/**
 * Saves a square preview of the already loaded scene to the server, framed on the model rather
 * than on the user's camera. Call it only while `useModelThumbnail` reports the snapshot missing;
 * each snapshot is captured at most once per page load. Never loads CAD just for a thumbnail.
 */
export const saveModelThumbnail = (
  environmentId: string,
  snapshotId: string,
  renderer: CadSceneRenderer,
  save: (image: string) => Promise<boolean>,
): Promise<void> =>
  saveModelImage(
    `thumbnail:${environmentId}:${snapshotId}`,
    snapshotId,
    renderer,
    async () => {
      const bitmap = await createImageBitmap(await renderer.captureOverview());
      try {
        const frame = modelFrame(bitmap);
        if (!frame) return null;
        // Twice the displayed size in device pixels, so the preview stays sharp when scaled.
        const size = Math.min(640, Math.max(256, Math.round(DISPLAY_SIZE * 2 * devicePixelRatio)));
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = size;
        const context = canvas.getContext("2d");
        if (!context) return null;
        context.fillStyle = frame.background;
        context.fillRect(0, 0, size, size);
        context.imageSmoothingQuality = "high";
        // Source rectangles past the image edge are clipped, leaving the background fill there.
        context.drawImage(bitmap, frame.x, frame.y, frame.size, frame.size, 0, 0, size, size);
        return encodeThumbnail(canvas, THUMBNAIL_BUDGET);
      } finally {
        bitmap.close();
      }
    },
    save,
  );

/**
 * Saves the new thread backdrop of the already loaded scene to the server: the whole model on a
 * transparent background, cropped to the model, with a dark model brightened. Call it only while
 * `useModelThumbnail` reports the snapshot's backdrop missing; each snapshot is captured at most
 * once per page load. Saves nothing where the browser cannot encode WebP, the one format here
 * that keeps transparency within the size cap. Never loads CAD just for a backdrop.
 */
export const saveModelBackdrop = (
  environmentId: string,
  snapshotId: string,
  renderer: CadSceneRenderer,
  save: (image: string) => Promise<boolean>,
): Promise<void> =>
  saveModelImage(
    `backdrop:${environmentId}:${snapshotId}`,
    snapshotId,
    renderer,
    async () => {
      // The model fills only part of the overview, so find it first, then draw just that part
      // at full size.
      const located = await readCutout(
        await renderer.captureOverviewMattes(),
        BACKDROP_LOCATE_SIZE,
      );
      const found = located && cutoutBounds(located.data, located.width, located.height);
      if (!found || renderer.displayedManifest()?.snapshotId !== snapshotId) return null;
      const cutout = await readCutout(
        await renderer.captureOverviewMattes({
          longSide: BACKDROP_OVERVIEW_SIZE,
          region: backdropRegion(found, located.width, located.height),
        }),
        BACKDROP_OVERVIEW_SIZE,
      );
      const bounds = cutout && cutoutBounds(cutout.data, cutout.width, cutout.height);
      if (!bounds) return null;
      liftDarkCutout(cutout.data);
      cutout.context.putImageData(new ImageData(cutout.data, cutout.width, cutout.height), 0, 0);
      // A detailed model can be too large for the budget at full size, so step the size down.
      for (const size of BACKDROP_SCALES) {
        const cropped = document.createElement("canvas");
        cropped.width = Math.max(1, Math.round(bounds.width * size));
        cropped.height = Math.max(1, Math.round(bounds.height * size));
        const context = cropped.getContext("2d");
        if (!context) return null;
        context.imageSmoothingQuality = "high";
        context.drawImage(
          cutout.canvas,
          bounds.x,
          bounds.y,
          bounds.width,
          bounds.height,
          0,
          0,
          cropped.width,
          cropped.height,
        );
        const image = encodeThumbnail(cropped, BACKDROP_BUDGET, true);
        if (image) return image;
      }
      return null;
    },
    save,
  );

/**
 * Decodes an overview's black and white mattes into a transparent cutout, scaled down so its
 * longer side is at most `maxSide`: the canvas it was read through, and its straight-alpha RGBA
 * pixels. The canvas does not hold the cutout until the caller puts the pixels back.
 */
async function readCutout(mattes: { black: Blob; white: Blob }, maxSide: number) {
  const [black, white] = await Promise.all([
    createImageBitmap(mattes.black),
    createImageBitmap(mattes.white),
  ]);
  try {
    const scale = Math.min(1, maxSide / Math.max(black.width, black.height));
    const width = Math.max(1, Math.round(black.width * scale));
    const height = Math.max(1, Math.round(black.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) return null;
    context.imageSmoothingQuality = "high";
    const read = (bitmap: ImageBitmap) => {
      context.clearRect(0, 0, width, height);
      context.drawImage(bitmap, 0, 0, width, height);
      return context.getImageData(0, 0, width, height).data;
    };
    return { canvas, context, width, height, data: cutoutFromMattes(read(black), read(white)) };
  } finally {
    black.close();
    white.close();
  }
}

/**
 * The part of an overview to draw large for a backdrop: centered on the model's `bounds` in an
 * overview `width` by `height` pixels, covering the model's larger share of the frame plus a
 * margin, and the same share on both axes so the zoomed picture keeps the overview's shape.
 */
export function backdropRegion(
  bounds: { x: number; y: number; width: number; height: number },
  width: number,
  height: number,
): CadOverviewRegion {
  const side =
    Math.max(bounds.width / width, bounds.height / height) * (1 + BACKDROP_REGION_MARGIN * 2);
  return {
    x: (bounds.x + bounds.width / 2) / width - side / 2,
    y: (bounds.y + bounds.height / 2) / height - side / 2,
    width: side,
    height: side,
  };
}

/**
 * Recovers a transparent picture from the same picture drawn on black and on white, both as
 * RGBA pixels. A pixel the model covers is equal in both, an empty pixel differs by the full
 * range, and an antialiased edge falls in between: that difference is the missing alpha, and
 * the black matte holds the color already multiplied by it. Returns straight-alpha RGBA pixels.
 */
export function cutoutFromMattes(
  black: Uint8ClampedArray,
  white: Uint8ClampedArray,
): Uint8ClampedArray<ArrayBuffer> {
  const cutout = new Uint8ClampedArray(black.length);
  for (let i = 0; i < black.length; i += 4) {
    const difference =
      white[i]! - black[i]! + (white[i + 1]! - black[i + 1]!) + (white[i + 2]! - black[i + 2]!);
    const alpha = Math.min(255, Math.max(0, 255 - Math.round(difference / 3)));
    if (alpha === 0) continue;
    // Uint8ClampedArray rounds and clamps each write to 0..255.
    cutout[i] = (black[i]! * 255) / alpha;
    cutout[i + 1] = (black[i + 1]! * 255) / alpha;
    cutout[i + 2] = (black[i + 2]! * 255) / alpha;
    cutout[i + 3] = alpha;
  }
  return cutout;
}

/** The box around every pixel of a cutout that is visibly part of the model, or null if none. */
export function cutoutBounds(data: Uint8ClampedArray, width: number, height: number) {
  let left = width,
    right = -1,
    top = height,
    bottom = -1;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3]! <= CUTOUT_ALPHA_THRESHOLD) continue;
      left = Math.min(left, x);
      right = Math.max(right, x);
      top = Math.min(top, y);
      bottom = Math.max(bottom, y);
    }
  if (right < 0) return null;
  return { x: left, y: top, width: right - left + 1, height: bottom - top + 1 };
}

/**
 * Brightens a dark model in place, so it does not sink into the dark canvas behind the new
 * thread view. The gain brings the model's mean brightness up to BACKDROP_TARGET_BRIGHTNESS, is
 * never below 1, and stops at BACKDROP_MAX_GAIN. Empty space does not count toward the mean. A
 * pixel takes less gain when more would clip its strongest channel, which keeps its hue.
 */
export function liftDarkCutout(data: Uint8ClampedArray): void {
  let brightness = 0;
  let coverage = 0;
  for (let i = 0; i < data.length; i += 4) {
    const alpha = data[i + 3]!;
    brightness += Math.max(data[i]!, data[i + 1]!, data[i + 2]!) * alpha;
    coverage += alpha;
  }
  if (coverage === 0) return;
  const mean = brightness / coverage / 255;
  const gain = Math.min(BACKDROP_MAX_GAIN, BACKDROP_TARGET_BRIGHTNESS / Math.max(mean, 1e-6));
  if (gain <= 1) return;
  for (let i = 0; i < data.length; i += 4) {
    const strongest = Math.max(data[i]!, data[i + 1]!, data[i + 2]!);
    if (strongest === 0) continue;
    const pixelGain = Math.min(gain, 255 / strongest);
    data[i] = data[i]! * pixelGain;
    data[i + 1] = data[i + 1]! * pixelGain;
    data[i + 2] = data[i + 2]! * pixelGain;
  }
}

/**
 * WebP where the browser encodes it (Chromium and Electron do), else JPEG, at the best quality
 * that fits `budget` characters. Null if even the lowest quality is too large, or if the image
 * is `transparent` and the browser can only encode JPEG, which has no alpha.
 */
function encodeThumbnail(canvas: HTMLCanvasElement, budget: number, transparent = false) {
  const type = canvas.toDataURL("image/webp", 0.5).startsWith("data:image/webp")
    ? "image/webp"
    : "image/jpeg";
  if (transparent && type !== "image/webp") return null;
  for (const quality of [0.88, 0.75, 0.6]) {
    const image = canvas.toDataURL(type, quality);
    if (image.length <= budget) return image;
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
