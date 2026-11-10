import { AssetCadThumbnailNotFoundError } from "@cadsense/contracts";
import { EnvironmentRpcUnavailableError } from "@cadsense/client-runtime/rpc";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";
import { describe, expect, it } from "vite-plus/test";
import {
  backdropRegion,
  cutoutBounds,
  cutoutFromMattes,
  isModelThumbnailMissing,
  liftDarkCutout,
} from "./modelThumbnails";

const snapshotId = "00000000-0000-4000-8000-000000000001";

describe("isModelThumbnailMissing", () => {
  it("is true only when the server says the snapshot has no thumbnail", () => {
    expect(
      isModelThumbnailMissing(
        AsyncResult.failure(
          Cause.fail(
            new AssetCadThumbnailNotFoundError({ resource: { _tag: "cad-thumbnail", snapshotId } }),
          ),
        ),
      ),
    ).toBe(true);
  });

  it("never asks for a capture while the answer is unknown or the thumbnail exists", () => {
    expect(isModelThumbnailMissing(AsyncResult.initial())).toBe(false);
    expect(isModelThumbnailMissing(AsyncResult.initial(true))).toBe(false);
    expect(
      isModelThumbnailMissing(
        AsyncResult.success({ relativeUrl: "/api/assets/t/x", expiresAt: 1 }),
      ),
    ).toBe(false);
    // Offline or unauthorized is not "missing": capturing would only fail to upload.
    expect(
      isModelThumbnailMissing(
        AsyncResult.failure(
          Cause.fail(
            new EnvironmentRpcUnavailableError({ environmentId: "local", message: "offline" }),
          ),
        ),
      ),
    ).toBe(false);
  });
});

const pixels = (...rgba: number[][]) => new Uint8ClampedArray(rgba.flat());

// Ways the backdrop cutout can go wrong: empty space stays visible, a black or white part turns
// transparent, an antialiased edge keeps a fringe of the matte color, or rounding overflows.
describe("cutoutFromMattes", () => {
  it("clears pixels the model does not cover", () => {
    const cutout = cutoutFromMattes(pixels([0, 0, 0, 255]), pixels([255, 255, 255, 255]));
    expect(Array.from(cutout)).toEqual([0, 0, 0, 0]);
  });

  it("keeps covered pixels opaque and unchanged, including black and white parts", () => {
    const covered = pixels([0, 0, 0, 255], [255, 255, 255, 255], [200, 90, 30, 255]);
    expect(Array.from(cutoutFromMattes(covered, covered))).toEqual(Array.from(covered));
  });

  it("recovers the part's own color on a half-covered edge", () => {
    // A pure red part covering half the pixel: half red on black, half red plus half white on white.
    const cutout = cutoutFromMattes(pixels([128, 0, 0, 255]), pixels([255, 127, 127, 255]));
    expect(cutout[3]).toBeGreaterThanOrEqual(127);
    expect(cutout[3]).toBeLessThanOrEqual(129);
    expect(cutout[0]).toBeGreaterThanOrEqual(253);
    expect(cutout[1]).toBe(0);
    expect(cutout[2]).toBe(0);
  });

  it("stays in range when rounding leaves the white matte a step darker than the black one", () => {
    const cutout = cutoutFromMattes(pixels([120, 120, 120, 255]), pixels([119, 120, 119, 255]));
    expect(Array.from(cutout)).toEqual([120, 120, 120, 255]);
  });
});

// Ways the frame can go wrong: it keeps the empty viewport around the model, a faint stray
// pixel stretches it, or an empty capture yields a box.
describe("cutoutBounds", () => {
  it("boxes the visible pixels and ignores faint strays", () => {
    // 4x3 image: one solid pixel at (1, 1), one at (2, 2), and a near-invisible one at (3, 0).
    const data = new Uint8ClampedArray(4 * 3 * 4);
    data[(1 * 4 + 1) * 4 + 3] = 255;
    data[(2 * 4 + 2) * 4 + 3] = 200;
    data[3 * 4 + 3] = 4;
    expect(cutoutBounds(data, 4, 3)).toEqual({ x: 1, y: 1, width: 2, height: 2 });
  });

  it("is null when nothing is drawn", () => {
    expect(cutoutBounds(new Uint8ClampedArray(4 * 3 * 4), 4, 3)).toBeNull();
  });
});

// Ways the zoomed capture's framing can go wrong: it stretches the model, clips it, leaves it
// off center, or leaves most of the frame empty again.
describe("backdropRegion", () => {
  // A 200x100 overview with the model in a 60x40 box whose corner is at (100, 20).
  const region = backdropRegion({ x: 100, y: 20, width: 60, height: 40 }, 200, 100);

  it("covers the same share of the frame on both axes, so nothing stretches", () => {
    expect(region.width).toBeCloseTo(region.height, 10);
  });

  it("holds the whole model with a little room around it", () => {
    // The model spans 0.5..0.8 across and 0.2..0.6 down.
    expect(region.x).toBeLessThan(0.5);
    expect(region.x + region.width).toBeGreaterThan(0.8);
    expect(region.y).toBeLessThan(0.2);
    expect(region.y + region.height).toBeGreaterThan(0.6);
  });

  it("centers on the model", () => {
    expect(region.x + region.width / 2).toBeCloseTo(0.65, 10);
    expect(region.y + region.height / 2).toBeCloseTo(0.4, 10);
  });

  it("is tight: the model's longer share fills nearly all of it", () => {
    // 40 of 100 rows is the larger share, so the region is only a little over 0.4 of the frame.
    expect(region.height).toBeLessThan(0.45);
  });
});

// Ways the lift can go wrong: empty space counts as dark and brightens a bright model, a dark
// model stays dark, the gain runs away on a near-black model, it changes transparency, a strongly
// colored part counts as dark, or a clipped channel shifts a part's hue.
describe("liftDarkCutout", () => {
  it("does not take a strongly colored model for a dark one", () => {
    // Pure red has low luminance, but nobody would call a red bracket dark.
    const data = pixels([204, 0, 0, 255]);
    liftDarkCutout(data);
    expect(Array.from(data)).toEqual([204, 0, 0, 255]);
  });

  it("keeps a part's hue when the gain would clip one of its channels", () => {
    // One orange part on a mostly near-black model, which earns the full gain.
    const dark = Array.from({ length: 9 }, () => [20, 20, 20, 255]);
    const data = pixels([200, 100, 0, 255], ...dark);
    liftDarkCutout(data);
    expect(data[0]).toBeGreaterThan(200);
    expect(data[1]! / data[0]!).toBeGreaterThan(0.48);
    expect(data[1]! / data[0]!).toBeLessThan(0.52);
  });

  it("leaves a bright model alone however much empty space surrounds it", () => {
    const data = pixels([230, 230, 230, 255], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]);
    liftDarkCutout(data);
    expect(Array.from(data.slice(0, 4))).toEqual([230, 230, 230, 255]);
  });

  it("brightens a dark model without touching alpha", () => {
    const data = pixels([60, 60, 60, 255], [60, 60, 60, 128]);
    liftDarkCutout(data);
    expect(data[0]).toBeGreaterThan(60);
    expect(data[3]).toBe(255);
    expect(data[7]).toBe(128);
  });

  it("caps the gain, so a near-black model does not wash out to gray", () => {
    const data = pixels([10, 10, 10, 255]);
    liftDarkCutout(data);
    expect(data[0]).toBeLessThanOrEqual(18);
  });

  it("does nothing to an empty image", () => {
    const data = pixels([0, 0, 0, 0]);
    liftDarkCutout(data);
    expect(Array.from(data)).toEqual([0, 0, 0, 0]);
  });
});
