import type { DriveCatalog } from "./CadDriveCatalog.ts";

// A catalog with ReCalc's tooth counts (October 2026) for drive-option tests, so they never touch
// the network. Every wheel comes in 1/2" hex; small ones also come in a motor's SplineXS bore.

const range = (from: number, to: number, step = 1) =>
  Array.from({ length: Math.floor((to - from) / step) + 1 }, (_, i) => from + i * step);
const listing = (vendor: string, key: string) => ({
  vendor,
  sku: `${vendor}-${key}`,
  url: `https://example.com/${vendor}/${key}`,
});
const bores = (teeth: number) => (teeth <= 14 ? ["SplineXS", '1/2" Hex'] : ['1/2" Hex']);

const GEARS_20DP = [
  6, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 24, 25, 26, 27, 28, 29, 30, 32, 34,
  35, 36, 38, 40, 42, 43, 44, 45, 46, 48, 50, 52, 54, 56, 58, 60, 62, 64, 66, 68, 70, 72, 74, 76,
  78, 80, 82, 84,
];
const GEARS_32DP = [12, 15, 19, 20, 32, 35, 40, 45, 60, 80, 85, 100];
const PULLEYS: ReadonlyArray<readonly [string, number, readonly number[]]> = [
  ["HTD", 5, [11, 12, 14, 15, 16, 18, 20, 24, 30, 36, 42, 48]],
  ["GT2", 3, [12, 16, 24, 36, 48, 60]],
  ["RT25", 6.35, [12, 16, 24, 32, 40, 48, 56, 64]],
];
const BELTS: ReadonlyArray<readonly [string, number, readonly number[]]> = [
  ["HTD", 5, range(24, 300)],
  ["GT2", 3, range(29, 400)],
  ["RT25", 6.35, range(32, 216, 8)],
];
const SPROCKETS: ReadonlyArray<readonly [string, readonly number[]]> = [
  [
    "#25",
    [
      8, 9, 10, 12, 14, 16, 17, 18, 20, 22, 24, 26, 28, 30, 32, 34, 36, 38, 40, 42, 44, 48, 50, 54,
      56, 60, 62, 64, 66, 68, 72, 74, 84,
    ],
  ],
  [
    "#35",
    [
      7, 9, 10, 11, 12, 14, 15, 16, 18, 20, 22, 24, 28, 30, 32, 34, 36, 40, 42, 44, 46, 48, 52, 54,
      56, 58, 60, 64, 66, 68, 72, 76, 80, 84,
    ],
  ],
];

export const testDriveCatalog: DriveCatalog = {
  source: "https://example.com/recalc-test-catalog",
  gears: [
    ...GEARS_20DP.flatMap((teeth) =>
      bores(teeth).map((bore) => ({
        teeth,
        dp: 20,
        bore,
        ...listing("WCP", `g20-${teeth}-${bore}`),
      })),
    ),
    ...GEARS_32DP.map((teeth) => ({
      teeth,
      dp: 32,
      bore: '1/2" Hex',
      ...listing("REV", `g32-${teeth}`),
    })),
  ],
  pulleys: PULLEYS.flatMap(([profile, pitchMm, teeth]) =>
    teeth.flatMap((count) =>
      bores(count).map((bore) => ({
        teeth: count,
        profile,
        pitchMm,
        bore,
        ...listing("WCP", `p-${profile}-${count}-${bore}`),
      })),
    ),
  ),
  belts: BELTS.flatMap(([profile, pitchMm, teeth]) =>
    teeth.map((count) => ({
      teeth: count,
      profile,
      pitchMm,
      widthMm: 9,
      ...listing("VBeltGuys", `b-${profile}-${count}`),
    })),
  ),
  sprockets: SPROCKETS.flatMap(([chain, teeth]) =>
    teeth.flatMap((count) =>
      bores(count).map((bore) => ({
        teeth: count,
        chain,
        bore,
        ...listing("WCP", `s-${chain}-${count}-${bore}`),
      })),
    ),
  ),
};
