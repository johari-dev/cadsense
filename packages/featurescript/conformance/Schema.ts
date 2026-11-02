/**
 * Strict decoders for JSON that comes from outside: Onshape's responses and recordings on disk.
 * A schema checks a value's shape and returns it typed, or throws {@link DecodeError} naming where
 * it's wrong; nothing malformed decodes to a default. Objects may carry fields their schema doesn't
 * name (Onshape's responses have many), which are dropped; the named ones must be present and well
 * formed unless `optional`.
 *
 * A DecodeError's `path` and `expected` are built only from the schema (field names, indexes,
 * descriptions), never from the data: a map key from a response shows as `*`. They're safe to keep
 * in failures.json; the message, which quotes the offending value, is not.
 *
 * The repo's schema library is Effect Schema, which this package doesn't depend on yet; these are
 * the few combinators the recorder needs, shaped so moving to it is mechanical.
 */
export class DecodeError extends Error {
  /** Where, e.g. `response.items[2].owner.id`. */
  readonly path: string;
  /** What the schema wanted there, e.g. "a 24-character hex id". */
  readonly expected: string;
  constructor(path: string, expected: string, message: string) {
    super(message);
    this.path = path;
    this.expected = expected;
  }
}

export interface Schema<T> {
  /** `value` as a `T`, or a {@link DecodeError} naming `path`. */
  readonly decode: (value: unknown, path: string) => T;
}
/** A schema whose field may be missing from its object. */
export interface OptionalSchema<T> extends Schema<T | undefined> {
  readonly optional: true;
}
export type Infer<S> = S extends Schema<infer T> ? T : never;

const shown = (value: unknown) => {
  const json = JSON.stringify(value);
  if (json === undefined) return String(value);
  return json.length > 120 ? `${json.slice(0, 120)}...` : json;
};
const fail = (path: string, expected: string, value: unknown): never => {
  throw new DecodeError(path, expected, `${path} should be ${expected}, not ${shown(value)}`);
};
const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A schema from a decode function, for checks the combinators don't cover. */
export const custom = <T>(decode: (value: unknown, path: string) => T): Schema<T> => ({ decode });

/** Any value, unchecked: for response bodies the recorder never reads. */
export const unknown: Schema<unknown> = custom((value) => value);
/** Any value that's there: unchecked, but not missing. For a field decoded later by its user. */
export const present: Schema<unknown> = custom((value, path) =>
  value === undefined ? fail(path, "present", value) : value,
);

/** A string, optionally matching `pattern` (described as `what` in errors). */
export const string = (pattern?: RegExp, what = "a string"): Schema<string> =>
  custom((value, path) =>
    typeof value === "string" && (!pattern || pattern.test(value))
      ? value
      : fail(path, what, value),
  );
export const nonEmpty = string(/\S/, "a non-empty string");
/** A FeatureScript identifier, such as a feature type. */
export const identifier = string(/^[A-Za-z_][A-Za-z0-9_]*$/, "an identifier");
/** An Onshape id: a user, document, workspace, element or microversion. */
export const hexId = string(/^[0-9a-f]{24}$/, "a 24-character hex id");

export const number: Schema<number> = custom((value, path) =>
  typeof value === "number" && Number.isFinite(value)
    ? value
    : fail(path, "a finite number", value),
);
/** A count: an integer, zero or more. */
export const count: Schema<number> = custom((value, path) =>
  Number.isInteger(value) && Number(value) >= 0 ? Number(value) : fail(path, "a count", value),
);
export const boolean: Schema<boolean> = custom((value, path) =>
  typeof value === "boolean" ? value : fail(path, "a boolean", value),
);

/** One of `values`, compared with `===`. */
export const literal = <const L extends readonly (string | number | boolean | null)[]>(
  ...values: L
): Schema<L[number]> =>
  custom((value, path) =>
    values.includes(value as L[number])
      ? (value as L[number])
      : fail(path, `one of ${shown(values)}`, value),
  );

/** A list of `item`s, of exactly `length` if given. */
export const array = <T>(item: Schema<T>, length?: number): Schema<readonly T[]> =>
  custom((value, path) => {
    if (!Array.isArray(value) || (length !== undefined && value.length !== length))
      return fail(path, length === undefined ? "a list" : `a list of ${length}`, value);
    return value.map((entry, i) => item.decode(entry, `${path}[${i}]`));
  });

/** A map with any string keys, each value an `item`. Keys come from the data, so paths show `*`. */
export const record = <T>(item: Schema<T>): Schema<Readonly<Record<string, T>>> =>
  custom((value, path) => {
    if (!isRecord(value)) return fail(path, "a map", value);
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, item.decode(entry, `${path}.*`)]),
    );
  });

/** A map with exactly `keys`, each value an `item`: one missing or one extra fails. */
export const exactRecord = <T>(
  keys: readonly string[],
  item: Schema<T>,
): Schema<Readonly<Record<string, T>>> =>
  custom((value, path) => {
    if (!isRecord(value)) return fail(path, "a map", value);
    if (Object.keys(value).some((key) => !keys.includes(key)))
      return fail(path, `a map of only ${JSON.stringify(keys)}`, value);
    return Object.fromEntries(keys.map((key) => [key, item.decode(value[key], `${path}.${key}`)]));
  });

/** `schema`, then `check`, which returns what's wrong (as what was expected instead) or null. */
export const refine = <T>(schema: Schema<T>, check: (value: T) => string | null): Schema<T> =>
  custom((value, path) => {
    const decoded = schema.decode(value, path);
    const problem = check(decoded);
    return problem === null ? decoded : fail(path, problem, value);
  });

/** A field that may be missing (or undefined); in a decoded object it's then left out. */
export const optional = <T>(schema: Schema<T>): OptionalSchema<T> => ({
  optional: true,
  decode: (value, path) => (value === undefined ? undefined : schema.decode(value, path)),
});
export const nullable = <T>(schema: Schema<T>): Schema<T | null> =>
  custom((value, path) => (value === null ? null : schema.decode(value, path)));

/** The first of `schemas` that decodes the value. */
export const union = <S extends readonly Schema<unknown>[]>(
  ...schemas: S
): Schema<Infer<S[number]>> =>
  custom((value, path) => {
    const errors: DecodeError[] = [];
    for (const schema of schemas) {
      try {
        return schema.decode(value, path) as Infer<S[number]>;
      } catch (error) {
        if (!(error instanceof DecodeError)) throw error;
        errors.push(error);
      }
    }
    // The deepest failure says the most about what was nearly right.
    const deepest = errors.reduce((a, b) => (b.path.length > a.path.length ? b : a), errors[0]!);
    throw new DecodeError(
      deepest.path,
      deepest.expected,
      errors.map((error) => error.message).join("; or "),
    );
  });

/** A schema defined later, for recursive shapes. */
export const lazy = <T>(get: () => Schema<T>): Schema<T> =>
  custom((value, path) => get().decode(value, path));

type Shape = Readonly<Record<string, Schema<unknown>>>;
type OptionalKeys<S extends Shape> = {
  [K in keyof S]: S[K] extends OptionalSchema<unknown> ? K : never;
}[keyof S];
type Simplify<T> = { readonly [K in keyof T]: T[K] };
export type ObjectOf<S extends Shape> = Simplify<
  { readonly [K in Exclude<keyof S, OptionalKeys<S>>]: Infer<S[K]> } & {
    readonly [K in OptionalKeys<S>]?: Exclude<Infer<S[K]>, undefined>;
  }
>;

/** An object with each field of `shape`; other fields are dropped. */
export const object = <S extends Shape>(shape: S): Schema<ObjectOf<S>> =>
  custom((value, path) => {
    if (!isRecord(value)) return fail(path, "an object", value);
    const decoded: Record<string, unknown> = {};
    for (const [key, schema] of Object.entries(shape)) {
      const field = schema.decode(value[key], `${path}.${key}`);
      if (field !== undefined) decoded[key] = field;
    }
    return decoded as ObjectOf<S>;
  });
