import {
  OnshapeConnectionId,
  OnshapeDocumentId,
  OnshapeElementId,
  OnshapeWorkspaceId,
} from "@cadsense/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import * as OnshapeSourceUrl from "./OnshapeSourceUrl.ts";

const connectionId = OnshapeConnectionId.make("00000000-0000-4000-8000-000000000001");
const connection = {
  connectionId,
  host: "https://cad.onshape.com",
} as const;
const documentId = "05760c4d8b40fba37db8fa48";
const workspaceId = "f31b499c519e8471cced93dc";
const elementId = "b53dde24ab8b46d679af9944";

describe("Onshape source URLs", () => {
  it.effect("parses an element URL without making it broader than its configured host", () =>
    Effect.gen(function* () {
      const source = yield* OnshapeSourceUrl.parse({
        connection,
        url: `https://cad.onshape.com/documents/${documentId}/w/${workspaceId}/e/${elementId}?configuration=Size%3DLarge&uiState=ignored`,
      });

      assert.deepStrictEqual(source, {
        connectionId,
        host: "https://cad.onshape.com",
        documentId: OnshapeDocumentId.make(documentId),
        workspaceType: "w",
        workspaceId: OnshapeWorkspaceId.make(workspaceId),
        elementId: OnshapeElementId.make(elementId),
        configuration: "Size=Large",
      });
    }),
  );

  it.effect("preserves a document context without silently choosing an element", () =>
    Effect.gen(function* () {
      const source = yield* OnshapeSourceUrl.parse({
        connection,
        url: `https://cad.onshape.com/documents/${documentId}/v/${workspaceId}/`,
      });

      assert.isUndefined(source.elementId);
      assert.strictEqual(source.workspaceType, "v");
      assert.strictEqual(source.configuration, "");
    }),
  );

  it.effect("supports a configured enterprise Onshape stack", () =>
    Effect.gen(function* () {
      const source = yield* OnshapeSourceUrl.parse({
        connection: { connectionId, host: "https://team.example.onshape.com" },
        url: `https://team.example.onshape.com/documents/${documentId}/m/${workspaceId}/e/${elementId}`,
      });

      assert.strictEqual(source.host, "https://team.example.onshape.com");
      assert.strictEqual(source.workspaceType, "m");
    }),
  );

  it.effect("reports a host mismatch without accepting a lookalike domain", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        OnshapeSourceUrl.parse({
          connection,
          url: `https://cad.onshape.com.attacker.example/documents/${documentId}/w/${workspaceId}`,
        }),
      );

      assert.strictEqual(error._tag, "OnshapeProjectHostMismatchError");
    }),
  );

  it.effect("rejects insecure, ambiguous, and incomplete URLs", () =>
    Effect.gen(function* () {
      const urls = [
        `http://cad.onshape.com/documents/${documentId}/w/${workspaceId}`,
        `https://user@cad.onshape.com/documents/${documentId}/w/${workspaceId}`,
        `https://cad.onshape.com/documents/${documentId}`,
        `https://cad.onshape.com/documents/${documentId}/w/${workspaceId}/e`,
        `https://cad.onshape.com/documents/${documentId}/w/${workspaceId}/e/${elementId}/extra`,
        `https://cad.onshape.com/documents/${documentId}/w/${workspaceId}?configuration=a&configuration=b`,
      ];

      for (const url of urls) {
        const exit = yield* Effect.exit(OnshapeSourceUrl.parse({ connection, url }));
        assert.strictEqual(exit._tag, "Failure", url);
      }
    }),
  );
});
