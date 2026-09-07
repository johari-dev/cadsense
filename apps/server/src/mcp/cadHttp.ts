import { CadViewError } from "@cadsense/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import {
  ClaudeCadCapabilities,
  CLAUDE_CAD_CAPABILITY_FIELD,
} from "../provider/ClaudeCadCapabilities.ts";
import { cadToolDefinitions } from "../provider/CadProviderTools.ts";
import { McpSessionRegistry } from "./McpSessionRegistry.ts";

const Request = Schema.Struct({
  jsonrpc: Schema.Literal("2.0"),
  id: Schema.optionalKey(Schema.Union([Schema.String, Schema.Number])),
  method: Schema.String,
  params: Schema.optionalKey(Schema.Unknown),
});
const decodeRequest = Schema.decodeUnknownEffect(Request);
const decodeCall = Schema.decodeUnknownEffect(
  Schema.Struct({
    name: Schema.String,
    arguments: Schema.Struct({
      [CLAUDE_CAD_CAPABILITY_FIELD]: Schema.String.check(Schema.isUUID(4)),
    }),
  }),
);
const encodeResult = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const encodeError = Schema.encodeSync(Schema.fromJsonString(CadViewError));
const headers = { "cache-control": "no-store" };
const handle = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const registry = yield* McpSessionRegistry;
  const capabilities = yield* ClaudeCadCapabilities;
  const authorization = request.headers.authorization;
  const token = authorization?.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
  const invocation = yield* registry.resolve(token);
  if (!invocation || !(yield* capabilities.available(invocation.providerSessionId)))
    return HttpServerResponse.empty({ status: 401, headers });
  const body = yield* request.json.pipe(Effect.flatMap(decodeRequest));
  if (body.id === undefined) return HttpServerResponse.empty({ status: 202, headers });
  const reply = (result: unknown) =>
    HttpServerResponse.json({ jsonrpc: "2.0", id: body.id, result }, { headers });
  switch (body.method) {
    case "initialize":
      return yield* reply({
        protocolVersion: "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "cadsense-cad", version: "1.0.0" },
      });
    case "ping":
      return yield* reply({});
    case "tools/list":
      return yield* reply({
        tools: cadToolDefinitions.map(({ type: _type, ...tool }) => ({
          ...tool,
          annotations: {
            readOnlyHint:
              tool.name === "cad_context" ||
              tool.name === "cad_hierarchy" ||
              tool.name === "cad_search",
            destructiveHint: false,
            openWorldHint: false,
          },
        })),
      });
    case "tools/call": {
      const result = yield* Effect.gen(function* () {
        const call = yield* decodeCall(body.params).pipe(
          Effect.mapError(() => new CadViewError({ reason: "capability-unavailable" })),
        );
        const delivery = yield* capabilities.consume(
          invocation.providerSessionId,
          call.arguments[CLAUDE_CAD_CAPABILITY_FIELD],
          call.name,
        );
        const text = yield* encodeResult(delivery.result).pipe(
          Effect.mapError(() => new CadViewError({ reason: "capability-unavailable" })),
        );
        return {
          isError: false,
          structuredContent: delivery.result,
          content: [
            { type: "text", text },
            ...(delivery.png
              ? [
                  {
                    type: "image",
                    mimeType: "image/png",
                    data: Buffer.from(delivery.png).toString("base64"),
                  },
                ]
              : []),
          ],
        };
      }).pipe(
        Effect.catch((error) =>
          Effect.succeed({ isError: true, content: [{ type: "text", text: encodeError(error) }] }),
        ),
      );
      return yield* reply(result);
    }
    default:
      return yield* HttpServerResponse.json(
        { jsonrpc: "2.0", id: body.id, error: { code: -32601, message: "Method not found" } },
        { headers },
      );
  }
}).pipe(
  Effect.provideService(HttpServerRequest.MaxBodySize, FileSystem.Size(1024 ** 2)),
  Effect.orElseSucceed(() => HttpServerResponse.empty({ status: 400, headers })),
);
export const routeLayer = HttpRouter.add("POST", "/mcp/cad", handle);
