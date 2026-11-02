/**
 * FeatureScript values.
 *
 * Arrays and maps are immutable here: FeatureScript copies them on every assignment, argument and
 * return, and sharing immutable structures gives the same behavior without copying. Updates build
 * new values (see `FsMap.set`, `arraySet`). Boxes and builtins are the only shared mutable values.
 */

/** A declared custom type or enum. Values carry at most one of these as their type tag. */
export interface TypeDef {
  readonly name: string;
  readonly kind: "type" | "enum";
  /** Module path that declares it. */
  readonly module: string;
  /** Global declaration order (modules in first-seen import order). Tagged values sort by it. */
  readonly order: number;
  /** Enum members in declaration order; empty for custom types. */
  readonly members: readonly string[];
  readonly ordinals: ReadonlyMap<string, number>;
}

/** A value with a type tag. The inner value never has a tag of its own. */
export class FsTagged {
  readonly tag: TypeDef;
  readonly value: Untagged;
  constructor(tag: TypeDef, value: Untagged) {
    this.tag = tag;
    this.value = value;
  }
}

let nextIdentity = 1;
/** Boxes, builtins and functions sort and compare by creation order. */
export const newIdentity = () => nextIdentity++;

/** A mutable cell, shared by reference. */
export class FsBox {
  value: FsValue;
  readonly id = newIdentity();
  constructor(value: FsValue) {
    this.value = value;
  }
}

/** Runtime state FeatureScript can only pass around, such as a modeling context or a sketch. */
export class FsBuiltin<T = unknown> {
  readonly native: T;
  readonly id = newIdentity();
  constructor(native: T) {
    this.native = native;
  }
}

/** A callable value. `impl` is interpreted by the interpreter; values only need identity. */
export class FsFunction<Impl = unknown> {
  readonly impl: Impl;
  readonly id = newIdentity();
  constructor(impl: Impl) {
    this.impl = impl;
  }
}

export type FsArray = readonly FsValue[];
export type Entry = readonly [key: FsValue, value: FsValue];

/** An immutable FeatureScript map. Iteration follows the documented total order on keys. */
export class FsMap {
  private readonly table: ReadonlyMap<string, Entry>;
  private sorted: readonly Entry[] | undefined;

  private constructor(table: ReadonlyMap<string, Entry>) {
    this.table = table;
  }

  static readonly empty = new FsMap(new Map());

  /** Later entries win; entries whose value is `undefined` are dropped, as in a map literal. */
  static fromEntries(entries: Iterable<Entry>): FsMap {
    const table = new Map<string, Entry>();
    for (const [key, value] of entries) {
      const k = keyOf(key);
      if (value === undefined) table.delete(k);
      else table.set(k, [key, value]);
    }
    return new FsMap(table);
  }

  get size() {
    return this.table.size;
  }
  get(key: FsValue): FsValue {
    return this.table.get(keyOf(key))?.[1];
  }
  /** Fast path for `m.field`. */
  getField(name: string): FsValue {
    return this.table.get(`s${name}`)?.[1];
  }
  has(key: FsValue) {
    return this.table.has(keyOf(key));
  }
  /** A copy with `key` set; storing `undefined` removes the key. */
  set(key: FsValue, value: FsValue): FsMap {
    const k = keyOf(key);
    if (value === undefined && !this.table.has(k)) return this;
    const table = new Map(this.table);
    if (value === undefined) table.delete(k);
    else table.set(k, [key, value]);
    return new FsMap(table);
  }
  /** Entries in key order. */
  entries(): readonly Entry[] {
    return (this.sorted ??= [...this.table.values()].sort((a, b) => compare(a[0], b[0])));
  }
}

export type Untagged =
  | undefined
  | boolean
  | number
  | string
  | FsArray
  | FsMap
  | FsBox
  | FsBuiltin
  | FsFunction;
export type FsValue = Untagged | FsTagged;

export const STANDARD_TYPES = [
  "undefined",
  "boolean",
  "number",
  "string",
  "array",
  "map",
  "box",
  "builtin",
  "function",
] as const;
export type StandardType = (typeof STANDARD_TYPES)[number];
export const isStandardType = (name: string): name is StandardType =>
  (STANDARD_TYPES as readonly string[]).includes(name);

/** The value without its type tag. */
export const untag = (value: FsValue): Untagged =>
  value instanceof FsTagged ? value.value : value;

export function standardType(value: FsValue): StandardType {
  const v = untag(value);
  switch (typeof v) {
    case "undefined":
      return "undefined";
    case "boolean":
      return "boolean";
    case "number":
      return "number";
    case "string":
      return "string";
  }
  if (Array.isArray(v)) return "array";
  if (v instanceof FsMap) return "map";
  if (v instanceof FsBox) return "box";
  if (v instanceof FsBuiltin) return "builtin";
  return "function";
}

const TYPE_RANK: Readonly<Record<StandardType, number>> = {
  undefined: 0,
  boolean: 1,
  number: 2,
  string: 3,
  array: 4,
  map: 5,
  box: 6,
  builtin: 7,
  function: 8,
};

const identityOf = (v: FsBox | FsBuiltin | FsFunction) => v.id;

/**
 * The total order from https://cad.onshape.com/FsDoc/relational.html: untagged values first, then by
 * type tag declaration order, then standard type, then value. Within one enum, values sort by
 * declaration order (std's `isAtVersionOrLater` depends on it).
 */
export function compare(a: FsValue, b: FsValue): number {
  const tagA = a instanceof FsTagged ? a.tag : null;
  const tagB = b instanceof FsTagged ? b.tag : null;
  if (tagA !== tagB) return (tagA?.order ?? -1) - (tagB?.order ?? -1);
  const x = untag(a);
  const y = untag(b);
  if (tagA?.kind === "enum" && typeof x === "string" && typeof y === "string")
    return (tagA.ordinals.get(x) ?? -1) - (tagA.ordinals.get(y) ?? -1) || compareBase(x, y);
  return compareBase(x, y);
}

function compareBase(x: Untagged, y: Untagged): number {
  const tx = standardType(x);
  const ty = standardType(y);
  if (tx !== ty) return TYPE_RANK[tx] - TYPE_RANK[ty];
  switch (tx) {
    case "undefined":
      return 0;
    case "boolean":
      return Number(x) - Number(y);
    case "number":
      return (x as number) - (y as number);
    case "string":
      return (x as string) < (y as string) ? -1 : (x as string) > (y as string) ? 1 : 0;
    case "array": {
      const p = x as FsArray;
      const q = y as FsArray;
      if (p.length !== q.length) return p.length - q.length;
      for (let i = 0; i < p.length; i++) {
        const c = compare(p[i], q[i]);
        if (c !== 0) return c;
      }
      return 0;
    }
    case "map": {
      const p = (x as FsMap).entries();
      const q = (y as FsMap).entries();
      if (p.length !== q.length) return p.length - q.length;
      for (let i = 0; i < p.length; i++) {
        const c = compare(p[i]![0], q[i]![0]) || compare(p[i]![1], q[i]![1]);
        if (c !== 0) return c;
      }
      return 0;
    }
    default:
      return identityOf(x as FsBox) - identityOf(y as FsBox);
  }
}

/** Structural equality: same tag, same standard type, equal contents. Boxes and builtins by identity. */
export function equals(a: FsValue, b: FsValue): boolean {
  if (a === b) return true;
  if (a instanceof FsTagged || b instanceof FsTagged)
    return (
      a instanceof FsTagged && b instanceof FsTagged && a.tag === b.tag && equals(a.value, b.value)
    );
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!equals(a[i], b[i])) return false;
    return true;
  }
  if (a instanceof FsMap) {
    if (!(b instanceof FsMap) || a.size !== b.size) return false;
    for (const [key, value] of a.entries()) if (!equals(value, b.get(key))) return false;
    return true;
  }
  return false;
}

/** An injective string for map lookup; equal values get equal keys. */
export function keyOf(value: FsValue): string {
  switch (typeof value) {
    case "string":
      return `s${value}`;
    case "number":
      return `n${value === 0 ? 0 : value}`;
    case "boolean":
      return value ? "b1" : "b0";
    case "undefined":
      return "u";
  }
  if (value instanceof FsTagged) return `t${value.tag.order}:${keyOf(value.value)}`;
  if (Array.isArray(value)) return `a[${value.map((item) => framed(keyOf(item))).join("")}]`;
  if (value instanceof FsMap)
    return `m{${value
      .entries()
      .map(([k, v]) => framed(keyOf(k)) + framed(keyOf(v)))
      .join("")}}`;
  if (value instanceof FsBox) return `x${value.id}`;
  if (value instanceof FsBuiltin) return `B${value.id}`;
  return `f${(value as FsFunction).id}`;
}
const framed = (key: string) => `${key.length}:${key}`;

/** A copy of `array` with `array[index] = value`. The caller checks the index. */
export const arraySet = (array: FsArray, index: number, value: FsValue): FsArray => {
  const copy = array.slice();
  copy[index] = value;
  return copy;
};

/** Numbers as `~` prints them. Unverified against Onshape; see FeatureScript.md. */
export function formatNumber(n: number): string {
  if (n === Number.POSITIVE_INFINITY) return "inf";
  if (n === Number.NEGATIVE_INFINITY) return "-inf";
  return String(n === 0 ? 0 : n);
}

/**
 * The "internal algorithm" `~` uses to turn a non-string into a string. Top-level strings print
 * as-is; nested strings are quoted. Shape follows the example in the type-tags docs.
 */
export function formatValue(value: FsValue, nested = false): string {
  if (value instanceof FsTagged) return `${value.tag.name} : ${formatValue(value.value, true)}`;
  switch (typeof value) {
    case "string":
      return nested ? JSON.stringify(value) : value;
    case "number":
      return formatNumber(value);
    case "boolean":
      return String(value);
    case "undefined":
      return "undefined";
  }
  if (Array.isArray(value))
    return value.length ? `[ ${value.map((v) => formatValue(v, true)).join(" , ")} ]` : "[ ]";
  if (value instanceof FsMap)
    return value.size
      ? `{ ${value
          .entries()
          .map(([k, v]) => `${formatValue(k, true)} : ${formatValue(v, true)}`)
          .join(" , ")} }`
      : "{ }";
  if (value instanceof FsBox) return `box(${formatValue(value.value, true)})`;
  if (value instanceof FsBuiltin) return "builtin";
  return "function";
}
