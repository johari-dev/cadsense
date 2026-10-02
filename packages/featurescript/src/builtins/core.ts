import type { BuiltinCall, BuiltinImpl } from "../runtime/Interpreter.ts";
import { equals, FsMap, FsTagged, untag, type FsArray, type FsValue } from "../runtime/Value.ts";
import { array, integer, map, number, real, string } from "./args.ts";
import type { StdBuiltinName } from "./stdBuiltinNames.generated.ts";

/** Math, string, container and matrix builtins: everything that doesn't touch a context. */

const unary =
  (name: string, f: (x: number) => number): BuiltinImpl =>
  ([x], call) =>
    real(call, f(number(call, x, "value")), `${name}(${String(untag(x))})`);

// Strings are indexed by Unicode code point, matching "strings hold Unicode characters".
const chars = (s: string) => Array.from(s);

const regexCache = new Map<string, RegExp>();
const regex = (call: BuiltinCall, pattern: string, flags = ""): RegExp => {
  const key = `${flags}/${pattern}`;
  let compiled = regexCache.get(key);
  if (!compiled) {
    try {
      compiled = new RegExp(pattern, flags);
    } catch {
      return call.fail(`Invalid regular expression ${pattern}.`);
    }
    regexCache.set(key, compiled);
  }
  compiled.lastIndex = 0;
  return compiled;
};

/** The number inside a `number` or a `ValueWithUnits` map, for builtins that accept either. */
const magnitude = (call: BuiltinCall, value: FsValue, what: string): number => {
  const v = untag(value);
  if (typeof v === "number") return v;
  if (v instanceof FsMap && typeof v.getField("value") === "number")
    return v.getField("value") as number;
  return call.fail(`${what} must be a number or a value with units.`);
};

/** A value like `template` (same tag and units) but with magnitude `value`. */
const withMagnitude = (template: FsValue, value: number): FsValue => {
  const v = untag(template);
  if (typeof v === "number") return value;
  const updated = (v as FsMap).set("value", value);
  return template instanceof FsTagged ? new FsTagged(template.tag, updated) : updated;
};

// ------------------------------------------------------------------ matrices

type Rows = number[][];
const rows = (call: BuiltinCall, value: FsValue, what: string): Rows => {
  const outer = array(call, value, what);
  if (outer.length === 0) call.fail(`${what} must be a non-empty matrix.`);
  const result = outer.map((row) =>
    array(call, row, what).map((x) => number(call, x, `${what} element`)),
  );
  if (result.some((row) => row.length !== result[0]!.length || row.length === 0))
    call.fail(`${what} must have rows of equal, non-zero length.`);
  return result;
};
const numbers = (call: BuiltinCall, value: FsValue, what: string) =>
  array(call, value, what).map((x) => number(call, x, `${what} element`));
const isVector = (value: FsValue) => {
  const v = untag(value);
  return Array.isArray(v) && (v as FsArray).every((x) => typeof untag(x) === "number");
};
const zip = (call: BuiltinCall, a: Rows, b: Rows, f: (x: number, y: number) => number): Rows => {
  if (a.length !== b.length || a[0]!.length !== b[0]!.length)
    call.fail("Matrix sizes don't match.");
  return a.map((row, i) => row.map((x, j) => f(x, b[i]![j]!)));
};
/** Matrix or vector, element-wise. */
const elementwise = (
  call: BuiltinCall,
  a: FsValue,
  b: FsValue,
  f: (x: number, y: number) => number,
): FsValue => {
  if (isVector(a) && isVector(b)) {
    const p = numbers(call, a, "vector");
    const q = numbers(call, b, "vector");
    if (p.length !== q.length) call.fail("Vector sizes don't match.");
    return p.map((x, i) => f(x, q[i]!));
  }
  return zip(call, rows(call, a, "matrix"), rows(call, b, "matrix"), f);
};

function inverse(call: BuiltinCall, m: Rows): Rows {
  const n = m.length;
  if (m[0]!.length !== n) call.fail("Only square matrices can be inverted.");
  const a = m.map((row, i) => [...row, ...row.map((_, j) => (i === j ? 1 : 0))]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++)
      if (Math.abs(a[r]![col]!) > Math.abs(a[pivot]![col]!)) pivot = r;
    if (Math.abs(a[pivot]![col]!) < 1e-300) call.fail("Matrix is singular.");
    [a[col], a[pivot]] = [a[pivot]!, a[col]!];
    const p = a[col]![col]!;
    a[col] = a[col]!.map((x) => x / p);
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const factor = a[r]![col]!;
      a[r] = a[r]!.map((x, j) => x - factor * a[col]![j]!);
    }
  }
  return a.map((row) => row.slice(n));
}

function determinant(call: BuiltinCall, m: Rows): number {
  const n = m.length;
  if (m[0]!.length !== n) call.fail("Only square matrices have a determinant.");
  const a = m.map((row) => [...row]);
  let det = 1;
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++)
      if (Math.abs(a[r]![col]!) > Math.abs(a[pivot]![col]!)) pivot = r;
    if (a[pivot]![col] === 0) return 0;
    if (pivot !== col) {
      [a[col], a[pivot]] = [a[pivot]!, a[col]!];
      det = -det;
    }
    det *= a[col]![col]!;
    for (let r = col + 1; r < n; r++) {
      const factor = a[r]![col]! / a[col]![col]!;
      for (let j = col; j < n; j++) a[r]![j]! -= factor * a[col]![j]!;
    }
  }
  return det;
}

// ------------------------------------------------------------------ JSON

function fromJson(value: unknown): FsValue {
  if (value === null) return undefined;
  if (Array.isArray(value)) return value.map(fromJson);
  if (typeof value === "object")
    return FsMap.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, fromJson(v)] as const),
    );
  return value as FsValue;
}

// ------------------------------------------------------------------ table

export const CORE_BUILTINS = {
  acos: unary("acos", Math.acos),
  acosh: unary("acosh", Math.acosh),
  asin: unary("asin", Math.asin),
  asinh: unary("asinh", Math.asinh),
  atan: unary("atan", Math.atan),
  atanh: unary("atanh", Math.atanh),
  atan2: ([y, x], call) => Math.atan2(number(call, y, "y"), number(call, x, "x")),
  ceil: unary("ceil", Math.ceil),
  floor: unary("floor", Math.floor),
  cos: unary("cos", Math.cos),
  cosh: unary("cosh", Math.cosh),
  sin: unary("sin", Math.sin),
  sinh: unary("sinh", Math.sinh),
  tan: unary("tan", Math.tan),
  tanh: unary("tanh", Math.tanh),
  exp: unary("exp", Math.exp),
  exp2: unary("exp2", (x) => 2 ** x),
  log: unary("log", Math.log),
  log10: unary("log10", Math.log10),
  sqrt: unary("sqrt", Math.sqrt),
  hypot: ([a, b], call) => Math.hypot(number(call, a, "a"), number(call, b, "b")),

  length: ([s], call) => chars(string(call, s, "s")).length,
  substring: ([s, start, end], call) => {
    const c = chars(string(call, s, "s"));
    const from = integer(call, start, "startIndex", 0);
    const to = end === undefined ? c.length : integer(call, end, "endIndex", 0);
    if (from > to || to > c.length)
      call.fail(`Substring [${from}, ${to}) is out of range for a string of length ${c.length}.`);
    return c.slice(from, to).join("");
  },
  startsWith: ([s, prefix], call) =>
    string(call, s, "s").startsWith(string(call, prefix, "prefix")),
  endsWith: ([s, suffix], call) => string(call, s, "s").endsWith(string(call, suffix, "suffix")),
  indexOfString: ([s, sub], call) => {
    const text = string(call, s, "s");
    const index = text.indexOf(string(call, sub, "substring"));
    return index === -1 ? -1 : chars(text.slice(0, index)).length;
  },
  repeatString: ([s, count], call) => string(call, s, "s").repeat(integer(call, count, "count", 0)),
  splitIntoCharacters: ([s], call) => chars(string(call, s, "s")),
  stringToNumber: ([s], call) => {
    const text = string(call, s, "s");
    if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(text))
      call.fail(`"${text}" is not a number.`);
    return Number(text);
  },
  match: ([s, re], call) => {
    const text = string(call, s, "s");
    const found = regex(call, `^(?:${string(call, re, "regExp")})$`).exec(text);
    return FsMap.fromEntries([
      ["hasMatch", found !== null],
      ["captures", found ? found.map((group) => group ?? "") : []],
    ]);
  },
  replace: ([s, re, replacement], call) =>
    string(call, s, "s").replace(
      regex(call, string(call, re, "regExp"), "g"),
      string(call, replacement, "replacement"),
    ),
  splitByRegexp: ([s, re], call) => {
    const parts = string(call, s, "s").split(regex(call, string(call, re, "separatorRegexp")));
    // Like Java's String.split: trailing empty strings are dropped (std's own examples show this).
    while (parts.length && parts.at(-1) === "") parts.pop();
    return parts;
  },
  indexOfRegexp: ([s, re, start], call) => {
    const text = string(call, s, "s");
    const from = start === undefined ? 0 : integer(call, start, "startIndex", 0);
    const prefix = chars(text).slice(0, from).join("");
    const found = regex(call, string(call, re, "regexp"), "g");
    found.lastIndex = prefix.length;
    const hit = found.exec(text);
    return hit ? chars(text.slice(0, hit.index)).length : -1;
  },
  parseJson: ([s], call) => {
    try {
      return fromJson(JSON.parse(string(call, s, "s")));
    } catch {
      return call.fail("Invalid JSON.");
    }
  },

  size: ([container], call) => {
    const v = untag(container);
    if (Array.isArray(v)) return v.length;
    if (v instanceof FsMap) return v.size;
    return call.fail("size needs an array or a map.");
  },
  resize: ([arr, size, fill], call) => {
    const items = array(call, arr, "array");
    const n = integer(call, size, "size", 0);
    return n <= items.length
      ? items.slice(0, n)
      : [...items, ...Array.from({ length: n - items.length }, () => fill)];
  },
  subArray: ([arr, start, end], call) => {
    const items = array(call, arr, "array");
    const from = integer(call, start, "startIndex", 0);
    const to = end === undefined ? items.length : integer(call, end, "endIndex", 0);
    if (from > to || to > items.length)
      call.fail(`Subarray [${from}, ${to}) is out of range for an array of size ${items.length}.`);
    return items.slice(from, to);
  },
  concatenateArrays: ([arrays], call) =>
    array(call, arrays, "arrays").flatMap((inner) => array(call, inner, "each element")),
  reverse: ([arr], call) => array(call, arr, "array").toReversed(),
  indexOf: ([arr, value, start], call) => {
    const items = array(call, arr, "container");
    for (
      let i = start === undefined ? 0 : integer(call, start, "startIndex", 0);
      i < items.length;
      i++
    )
      if (equals(items[i], value)) return i;
    return -1;
  },
  keys: ([m], call) =>
    map(call, m, "container")
      .entries()
      .map(([key]) => key),
  values: ([m], call) =>
    map(call, m, "container")
      .entries()
      .map(([, value]) => value),
  mergeMaps: ([defaults, m], call) => {
    let result = map(call, defaults, "defaults");
    for (const [key, value] of map(call, m, "m").entries()) result = result.set(key, value);
    return result;
  },
  intersectMaps: ([maps], call) => {
    const all = array(call, maps, "maps").map((m) => map(call, m, "each element"));
    if (all.length === 0) return FsMap.empty;
    const last = all.at(-1)!;
    return FsMap.fromEntries(last.entries().filter(([key]) => all.every((m) => m.has(key))));
  },
  range: ([from, to, count], call) => {
    const n = integer(call, count, "count", 1);
    const a = magnitude(call, from, "from");
    const b = magnitude(call, to, "to");
    return Array.from({ length: n }, (_, i) =>
      withMagnitude(from, n === 1 ? a : i === n - 1 ? b : a + ((b - a) * i) / (n - 1)),
    );
  },
  tolerantSort: ([values, tolerance], call) => {
    const items = array(call, values, "values").map((value, index) => ({
      index,
      value: magnitude(call, value, "each value"),
    }));
    const tol = magnitude(call, tolerance, "tolerance");
    const sorted = [...items].sort((p, q) => p.value - q.value || p.index - q.index);
    // Values chained within tolerance of their sorted neighbor keep their original relative order.
    const result: number[] = [];
    for (let i = 0; i < sorted.length; ) {
      let j = i + 1;
      while (j < sorted.length && sorted[j]!.value - sorted[j - 1]!.value <= tol) j++;
      result.push(
        ...sorted
          .slice(i, j)
          .map((item) => item.index)
          .sort((p, q) => p - q),
      );
      i = j;
    }
    return result;
  },
  clusterPoints: ([points, tolerance], call) => {
    const pts = array(call, points, "points").map((p) => numbers(call, p, "point"));
    const tol = number(call, tolerance, "tolerance");
    const parent = pts.map((_, i) => i);
    const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)));
    for (let i = 0; i < pts.length; i++)
      for (let j = i + 1; j < pts.length; j++)
        if (Math.hypot(...pts[i]!.map((x, k) => x - pts[j]![k]!)) <= tol) parent[find(i)] = find(j);
    const clusters = new Map<number, number[]>();
    pts.forEach((_, i) => {
      const root = find(i);
      clusters.set(root, [...(clusters.get(root) ?? []), i]);
    });
    return [...clusters.values()];
  },

  isMatrix: ([value]) => {
    const v = untag(value);
    if (!Array.isArray(v) || v.length === 0) return false;
    const width = Array.isArray(untag(v[0])) ? (untag(v[0]) as FsArray).length : -1;
    return (
      width > 0 &&
      (v as FsArray).every(
        (row) =>
          Array.isArray(untag(row)) &&
          (untag(row) as FsArray).length === width &&
          (untag(row) as FsArray).every((x) => typeof untag(x) === "number"),
      )
    );
  },
  matrixMultiply: ([a, b], call) => {
    const m = rows(call, a, "matrix");
    if (isVector(b)) {
      const v = numbers(call, b, "vector");
      if (m[0]!.length !== v.length) call.fail("Matrix and vector sizes don't match.");
      return m.map((row) => row.reduce((sum, x, k) => sum + x * v[k]!, 0));
    }
    const n = rows(call, b, "matrix");
    if (m[0]!.length !== n.length) call.fail("Matrix sizes don't match.");
    return m.map((row) => n[0]!.map((_, j) => row.reduce((sum, x, k) => sum + x * n[k]![j]!, 0)));
  },
  matrixTranspose: ([a], call) => {
    const m = rows(call, a, "matrix");
    return m[0]!.map((_, j) => m.map((row) => row[j]!));
  },
  matrixIdentity: ([size], call) => {
    const n = integer(call, size, "size", 1);
    return Array.from({ length: n }, (_, i) =>
      Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)),
    );
  },
  matrixInverse: ([a], call) => inverse(call, rows(call, a, "matrix")),
  matrixDeterminant: ([a], call) => determinant(call, rows(call, a, "matrix")),
  matrixSum: ([a, b], call) => elementwise(call, a, b, (x, y) => x + y),
  matrixDifference: ([a, b], call) => elementwise(call, a, b, (x, y) => x - y),
  matrixCwiseProduct: ([a, b], call) => elementwise(call, a, b, (x, y) => x * y),
  matrixNegate: ([a], call) =>
    isVector(a)
      ? numbers(call, a, "vector").map((x) => -x)
      : rows(call, a, "matrix").map((row) => row.map((x) => -x)),
  matrixSquaredNorm: ([a], call) =>
    (isVector(a) ? numbers(call, a, "vector") : rows(call, a, "matrix").flat()).reduce(
      (sum, x) => sum + x * x,
      0,
    ),
  matrixRotation3d: ([axis, angle], call) => {
    const [x, y, z] = numbers(call, axis, "axis");
    if (x === undefined || y === undefined || z === undefined)
      return call.fail("axis must have 3 components.");
    const length = Math.hypot(x, y, z);
    if (length === 0) call.fail("axis must not be zero.");
    const [u, v, w] = [x / length, y / length, z / length];
    const t = number(call, angle, "angle");
    const c = Math.cos(t);
    const s = Math.sin(t);
    const k = 1 - c;
    // Rodrigues' rotation formula.
    return [
      [c + u * u * k, u * v * k - w * s, u * w * k + v * s],
      [v * u * k + w * s, c + v * v * k, v * w * k - u * s],
      [w * u * k - v * s, w * v * k + u * s, c + w * w * k],
    ];
  },
  normalize: ([vector], call) => {
    const v = numbers(call, vector, "vector");
    const length = Math.hypot(...v);
    if (length === 0) call.fail("Cannot normalize a zero vector.");
    return v.map((x) => x / length);
  },
} satisfies Partial<Record<StdBuiltinName, BuiltinImpl>>;
