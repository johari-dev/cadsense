/**
 * Every way a cut can go wrong, written down before the helpers were. Each test names the
 * failures it guards by number.
 *
 * clip(text, max, keep)
 *  1. A surrogate pair sits on the cut. `slice` keeps the high half and drops the low one.
 *  2. The input already carries a lone surrogate: before the cut, at the cut, or in text that fits.
 *  3. A max of 0. With keep "end" this is `slice(-0)`, which returns the whole text.
 *  4. A ZWJ sequence, a flag, a skin tone or a variation selector sits on the cut. The pairs inside
 *     must stay whole. The cut may still land between two code points of one grapheme: that is the
 *     stated limit of the helper, not a failure.
 *  5. A negative max. `slice(0, -n)` drops n units from the end and returns the rest, far over the
 *     limit.
 *  6. A max that is NaN, fractional or Infinity.
 *  7. A max smaller than the first character: 1, with an emoji first.
 *  8. The repair is too greedy: a whole pair at the end of the cut loses a half, or a run of emoji
 *     loses more than one unit.
 *  9. Text that fits comes back changed.
 * 10. The result is longer than max, or is not a prefix (keep "end": a suffix) of the text.
 * 11. keep "end" mirrors 1: the cut keeps the low half of a pair at its start.
 * 12. The JSON encoding of a result carries a `\ud83d` escape with no partner. serde_json rejects
 *     that, which is how Codex dropped the follow-up.
 * 13. The helper calls `toWellFormed`. apps/web compiles against ES2023, where it does not exist,
 *     so its typecheck fails on that call. The test here only checks the two agree.
 *
 * truncate(text, maxLength)
 * 14. Padding counts toward the limit, so a short padded title gains an ellipsis.
 * 15. A title that fits gains an ellipsis, or one that is cut loses it.
 * 16. A pair on the cut leaves half an emoji before the ellipsis.
 * 17. A title that fits carries a lone surrogate through.
 */
import { describe, expect, it } from "@effect/vitest";

import { clip, truncate } from "./String.ts";

const RED = "\u{1F534}";
const FAMILY = "\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}\u{200D}\u{1F466}";

/** Well formed text of every shape that has a pair or a multi code point grapheme in it. */
const WELL_FORMED = [
  "",
  "plain ascii text",
  `x${RED}y${RED}${RED}z`,
  `${FAMILY} family`,
  "\u{1F1E8}\u{1F1E6}\u{1F1FA}\u{1F1F8} flags",
  "\u{1F44D}\u{1F3FD} skin tone",
  "1\u{FE0F}\u{20E3} 2\u{FE0F}\u{20E3} keycaps",
  "\u{20BB7}\u{91CE}\u{5BB6}",
];
/** Text that already carries half a pair. */
const BROKEN = [
  "\uD83D",
  "\uDD34",
  "a\uD83Db",
  "a\uDD34b",
  "ab\uD83D",
  "\uDD34ab",
  `\uD83D${RED}`,
  `${RED}\uDD34`,
];

/** Every max worth trying for `text`: each length around it, and the values `slice` reads oddly. */
const limits = (text: string) => [
  ...Array.from({ length: text.length + 5 }, (_, index) => index - 2),
  Number.NaN,
  2.5,
  Number.POSITIVE_INFINITY,
  Number.NEGATIVE_INFINITY,
];
/** The most units a result may have for `max`. */
const room = (max: number) => (Number.isNaN(max) ? 0 : Math.max(0, Math.floor(max)));
/** The longest run of whole code points, from the start of `points`, that fits in `max` units. */
const wholeCodePoints = (points: readonly string[], max: number) => {
  let length = 0;
  let count = 0;
  for (const point of points) {
    if (length + point.length > room(max)) break;
    length += point.length;
    count += 1;
  }
  return points.slice(0, count);
};

describe("clip", () => {
  it("drops the half of a pair that the cut would leave (1, 8, 11)", () => {
    const text = `ab${RED}cd`;
    expect(clip(text, 3)).toBe("ab");
    expect(clip(text, 4)).toBe(`ab${RED}`);
    expect(clip(text, 3, "end")).toBe("cd");
    expect(clip(text, 4, "end")).toBe(`${RED}cd`);
    // A run of emoji loses one unit, not a cascade of them.
    expect(clip(RED.repeat(4), 5)).toBe(RED.repeat(2));
    expect(clip(RED.repeat(4), 5, "end")).toBe(RED.repeat(2));
  });

  it("returns well formed text for input that already has a lone surrogate (2)", () => {
    // Before the cut, and in text that fits.
    expect(clip("a\uD83Dbcd", 3)).toBe("a\u{FFFD}b");
    expect(clip("a\uDD34b", 10)).toBe("a\u{FFFD}b");
    expect(clip("a\uD83Db", 10, "end")).toBe("a\u{FFFD}b");
    // A lone half on the edge of the result is dropped, like half of a pair the cut split.
    expect(clip("ab\uD83Dcd", 3)).toBe("ab");
    expect(clip("ab\uD83D", 10)).toBe("ab");
    expect(clip("ab\uDD34cd", 3, "end")).toBe("cd");
    expect(clip("\uDD34ab", 10, "end")).toBe("ab");
    // The other half on that edge has no partner to drop with, so it is replaced.
    expect(clip("ab\uDD34cd", 3)).toBe("ab\u{FFFD}");
    expect(clip("ab\uD83Dcd", 3, "end")).toBe("\u{FFFD}cd");
    // A lone half beside a whole pair does not take the pair with it.
    expect(clip(`\uD83D${RED}`, 3)).toBe(`\u{FFFD}${RED}`);
    expect(clip(`${RED}\uDD34`, 3, "end")).toBe(`${RED}\u{FFFD}`);
  });

  it("returns nothing for a max of 0 or less (3, 5)", () => {
    for (const text of ["", "abc", RED, `ab${RED}`])
      for (const max of [0, -0, -1, -100, Number.NEGATIVE_INFINITY])
        for (const keep of ["start", "end"] as const) expect(clip(text, max, keep)).toBe("");
  });

  it("reads NaN as 0, drops a fraction, and takes Infinity as no limit (6)", () => {
    const text = `ab${RED}cd`;
    expect(clip(text, Number.NaN)).toBe("");
    expect(clip(text, Number.NaN, "end")).toBe("");
    expect(clip(text, 2.9)).toBe("ab");
    expect(clip(text, 2.9, "end")).toBe("cd");
    expect(clip(text, 3.9)).toBe("ab");
    expect(clip(text, Number.POSITIVE_INFINITY)).toBe(text);
    expect(clip(text, Number.POSITIVE_INFINITY, "end")).toBe(text);
  });

  it("returns nothing when the first character does not fit (7)", () => {
    expect(clip(`${RED}abc`, 1)).toBe("");
    expect(clip(`abc${RED}`, 1, "end")).toBe("");
  });

  it("keeps every pair of a ZWJ sequence whole, and may end between its people (4)", () => {
    // Man, ZWJ, woman, ZWJ, girl, ZWJ, boy: 11 units.
    expect(FAMILY.length).toBe(11);
    expect(clip(FAMILY, 11)).toBe(FAMILY);
    // Mid pair: back to the last whole code point, here a joiner with nobody after it.
    expect(clip(FAMILY, 4)).toBe("\u{1F468}\u{200D}");
    expect(clip(FAMILY, 5)).toBe("\u{1F468}\u{200D}\u{1F469}");
    expect(clip(FAMILY, 1)).toBe("");
    expect(clip(FAMILY, 4, "end")).toBe("\u{200D}\u{1F466}");
    // A flag is two pairs: cut to one regional indicator, never to half of one.
    expect(clip("\u{1F1E8}\u{1F1E6}", 3)).toBe("\u{1F1E8}");
    // A skin tone is its own pair after the hand.
    expect(clip("\u{1F44D}\u{1F3FD}", 3)).toBe("\u{1F44D}");
  });

  it("cuts well formed text to whole code points, the most that fit (1, 4, 8, 9, 10, 11)", () => {
    for (const text of WELL_FORMED) {
      const points = Array.from(text);
      for (const max of limits(text)) {
        const context = `${JSON.stringify(text)} max ${max}`;
        expect(clip(text, max), context).toBe(wholeCodePoints(points, max).join(""));
        expect(clip(text, max, "end"), `${context} end`).toBe(
          wholeCodePoints(points.toReversed(), max).toReversed().join(""),
        );
      }
    }
  });

  it("never returns more than max units, half a pair, or JSON that serde_json rejects (10, 12)", () => {
    for (const text of [...WELL_FORMED, ...BROKEN])
      for (const max of limits(text))
        for (const keep of ["start", "end"] as const) {
          const cut = clip(text, max, keep);
          const context = `${JSON.stringify(text)} max ${max} ${keep}`;
          expect(cut.length, context).toBeLessThanOrEqual(room(max));
          expect(cut.isWellFormed(), context).toBe(true);
          // JSON.stringify writes a lone surrogate as a \ud83d escape and a whole pair as itself.
          expect(JSON.stringify(cut), context).not.toMatch(/\\ud[89a-f]/i);
        }
  });

  it("agrees with toWellFormed (2, 13)", () => {
    for (const text of [...WELL_FORMED, ...BROKEN]) {
      // A lone high half at the end is the one thing clip drops and toWellFormed replaces.
      const expected = text.replace(/[\uD800-\uDBFF]$/u, "").toWellFormed();
      expect(clip(text, text.length), JSON.stringify(text)).toBe(expected);
    }
  });
});

describe("truncate", () => {
  it("trims before it measures (14)", () => {
    expect(truncate("  hi  ")).toBe("hi");
    expect(truncate(`   ${"x".repeat(50)}   `)).toBe("x".repeat(50));
    expect(truncate("   \n ")).toBe("");
  });

  it("adds the ellipsis only to text it cut (15)", () => {
    expect(truncate("x".repeat(50))).toBe("x".repeat(50));
    expect(truncate("x".repeat(51))).toBe(`${"x".repeat(50)}...`);
    expect(truncate("abcdef", 3)).toBe("abc...");
    expect(truncate("abc", 3)).toBe("abc");
  });

  it("cuts one unit earlier when an emoji sits on the limit (16)", () => {
    const title = `${"x".repeat(49)}${RED} Red Alliance`;
    expect(truncate(title)).toBe(`${"x".repeat(49)}...`);
    expect(truncate(`${"x".repeat(48)}${RED} Red Alliance`)).toBe(`${"x".repeat(48)}${RED}...`);
    expect(truncate(title).isWellFormed()).toBe(true);
  });

  it("returns a well formed title even when nothing was cut (17)", () => {
    expect(truncate("Bracket \uDD34 left")).toBe("Bracket \u{FFFD} left");
    expect(truncate("Bracket \uD83D")).toBe("Bracket ");
  });
});
