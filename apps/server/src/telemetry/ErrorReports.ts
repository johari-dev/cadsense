/**
 * Server error reports for PostHog error tracking.
 *
 * {@link logger} sits beside the console logger (see serverLogger.ts) and turns every Error or
 * Fatal log into an {@link ErrorReport}, held in a small in-memory inbox. AnalyticsService takes
 * the held reports on its tick and decides what to send: nothing when analytics are off or have
 * no key, otherwise a few distinct reports per install per day. Taking clears the inbox, so it
 * never holds more than {@link MAX_HELD_REPORTS}.
 *
 * A report keeps what identifies a failure and nothing a user wrote:
 *
 * - `type`: the error's `_tag`, or its class name, or "Error" when the log has no cause
 * - `value`: the log message the code wrote, with local paths replaced by `<path>`
 * - stack frames: function name, file name (never the folder), line, and column
 *
 * The error's own message is never kept. It can quote a prompt, a file's contents, or a path.
 *
 * @module ErrorReports
 */
import * as Cause from "effect/Cause";
import * as Logger from "effect/Logger";

import type { ErrorReport } from "./AnalyticsEvents.ts";

/** Reports held until AnalyticsService takes them; later ones are dropped. */
export const MAX_HELD_REPORTS = 20;
const MAX_VALUE_LENGTH = 200;
const MAX_FRAMES = 30;

export interface HeldReport {
  /** Same for repeats of one failure: type, message, and the first frame in the app. */
  readonly fingerprint: string;
  readonly report: ErrorReport;
}

const held: HeldReport[] = [];

/** Returns the held reports, oldest first, and clears the inbox. */
export const takeReports = (): ReadonlyArray<HeldReport> => held.splice(0, held.length);

// Windows drive paths, home-relative paths, and POSIX paths of two or more segments.
const PATH = /[A-Za-z]:\\[^\s"'<>]*|~[\\/][^\s"'<>]*|(?:\/[^\s/"'<>]+){2,}\/?/g;
const scrub = (text: string) => {
  const scrubbed = text.replace(PATH, "<path>").trim();
  return scrubbed.length > MAX_VALUE_LENGTH
    ? `${scrubbed.slice(0, MAX_VALUE_LENGTH - 1)}…`
    : scrubbed;
};

const STACK_LINE = /^\s*at (?:(.+?) \()?(.+?):(\d+):(\d+)\)?$/;
const fileName = (path: string) => path.split(/[\\/]/).pop() ?? path;

/**
 * The frames below the error's `name: message` header. The message can span lines that look
 * like frames, so a stack that doesn't start with that exact header yields none.
 */
const framesOf = (error: unknown): ErrorReport["stacktrace"]["frames"] => {
  if (!(error instanceof Error) || error.stack === undefined) return [];
  const header = error.message ? `${error.name}: ${error.message}` : error.name;
  if (!error.stack.startsWith(header)) return [];
  return error.stack
    .slice(header.length)
    .split("\n")
    .flatMap((line) => {
      const match = STACK_LINE.exec(line);
      if (!match) return [];
      const [, fn, file = "", lineno = "0", colno = "0"] = match;
      return [
        {
          platform: "node:javascript" as const,
          filename: fileName(file),
          function: fn ?? "<anonymous>",
          lineno: Number(lineno),
          colno: Number(colno),
          in_app: !file.includes("node_modules") && !file.startsWith("node:"),
        },
      ];
    })
    .slice(0, MAX_FRAMES);
};

const typeOf = (error: unknown) => {
  if (typeof error === "object" && error !== null && "_tag" in error) {
    const tag = (error as { readonly _tag: unknown })._tag;
    if (typeof tag === "string") return tag;
  }
  return error instanceof Error ? error.name : "Error";
};

/**
 * The cause a log carries: as its own argument, as an Error argument (`tapError(logError)`), or
 * as a `cause` field of a record argument.
 */
const causeOf = (options: Logger.Options<unknown>, parts: ReadonlyArray<unknown>) => {
  if (options.cause.reasons.length > 0) return options.cause;
  for (const part of parts) {
    if (part instanceof Error) return Cause.fail(part);
    if (typeof part !== "object" || part === null || !("cause" in part)) continue;
    const cause: unknown = part.cause;
    if (Cause.isCause(cause) && cause.reasons.length > 0) return cause;
    if (cause instanceof Error) return Cause.fail(cause);
  }
  return undefined;
};

/** Holds an {@link ErrorReport} for each Error or Fatal log. Install it beside the console logger. */
export const logger = Logger.make((options) => {
  if (options.logLevel !== "Error" && options.logLevel !== "Fatal") return;
  if (held.length >= MAX_HELD_REPORTS) return;
  const parts: ReadonlyArray<unknown> = Array.isArray(options.message)
    ? options.message
    : [options.message];
  const value = scrub(parts.filter((part) => typeof part === "string").join(" ")) || "Error log";
  const cause = causeOf(options, parts);
  const error = cause === undefined ? undefined : Cause.squash(cause);
  const frames = framesOf(error);
  const type = cause === undefined ? "Error" : typeOf(error);
  const top = frames.find((frame) => frame.in_app);
  held.push({
    fingerprint: [type, value, top ? `${top.filename}:${top.lineno}` : ""].join("|"),
    report: {
      type,
      value,
      mechanism: { handled: true, synthetic: frames.length === 0 },
      stacktrace: { type: "raw", frames },
    },
  });
});
