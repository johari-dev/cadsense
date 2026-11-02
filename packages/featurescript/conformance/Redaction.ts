// @effect-diagnostics nodeBuiltinImport:off - reads the key file and prints for the command line.
import * as NodeFS from "node:fs";

/**
 * The recorder's redaction boundary. The first line of defense is that the recorder never keeps or
 * prints what a response says beyond the schema-decoded fields a comparison needs and fixed
 * diagnostic codes. This module is the second: {@link Credentials} only exist validated; every
 * response is checked as received (`OnshapeClient.send`, with {@link Credentials.exposedIn} and
 * {@link Credentials.exposedInValue}) and every write is checked again; anything printed goes
 * through {@link Credentials.safe}.
 */

/** Real Onshape keys are 24 and 48 characters; anything under this is a malformed key file. */
const MIN_KEY_LENGTH = 8;

export class InvalidKey extends Error {}

/** An Onshape API key. The id and secret live in private fields, so inspecting it never shows them. */
export class Credentials {
  readonly #accessKeyId: string;
  readonly #secretKey: string;
  readonly #needles: readonly string[];

  private constructor(accessKeyId: string, secretKey: string) {
    this.#accessKeyId = accessKeyId;
    this.#secretKey = secretKey;
    const pair = `${accessKeyId}:${secretKey}`;
    const token = Buffer.from(pair, "utf8").toString("base64");
    const forms = [`Basic ${token}`, token, pair, accessKeyId, secretKey];
    // Also as they'd appear inside a JSON string or a URL.
    const variants = forms.flatMap((form) => [
      form,
      JSON.stringify(form).slice(1, -1),
      encodeURIComponent(form),
    ]);
    this.#needles = [...new Set(variants)].sort((a, b) => b.length - a.length);
  }

  /** Checks a key's parts: both strings of at least 8 characters, or {@link InvalidKey}. */
  static of(accessKeyId: unknown, secretKey: unknown): Credentials {
    for (const [name, part] of [
      ["accessKeyId", accessKeyId],
      ["secretKey", secretKey],
    ] as const)
      if (typeof part !== "string" || part.length < MIN_KEY_LENGTH)
        throw new InvalidKey(
          `The key's ${name} must be a string of at least ${MIN_KEY_LENGTH} characters.`,
        );
    return new Credentials(String(accessKeyId), String(secretKey));
  }

  /** The Authorization header value. */
  header(): string {
    return `Basic ${Buffer.from(`${this.#accessKeyId}:${this.#secretKey}`, "utf8").toString("base64")}`;
  }

  /** `text` with the header, its token, `id:secret`, the id and the secret replaced. */
  redact(text: string): string {
    return this.#needles.reduce((out, needle) => out.split(needle).join("<redacted>"), text);
  }

  /**
   * Whether `text` holds the key in one of the spellings this checks: the Authorization header, its
   * base64 token, `id:secret`, the id or the secret, each as is, with all whitespace removed (so base64
   * wrapped across lines, LF or CRLF), then with \uXXXX escapes decoded, then with %XX escapes
   * decoded. Whitespace written as an escape (\u000a, %0A, a literal backslash-n) isn't removed.
   * Pass decoded text, not JSON: use {@link exposedInValue} for values.
   *
   * It doesn't catch other spellings (hex, base64 of the id or secret alone, base64url, characters
   * such as zero-width joiners inserted), and doesn't try to: a deny-list can't be complete. The
   * threat model is that nothing real can put the key in what the recorder keeps. Onshape's
   * FeatureScript can't see request headers, so a probe value never holds it, and the recorder keeps
   * no response text beyond decoded probe fields. This check is a second line for an echo by
   * something in between, such as a proxy that copies headers into a body: every response is
   * checked with it as received, and every write is checked again.
   */
  exposedIn(text: string): boolean {
    const compact = text.replace(/\s+/g, "");
    const unescaped = compact.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex: string) =>
      String.fromCharCode(Number.parseInt(hex, 16)),
    );
    const decoded = unescaped.replace(/%([0-9a-fA-F]{2})/g, (_, hex: string) =>
      String.fromCharCode(Number.parseInt(hex, 16)),
    );
    return [text, compact, unescaped, decoded].some((form) =>
      this.#needles.some((needle) => form.includes(needle)),
    );
  }

  /**
   * Whether any string in `value` (keys included) is {@link exposedIn}. Each string is checked as
   * itself, before it's encoded: in JSON text a newline is the two characters `\n`, which no
   * whitespace rule removes. The walk keeps its own stack, so a value nested thousands of levels
   * deep gets a verdict rather than overflowing the call stack.
   */
  exposedInValue(value: unknown): boolean {
    const pending: unknown[] = [value];
    const seen = new WeakSet<object>();
    while (pending.length > 0) {
      const next = pending.pop();
      if (typeof next === "string") {
        if (this.exposedIn(next)) return true;
      } else if (typeof next === "object" && next !== null && !seen.has(next)) {
        seen.add(next);
        if (Array.isArray(next)) for (const entry of next) pending.push(entry);
        else
          for (const [entryKey, entry] of Object.entries(next)) {
            if (this.exposedIn(entryKey)) return true;
            pending.push(entry);
          }
      }
    }
    return false;
  }

  /** `text` for printing: withheld whole if {@link exposedIn}, else redacted. */
  safe(text: string): string {
    return this.exposedIn(text) ? "<withheld: it contains the API key>" : this.redact(text);
  }
}

export const credentials = (accessKeyId: unknown, secretKey: unknown): Credentials =>
  Credentials.of(accessKeyId, secretKey);

/** The key in an API key file. Its errors never quote the file, which holds the secret. */
export function readCredentials(file: string): Credentials {
  let key: unknown;
  try {
    key = JSON.parse(NodeFS.readFileSync(file, "utf8"));
  } catch {
    throw new InvalidKey(`The key file ${file} can't be read as JSON.`);
  }
  const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
    typeof value === "object" && value !== null && !Array.isArray(value);
  if (!isRecord(key))
    throw new InvalidKey(`The key file ${file} holds no accessKeyId and secretKey.`);
  return Credentials.of(key.accessKeyId, key.secretKey);
}

/**
 * A stack frame line exactly as V8 prints one: `    at [async |new ]name (location)` or
 * `    at [async ]location`, where the name is plain characters and the location a file: or node:
 * URL with a line and column. Any other line in a stack is text an error put there.
 */
const STACK_FRAME =
  /^ {4}at (?:(?:async |new )?[\w$.<>[\] ]{1,200} \((?:file:\/\/\/|node:)[\w/.@%+~-]{1,1000}:\d+:\d+\)|(?:async )?(?:file:\/\/\/|node:)[\w/.@%+~-]{1,1000}:\d+:\d+)$/;

/**
 * Anything thrown, for a crash report: an error's name, message and stack frames, then its
 * cause's, four deep. A thrown string shows through {@link Credentials.safe}; anything else that
 * isn't an Error (an object, a number) shows as its type only, never inspected.
 *
 * An error whose raw stack holds the key in a spelling {@link Credentials.exposedIn} checks is
 * withheld whole. Otherwise the name and message go through {@link Credentials.safe} (or show as
 * their type when they aren't strings, never through their own toString), and frames are only
 * lines after the stack's header (`Error.prototype.toString` of the error as it is now) that parse
 * strictly as V8 frames ({@link STACK_FRAME}). So the name and message an error has when its stack
 * is formatted can't forge a frame, but a message changed afterwards can leave text from the old
 * one, and a frame-shaped line in it prints as a frame. That's why the whole report is checked
 * again before it's returned. Every read of the error is guarded (a getter
 * or a proxy can throw), and this never throws: at worst it returns a fixed line. With `frames:
 * false` it's one headline, as for a process warning.
 */
export const describeThrown = (
  thrown: unknown,
  credentials: Credentials | null,
  options: { readonly frames?: boolean } = {},
): string => {
  const safe = (text: string) => (credentials ? credentials.safe(text) : text);
  /** A name or message: a string through `safe`; anything else (an object, a symbol) as its type. */
  const shown = (value: unknown) => (typeof value === "string" ? safe(value) : `<${typeof value}>`);
  /** Reads `field` of an error, or a marker when the read throws (a getter, a proxy). */
  const UNREADABLE = Symbol("unreadable");
  const read = (error: Error, field: "name" | "message" | "cause" | "stack"): unknown => {
    try {
      return error[field];
    } catch {
      return UNREADABLE;
    }
  };
  const isError = (value: unknown): value is Error => {
    try {
      return value instanceof Error;
    } catch {
      return false;
    }
  };
  const framesOf = (error: Error, stack: string) => {
    let header: string;
    try {
      header = Error.prototype.toString.call(error);
    } catch {
      return [];
    }
    if (!stack.startsWith(header)) return [];
    return stack
      .slice(header.length)
      .split("\n")
      .filter((line) => STACK_FRAME.test(line));
  };
  const describe = (value: unknown, depth: number): string => {
    // Never inspected: inspect spells a newline as `\n` and doubles backslashes, which hides the
    // spellings `safe` checks. A string is checked as it is; anything else shows as its type.
    if (!isError(value))
      return typeof value === "string" ? `string: ${safe(value)}` : `<${typeof value}>`;
    const error = value;
    // Reading the stack formats it, which throws for some names (a symbol); then there are no frames.
    const rawStack = read(error, "stack");
    const stack = typeof rawStack === "string" ? rawStack : "";
    if (credentials?.exposedIn(stack)) return "<an error whose stack holds the API key, withheld>";
    const frames = options.frames === false ? [] : framesOf(error, stack);
    const name = read(error, "name");
    const message = read(error, "message");
    const causeValue = read(error, "cause");
    const cause =
      causeValue !== undefined && depth < 4
        ? `\ncause: ${causeValue === UNREADABLE ? "<unreadable>" : describe(causeValue, depth + 1)}`
        : "";
    const part = (field: unknown) => (field === UNREADABLE ? "<unreadable>" : shown(field));
    return `${part(name)}: ${part(message)}${frames.length ? `\n${frames.join("\n")}` : ""}${cause}`;
  };
  try {
    return safe(describe(thrown, 0));
  } catch {
    return "<an error this report couldn't describe>";
  }
};

/**
 * Runs a command line's `main` so nothing it prints can carry a credential. `print` is the only
 * way to print; `protect` hands over the key once `main` has read it. A throw from `main`, an
 * uncaught exception or an unhandled rejection is reported by {@link describeThrown}, with exit
 * code 1. Process warnings replace Node's own printer and go through the same check.
 */
export async function runRedacted(
  main: (io: {
    readonly print: (line: string) => void;
    readonly protect: (credentials: Credentials) => void;
  }) => Promise<number>,
): Promise<never> {
  let key: Credentials | null = null;
  const safe = (text: string) => (key ? key.safe(text) : text);
  const print = (line: string) => process.stdout.write(`${safe(line)}\n`);
  // Never throws: Node would print whatever escaped from here, raw.
  const crash = (thrown: unknown): never => {
    try {
      process.stderr.write(`Unexpected ${describeThrown(thrown, key)}\n`);
    } catch {
      // Nothing further can be said safely; the exit code tells the rest.
    }
    return process.exit(1);
  };
  process.on("uncaughtException", crash);
  process.on("unhandledRejection", crash);
  // Node prints warnings through its own 'warning' listener; this one replaces it, and prints
  // through the same guarded printer as a crash, without frames.
  process.removeAllListeners("warning");
  process.on("warning", (warning) => {
    try {
      process.stderr.write(`${describeThrown(warning, key, { frames: false })}\n`);
    } catch {
      // A warning that can't be printed safely isn't printed.
    }
  });
  try {
    return process.exit(await main({ print, protect: (credentials) => (key = credentials) }));
  } catch (error) {
    return crash(error);
  }
}
