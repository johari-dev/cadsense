import type { Span } from "../syntax/Source.ts";
import type { FsValue } from "./Value.ts";

/** One FeatureScript call on the stack: the function called, and where the call happened. */
export interface FsFrame {
  readonly function: string;
  readonly file: string;
  readonly span: Span;
}

/**
 * A FeatureScript exception: a `throw`, or a language error such as reading a field of `undefined`.
 * `try` catches these. Language errors carry a string, library errors usually a map with a `message`.
 * Not an `Error` subclass: std throws and catches these constantly, and stack capture is expensive.
 */
export class FsThrow {
  readonly value: FsValue;
  readonly stack: readonly FsFrame[];
  constructor(value: FsValue, stack: readonly FsFrame[]) {
    this.value = value;
    this.stack = stack;
  }
}

export type FaultReason =
  /** A native builtin this runtime doesn't implement yet. */
  | "unsupported-builtin"
  /** A name that doesn't resolve; Onshape would reject the module before running it. */
  | "unresolved-name"
  /** Step or recursion limit. */
  | "limit"
  /** A bug in this runtime. */
  | "internal";

/**
 * A failure FeatureScript code must not be able to catch. Letting `try silent` swallow these would
 * turn "we can't run this locally" into silently wrong results.
 */
export class FsFault extends Error {
  readonly reason: FaultReason;
  readonly fsStack: readonly FsFrame[];
  constructor(reason: FaultReason, message: string, fsStack: readonly FsFrame[]) {
    super(message);
    this.name = "FsFault";
    this.reason = reason;
    this.fsStack = fsStack;
  }
}
