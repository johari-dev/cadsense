/**
 * Short IDs for CAD tool calls. Occurrence, root, source, and model IDs are 64-character hex
 * strings, and smaller models copy them badly: a transposed character fails the call, and the
 * model often drops that part instead of retrying. One book per provider session shows every
 * full ID as its shortest unique prefix (at least eight characters, like git) and expands
 * prefixes back to full IDs before the tools decode their input. Full IDs still work.
 *
 * The domain never sees short IDs: `CadProviderTools.invoke` expands input before calling a tool
 * and shortens the result after, so persistence and UI events keep full IDs.
 */

const FULL_ID = /^[a-f0-9]{64}$/;
const PREFIX = /^[a-f0-9]{8,63}$/;
const MIN_LENGTH = 8;
const SCHEMA_MESSAGE = "Expected a string matching the RegExp ^[a-f0-9]{64}$";

/** Replaces the schema's 64-character message, which teaches models to make up full IDs. */
export const UNKNOWN_ID_DETAILS =
  "Expected an ID copied from an earlier CAD tool result (its first 8 or more characters)";

/** JSON Schema pattern advertised for ID fields once prefixes are accepted. */
export const SHORT_ID_PATTERN = "^[a-f0-9]{8,64}$";

export type CadShortIdExpansion =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly details: string };

// Maps every string, including object keys. Shapes are preserved, so the input type is kept.
const mapStrings = <T>(value: T, map: (text: string) => string): T => {
  const walk = (item: unknown): unknown =>
    typeof item === "string"
      ? map(item)
      : Array.isArray(item)
        ? item.map(walk)
        : item !== null && typeof item === "object"
          ? Object.fromEntries(Object.entries(item).map(([key, child]) => [map(key), walk(child)]))
          : item;
  return walk(value) as T;
};

/** One session's ID book. `shorten` results before the model sees them; `expand` its input. */
export const makeCadShortIds = () => {
  const known = new Set<string>();
  const shortFor = (full: string) => {
    for (let length = MIN_LENGTH; length < full.length; length++) {
      const prefix = full.slice(0, length);
      let unique = true;
      for (const other of known)
        if (other !== full && other.startsWith(prefix)) {
          unique = false;
          break;
        }
      if (unique) return prefix;
    }
    return full;
  };
  const shorten = <T>(result: T): T => {
    // Learn every ID first so IDs shown together get distinct prefixes.
    mapStrings(result, (text) => {
      if (FULL_ID.test(text)) known.add(text);
      return text;
    });
    return mapStrings(result, (text) =>
      FULL_ID.test(text)
        ? shortFor(text)
        : text.includes(SCHEMA_MESSAGE)
          ? text.replaceAll(SCHEMA_MESSAGE, UNKNOWN_ID_DETAILS)
          : text,
    );
  };
  const expand = (input: unknown): CadShortIdExpansion => {
    const ambiguous = new Set<string>();
    const value = mapStrings(input, (text) => {
      if (!PREFIX.test(text)) return text;
      const matches = [...known].filter((full) => full.startsWith(text));
      if (matches.length > 1) ambiguous.add(text);
      return matches.length === 1 ? matches[0]! : text;
    });
    return ambiguous.size === 0
      ? { ok: true, value }
      : {
          ok: false,
          details: `More than one ID starts with ${[...ambiguous].join(", ")}. Copy more characters of the ID from the latest result.`,
        };
  };
  return { shorten, expand };
};
export type CadShortIds = ReturnType<typeof makeCadShortIds>;

/** Relaxes every full-ID pattern in a tool's JSON Schema to accept prefixes. */
export const acceptShortIds = <T>(schema: T): T =>
  mapStrings(schema, (text) => (text === FULL_ID.source ? SHORT_ID_PATTERN : text));
