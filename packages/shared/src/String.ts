// With the `u` flag a whole surrogate pair is one code point, so these match only lone halves.
// No `toWellFormed`: apps/web compiles against ES2023.
const HIGH_HALF_AT_END = /[\uD800-\uDBFF]$/u;
const LOW_HALF_AT_START = /^[\uDC00-\uDFFF]/u;
const LONE_SURROGATE = /\p{Surrogate}/gu;

/**
 * The one way to cut text to a length. Use it instead of `slice` for any text that reaches a
 * user, an agent or a wire payload.
 *
 * Returns at most `max` UTF-16 units from the start of `text`, or from its end with `"end"`. The
 * result never holds half of a surrogate pair: a cut that lands inside an emoji ends one unit
 * short, and a lone surrogate already in `text` becomes U+FFFD. A lone surrogate encodes to a
 * JSON escape that serde_json rejects, which is how Codex once dropped a CAD follow-up.
 *
 * A `max` of 0 or less, or NaN, gives "". The cut keeps whole code points, not whole graphemes:
 * it can still land inside a ZWJ sequence or a flag.
 *
 * This is the hard limit, for schema caps and prompt budgets. A display cut adds its own ellipsis:
 * `${clip(name, 39)}...`.
 */
export function clip(text: string, max: number, keep: "start" | "end" = "start"): string {
  // `slice` reads a negative end as "count from the end" and `slice(-0)` as the whole text.
  const units = max > 0 ? Math.floor(max) : 0;
  const cut =
    keep === "start"
      ? text.slice(0, units).replace(HIGH_HALF_AT_END, "")
      : text.slice(Math.max(0, text.length - units)).replace(LOW_HALF_AT_START, "");
  return cut.replace(LONE_SURROGATE, "\u{FFFD}");
}

/**
 * The display cut for a title: `text` trimmed, and when that is longer than `maxLength` units,
 * clipped to `maxLength` with "..." after it. The result is up to `maxLength + 3` units, and well
 * formed like every `clip`.
 */
export function truncate(text: string, maxLength = 50): string {
  const trimmed = text.trim();
  const cut = clip(trimmed, maxLength);
  return trimmed.length <= maxLength ? cut : `${cut}...`;
}
