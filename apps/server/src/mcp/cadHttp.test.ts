import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentId, ProviderInstanceId, ThreadId, TurnId } from "@cadsense/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpRouter } from "effect/unstable/http";
import { expect } from "vite-plus/test";
import { it } from "@effect/vitest";
import * as Capabilities from "../provider/ClaudeCadCapabilities.ts";
import { McpSessionRegistry } from "./McpSessionRegistry.ts";
import { routeLayer } from "./cadHttp.ts";

const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decode = Schema.decodeUnknownSync(
  Schema.Struct({
    result: Schema.Struct({
      isError: Schema.optionalKey(Schema.Boolean),
      content: Schema.optionalKey(
        Schema.Array(
          Schema.Struct({ type: Schema.String, data: Schema.optionalKey(Schema.String) }),
        ),
      ),
      tools: Schema.optionalKey(
        Schema.Array(
          Schema.Struct({
            name: Schema.String,
            inputSchema: Schema.Struct({ type: Schema.Literal("object") }),
          }),
        ),
      ),
    }),
  }),
);
it.effect("serves native images only for the authenticated session's one-use CAD capability", () =>
  Effect.gen(function* () {
    let capabilities: Capabilities.ClaudeCadCapabilities["Service"] | undefined;
    let active = true;
    const calls: unknown[] = [];
    const registration = Layer.effectDiscard(
      Effect.gen(function* () {
        capabilities = yield* Capabilities.ClaudeCadCapabilities;
        yield* capabilities.register(
          "native-session",
          {
            invoke: (_child, _turn, _name, input) =>
              Effect.sync(() => {
                calls.push(input);
                return { result: { revision: 3 }, png: new Uint8Array([1, 2, 3]) };
              }),
            end: () => Effect.void,
            close: Effect.void,
          },
          () => active,
        );
      }),
    ).pipe(Layer.provideMerge(Capabilities.layer));
    const registry = McpSessionRegistry.of({
      issue: () => Effect.die("unused"),
      touch: () => Effect.void,
      revokeProviderSession: () => Effect.void,
      revokeThread: () => Effect.void,
      revokeAll: Effect.void,
      resolve: (token) =>
        Effect.succeed(
          token === "test-only"
            ? {
                environmentId: EnvironmentId.make("test"),
                threadId: ThreadId.make("test"),
                providerInstanceId: ProviderInstanceId.make("claudeAgent"),
                providerSessionId: "native-session",
                capabilities: new Set(["preview"] as const),
                issuedAt: 0,
              }
            : undefined,
        ),
    });
    const app = HttpRouter.toWebHandler(
      routeLayer.pipe(
        Layer.provideMerge(registration),
        Layer.provideMerge(Layer.succeed(McpSessionRegistry, registry)),
        Layer.provide(NodeServices.layer),
      ),
      { disableLogger: true },
    );
    yield* Effect.addFinalizer(() => Effect.promise(() => app.dispose()));
    const request = (method: string, params?: unknown, authorization = "Bearer test-only") =>
      Effect.promise(() =>
        app.handler(
          new Request("http://localhost/mcp/cad", {
            method: "POST",
            headers: { authorization, "content-type": "application/json" },
            body: encode({ jsonrpc: "2.0", id: 1, method, params }),
          }),
        ),
      );
    const response = (method: string, params?: unknown) =>
      request(method, params).pipe(
        Effect.flatMap((result) => Effect.promise(() => result.json())),
        Effect.map(decode),
      );
    expect((yield* request("tools/list", undefined, "")).status).toBe(401);
    const listed = yield* request("tools/list");
    expect(listed.headers.get("cache-control")).toBe("no-store");
    expect(
      decode(yield* Effect.promise(() => listed.json())).result.tools?.map((tool) => tool.name),
    ).toEqual(["cad_context", "cad_hierarchy", "cad_update_view", "cad_capture"]);
    const token = yield* capabilities!.issue(
      "native-session",
      "child",
      TurnId.make("turn"),
      "cad_capture",
      {
        expectedRevision: 3,
      },
    );
    const params = {
      name: "cad_capture",
      arguments: { _cadsenseCapability: token, expectedRevision: 999, agentID: "forged" },
    };
    const result = (yield* response("tools/call", params)).result;
    expect(result.isError).toBe(false);
    expect(result.content?.[1]).toEqual({ type: "image", data: "AQID" });
    expect(calls).toEqual([{ expectedRevision: 3 }]);
    expect((yield* response("tools/call", params)).result.isError).toBe(true);
    const late = yield* capabilities!.issue(
      "native-session",
      "child",
      TurnId.make("turn"),
      "cad_capture",
      {},
    );
    active = false;
    expect(
      (yield* response("tools/call", {
        name: "cad_capture",
        arguments: { _cadsenseCapability: late },
      })).result.isError,
    ).toBe(true);
    expect(calls).toHaveLength(1);
  }).pipe(Effect.scoped),
);
