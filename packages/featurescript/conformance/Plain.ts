import { FsBox, FsBuiltin, FsMap, untag, type FsValue } from "../src/runtime/Value.ts";
import * as S from "./Schema.ts";

/**
 * FeatureScript values as JSON, the form both sides of a comparison are stored and compared in.
 * Type tags are dropped (an enum value is its name, a Vector its array), `undefined` is null,
 * non-finite numbers are "inf", "-inf" and "nan", and map keys are strings: a string key as is,
 * any other key as the JSON of its plain value.
 */
export type Plain = null | boolean | number | string | readonly Plain[] | PlainMap;
export interface PlainMap {
  readonly [key: string]: Plain;
}

const number = (n: number): Plain =>
  Number.isFinite(n) ? n : Number.isNaN(n) ? "nan" : n > 0 ? "inf" : "-inf";
const keyString = (key: Plain): string => (typeof key === "string" ? key : JSON.stringify(key));

/** A local FeatureScript value as plain JSON. */
export function fromLocal(value: FsValue): Plain {
  const inner = untag(value);
  if (inner === undefined) return null;
  if (typeof inner === "number") return number(inner);
  if (typeof inner === "boolean" || typeof inner === "string") return inner;
  if (Array.isArray(inner)) return inner.map(fromLocal);
  if (inner instanceof FsMap)
    return Object.fromEntries(
      inner.entries().map(([key, entry]) => [keyString(fromLocal(key)), fromLocal(entry)]),
    );
  if (inner instanceof FsBox) return "<box>";
  if (inner instanceof FsBuiltin) return "<builtin>";
  return "<function>";
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * The value type a `btType` names, in any of Onshape's documented spellings: `BTFSValueArray`,
 * with a number (`BTFSValueArray-1499`), or fully qualified
 * (`com.belmonttech.serialize.fsvalue.BTFSValueArray`, as in the Features docs example). Anything
 * else (another package, a suffix that isn't a number) is returned unchanged, so it matches no
 * known type and fails.
 */
const valueType = (btType: string): string =>
  /^(?:com\.belmonttech\.serialize\.fsvalue\.)?(BTFSValue[A-Za-z]+)(?:-\d+)?$/.exec(btType)?.[1] ??
  btType;

/** An encoded value that isn't what Onshape's encoding allows. Nothing malformed decodes to a default. */
export class MalformedValue extends S.DecodeError {}

/**
 * A value from Onshape's FeatureScript endpoint (`BTFSValue-1888` and its subtypes) as plain JSON,
 * the same shape {@link fromLocal} gives. Throws {@link MalformedValue}, naming where, for anything
 * that isn't a well-formed encoding: a missing or mistyped `value`, a map entry without a key, a
 * type Onshape doesn't have, or a value Onshape withheld as too big to send.
 */
export function fromOnshape(value: unknown, path = "value"): Plain {
  const malformed = (what: string): never => {
    throw new MalformedValue(
      path,
      what,
      `${path} should be ${what}: ${String(JSON.stringify(value)).slice(0, 200)}`,
    );
  };
  if (!isRecord(value) || typeof value.btType !== "string") return malformed("an encoded value");
  const inner = value.value;
  switch (valueType(value.btType)) {
    case "BTFSValueArray":
      if (!Array.isArray(inner)) return malformed("a list with a list value");
      return inner.map((item, i) => fromOnshape(item, `${path}[${i}]`));
    case "BTFSValueMap":
      if (!Array.isArray(inner)) return malformed("a map with a list of entries");
      return Object.fromEntries(
        inner.map((entry, i) => {
          if (!isRecord(entry) || !("key" in entry) || !("value" in entry))
            return malformed(`a map whose entry ${i} has a key and a value`);
          // Keys come from the data; paths name entries by index, never by key.
          const key = keyString(fromOnshape(entry.key, `${path}.entry[${i}].key`));
          return [key, fromOnshape(entry.value, `${path}.entry[${i}].value`)];
        }),
      );
    // Locally a ValueWithUnits is a map of `unit` and `value`.
    case "BTFSValueWithUnits":
      if (typeof inner !== "number") return malformed("a quantity with a number");
      return {
        unit: units(value.unitToPower) ?? malformed("a quantity with unit powers"),
        value: number(inner),
      };
    case "BTFSValueNumber":
      return typeof inner === "number" ? number(inner) : malformed("a number with a number value");
    case "BTFSValueString":
      return typeof inner === "string" ? inner : malformed("a string with its text");
    case "BTFSValueBoolean":
      return typeof inner === "boolean" ? inner : malformed("a boolean with its value");
    case "BTFSValueUndefined":
      return null;
    // Onshape withheld the value, so there's nothing to record; a placeholder would pass as one.
    case "BTFSValueTooBig":
      return malformed("a value Onshape sent, not one it withheld as too big");
    case "BTFSValueOther":
      return typeof value.type === "string"
        ? `<${value.type.toLowerCase()}>`
        : malformed("an other value with its type");
    default:
      return malformed("a type Onshape has");
  }
}

/** Unit powers as a map from lower-case unit name to power, from either of Onshape's encodings; null if neither. */
function units(unitToPower: unknown): PlainMap | null {
  const entries = Array.isArray(unitToPower)
    ? unitToPower.map((entry) => (isRecord(entry) ? [entry.key, entry.value] : [null, null]))
    : isRecord(unitToPower)
      ? Object.entries(unitToPower)
      : null;
  if (!entries?.every(([unit, power]) => typeof unit === "string" && typeof power === "number"))
    return null;
  return Object.fromEntries(
    entries.map(([unit, power]) => [String(unit).toLowerCase(), Number(power)]),
  );
}

export const isPlainMap = (value: Plain | undefined): value is PlainMap =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Any plain value, as stored in a recording. */
export const plain: S.Schema<Plain> = S.lazy(() =>
  S.union(S.literal(null), S.boolean, S.number, S.string(), S.array(plain), S.record(plain)),
);

/** An Onshape-encoded value, decoded to plain JSON with {@link fromOnshape}. */
export const onshapeValue: S.Schema<Plain> = S.custom((value, path) => fromOnshape(value, path));
