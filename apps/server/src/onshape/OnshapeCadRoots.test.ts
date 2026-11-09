import {
  OnshapeConnectionId,
  OnshapeDocumentId,
  OnshapeElementId,
  OnshapeProjectSource,
  OnshapeRateLimitError,
  OnshapeWorkspaceId,
} from "@cadsense/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

import { OnshapeConnections, type OnshapeConnectionsShape } from "./OnshapeConnections.ts";
import * as CadRoots from "./OnshapeCadRoots.ts";
import * as RecentElements from "./OnshapeRecentElements.ts";

const source = OnshapeProjectSource.make({
  connectionId: OnshapeConnectionId.make("00000000-0000-4000-8000-000000000001"),
  host: "https://team.onshape.com",
  documentId: OnshapeDocumentId.make("aaaaaaaaaaaaaaaaaaaaaaaa"),
  workspaceType: "w",
  workspaceId: OnshapeWorkspaceId.make("bbbbbbbbbbbbbbbbbbbbbbbb"),
  configuration: "Size=Large & Color=Blue+White",
});
const microversionId = OnshapeWorkspaceId.make("cccccccccccccccccccccccc");
const assemblyId = OnshapeElementId.make("dddddddddddddddddddddddd");
const studioId = OnshapeElementId.make("eeeeeeeeeeeeeeeeeeeeeeee");
const drawingId = OnshapeElementId.make("ffffffffffffffffffffffff");
const elements = [
  { id: assemblyId, name: "Intake assembly", elementType: "ASSEMBLY", extra: "not returned" },
  { id: studioId, name: "", elementType: "PARTSTUDIO" },
  { id: drawingId, name: "Drawing", elementType: "DRAWING" },
];
const unused = () => Effect.die("Unexpected connection operation");

const makeHarness = Effect.fn(function* (options?: {
  readonly microversionResponse?: unknown;
  readonly elementsResponse?: unknown;
  readonly failRequest?: number;
}) {
  const requests = yield* Ref.make<Parameters<OnshapeConnectionsShape["readJson"]>[0][]>([]);
  const connections = OnshapeConnections.of({
    list: unused,
    create: unused,
    rename: unused,
    setApiLimit: unused,
    apiUsage: unused,
    replaceCredentials: unused,
    remove: unused,
    readBinary: unused,
    readJson: (request) =>
      Effect.gen(function* () {
        yield* Ref.update(requests, (values) => [...values, request]);
        const count = (yield* Ref.get(requests)).length;
        if (count === options?.failRequest) return yield* new OnshapeRateLimitError({});
        return request.path.endsWith("currentmicroversion")
          ? (options?.microversionResponse ?? { microversion: microversionId })
          : (options?.elementsResponse ?? elements);
      }),
  });
  const recent = yield* RecentElements.make;
  const service = yield* CadRoots.make.pipe(
    Effect.provideService(OnshapeConnections, connections),
    Effect.provideService(RecentElements.OnshapeRecentElements, recent),
  );
  return { service, requests, recent };
});

describe("Onshape CAD root discovery", () => {
  it.effect("does no work when constructed", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      assert.deepStrictEqual(yield* Ref.get(harness.requests), []);
    }),
  );

  it.effect.each(["w", "v"] as const)(
    "lists %s elements in one request and preserves configuration",
    (workspaceType) =>
      Effect.gen(function* () {
        const revised = elements.map((element, i) => ({
          ...element,
          microversionId: String(i + 1).repeat(24),
        }));
        const harness = yield* makeHarness({ elementsResponse: revised });
        const input = { ...source, workspaceType };
        const result = yield* harness.service.discover(input);
        assert.deepStrictEqual(result.roots, [
          { elementId: assemblyId, name: "Intake assembly", kind: "assembly" },
          { elementId: studioId, name: studioId, kind: "part-studio" },
        ]);
        assert.match(result.microversionId, /^[a-f0-9]{24}$/);
        assert.deepStrictEqual(yield* Ref.get(harness.requests), [
          {
            connectionId: source.connectionId,
            host: source.host,
            path: `/api/v17/documents/d/${source.documentId}/${workspaceType}/${source.workspaceId}/elements`,
            query: "withThumbnails=false",
          },
        ]);
        assert.strictEqual(input.configuration, "Size=Large & Color=Blue+White");
        // A first sync right after discovery records this list instead of reading it.
        assert.isTrue(Option.isSome(yield* harness.recent.take(input)));
        // The stand-in revision changes only with an element revision.
        revised[1]!.microversionId = "9".repeat(24);
        const edited = yield* harness.service.discover(input);
        assert.notStrictEqual(edited.microversionId, result.microversionId);
      }),
  );

  it.effect("pins the revision when elements omit their revisions", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const result = yield* harness.service.discover(source);
      assert.strictEqual(result.microversionId, microversionId);
      const requests = yield* Ref.get(harness.requests);
      assert.deepStrictEqual(
        requests.map((request) => request.path.split("/").at(-1)),
        ["elements", "currentmicroversion"],
      );
    }),
  );

  it.effect("uses a supplied microversion with one request", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const result = yield* harness.service.discover({ ...source, workspaceType: "m" });
      assert.strictEqual(result.microversionId, source.workspaceId);
      const requests = yield* Ref.get(harness.requests);
      assert.strictEqual(requests.length, 1);
      assert.include(requests[0]?.path ?? "", `/m/${source.workspaceId}/elements`);
      // Microversion links never take the bulk path that records element lists.
      assert.isTrue(Option.isNone(yield* harness.recent.take({ ...source, workspaceType: "m" })));
    }),
  );

  it.effect("keeps all roots with an element link as the initial selection hint", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const result = yield* harness.service.discover({ ...source, elementId: assemblyId });
      assert.deepStrictEqual(result.roots, [
        { elementId: assemblyId, name: "Intake assembly", kind: "assembly" },
        { elementId: studioId, name: studioId, kind: "part-studio" },
      ]);
      assert.deepStrictEqual(result.sourceElement, { elementId: assemblyId, status: "available" });
    }),
  );

  it.effect.each([
    { elementId: OnshapeElementId.make("111111111111111111111111"), status: "missing" },
    { elementId: drawingId, status: "unsupported" },
  ] as const)(
    "reports a $status element hint without substituting another root",
    ({ elementId, status }) =>
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        const result = yield* harness.service.discover({ ...source, elementId });
        assert.deepStrictEqual(result.sourceElement, { elementId, status });
        assert.strictEqual(result.roots.length, 2);
      }),
  );

  it.effect.each([[], [elements[2]]])(
    "returns an empty catalog for valid unsupported-only documents %#",
    (elementsResponse) =>
      Effect.gen(function* () {
        const harness = yield* makeHarness({ elementsResponse });
        assert.deepStrictEqual((yield* harness.service.discover(source)).roots, []);
      }),
  );

  it.effect.each([
    { microversionResponse: {} },
    { microversionResponse: { microversion: "not-an-id" } },
    { elementsResponse: { items: elements } },
    { elementsResponse: [{ id: assemblyId, elementType: "ASSEMBLY" }] },
    { elementsResponse: [{ id: "bad-id", name: "Private name", elementType: "ASSEMBLY" }] },
    { elementsResponse: [elements[0], elements[0]] },
  ])("rejects malformed metadata rather than presenting an empty result %#", (options) =>
    Effect.gen(function* () {
      const harness = yield* makeHarness(options);
      const error = yield* Effect.flip(harness.service.discover(source));
      assert.strictEqual(error._tag, "OnshapeCadRootsError");
      assert.strictEqual(error._tag === "OnshapeCadRootsError" && error.reason, "invalid-response");
      assert.notInclude(String(error), "Private name");
      assert.strictEqual(
        (yield* Ref.get(harness.requests)).length,
        "microversionResponse" in options ? 2 : 1,
      );
    }),
  );

  it.effect.each([1, 2])("preserves quota failures without retrying request %s", (failRequest) =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ failRequest });
      const error = yield* Effect.flip(harness.service.discover(source));
      assert.strictEqual(error._tag, "OnshapeRateLimitError");
      assert.strictEqual((yield* Ref.get(harness.requests)).length, failRequest);
    }),
  );
});
