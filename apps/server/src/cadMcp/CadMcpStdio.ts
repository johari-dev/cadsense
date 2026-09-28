import * as NodeReadline from "node:readline";
import * as Effect from "effect/Effect";
import * as FiberMap from "effect/FiberMap";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

/** An MCP `CallToolResult`. Tool failures are results with `isError`, not JSON-RPC errors. */
export interface CadMcpToolResult {
  readonly isError: boolean;
  readonly content: ReadonlyArray<
    | { readonly type: "text"; readonly text: string }
    | { readonly type: "image"; readonly mimeType: string; readonly data: string }
  >;
  readonly structuredContent?: unknown;
}
export interface CadMcpToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: object;
  readonly annotations: {
    readonly readOnlyHint: boolean;
    readonly destructiveHint: boolean;
    readonly openWorldHint: boolean;
  };
}
export type CadMcpCall = (name: string, input: unknown) => Effect.Effect<CadMcpToolResult>;
export interface CadMcpClientInfo {
  readonly name: string;
  readonly version: string;
}

export interface CadMcpStdioOptions<E> {
  readonly version: string;
  readonly instructions: string;
  readonly tools: ReadonlyArray<CadMcpToolDefinition>;
  /** Resolves once the server can run tools. `initialize` and `tools/list` answer before then. */
  readonly ready: Effect.Effect<CadMcpCall, E>;
  readonly onInitialize: (client: CadMcpClientInfo) => void;
}

// Newest first. Results only use fields every listed revision accepts or ignores.
const PROTOCOL_VERSIONS = new Set(["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"]);
const decodeMessage = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      jsonrpc: Schema.Literal("2.0"),
      id: Schema.optionalKey(Schema.Union([Schema.String, Schema.Number])),
      method: Schema.optionalKey(Schema.String),
      params: Schema.optionalKey(Schema.Unknown),
    }),
  ),
);
const decodeInitialize = Schema.decodeUnknownEffect(
  Schema.Struct({
    protocolVersion: Schema.String,
    clientInfo: Schema.optionalKey(Schema.Struct({ name: Schema.String, version: Schema.String })),
  }),
);
const decodeCall = Schema.decodeUnknownEffect(
  Schema.Struct({ name: Schema.String, arguments: Schema.optionalKey(Schema.Unknown) }),
);
const decodeCancelled = Schema.decodeUnknownEffect(
  Schema.Struct({ requestId: Schema.Union([Schema.String, Schema.Number]) }),
);

interface RpcError {
  readonly code: number;
  readonly message: string;
}
const invalidParams = (): RpcError => ({ code: -32602, message: "Invalid params" });

const encodeMessage = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const write = (message: object) =>
  Effect.sync(() => {
    process.stdout.write(`${encodeMessage(message)}\n`);
  });

/**
 * Serves MCP over stdio as newline-delimited JSON-RPC until stdin closes. This is hand-written
 * because the server must answer `initialize` before the backend finishes starting (Codex waits
 * 10 seconds by default) and must send `instructions`, which Effect's `McpServer` omits.
 * Requests run concurrently, so `ping` and cancellation work during long tool calls.
 */
export const serveCadMcpStdio = Effect.fn("serveCadMcpStdio")(function* <E>(
  options: CadMcpStdioOptions<E>,
) {
  const calls = yield* FiberMap.make<string | number>();
  const handle = Effect.fn("CadMcpStdio.handle")(function* (
    method: string,
    params: unknown,
  ): Effect.fn.Return<unknown, RpcError> {
    switch (method) {
      case "initialize": {
        const init = yield* decodeInitialize(params).pipe(Effect.mapError(invalidParams));
        if (init.clientInfo) options.onInitialize(init.clientInfo);
        return {
          protocolVersion: PROTOCOL_VERSIONS.has(init.protocolVersion)
            ? init.protocolVersion
            : "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "cadsense", version: options.version },
          instructions: options.instructions,
        };
      }
      case "ping":
        return {};
      case "tools/list":
        return { tools: options.tools };
      case "tools/call": {
        const call = yield* decodeCall(params).pipe(Effect.mapError(invalidParams));
        if (!options.tools.some((tool) => tool.name === call.name))
          return yield* Effect.fail({ code: -32602, message: `Unknown tool: ${call.name}` });
        const run = yield* options.ready.pipe(Effect.option);
        if (Option.isNone(run))
          return {
            isError: true,
            content: [{ type: "text", text: "Cadsense failed to start. Check its stderr log." }],
          } satisfies CadMcpToolResult;
        return yield* run.value(call.name, call.arguments ?? {});
      }
      default:
        return yield* Effect.fail({ code: -32601, message: "Method not found" });
    }
  });
  const receive = Effect.fn("CadMcpStdio.receive")(function* (line: string) {
    if (line.trim().length === 0) return;
    const decoded = yield* decodeMessage(line).pipe(Effect.option);
    if (Option.isNone(decoded))
      return yield* write({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "Parse error" },
      });
    const { id, method, params } = decoded.value;
    // Responses to server requests carry no method. This server sends no requests.
    if (method === undefined) return;
    if (id === undefined) {
      if (method === "notifications/cancelled") {
        const cancelled = yield* decodeCancelled(params).pipe(Effect.option);
        if (Option.isSome(cancelled)) yield* FiberMap.remove(calls, cancelled.value.requestId);
      }
      return;
    }
    yield* FiberMap.run(
      calls,
      id,
      handle(method, params).pipe(
        Effect.matchEffect({
          onSuccess: (result) => write({ jsonrpc: "2.0", id, result }),
          onFailure: (error) => write({ jsonrpc: "2.0", id, error }),
        }),
      ),
    );
  });
  const lines = NodeReadline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  yield* Effect.addFinalizer(() => Effect.sync(() => lines.close()));
  yield* Stream.fromAsyncIterable(lines, (cause) => cause).pipe(
    Stream.runForEach(receive),
    Effect.ignore,
  );
});
