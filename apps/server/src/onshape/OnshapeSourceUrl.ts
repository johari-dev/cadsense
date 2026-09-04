import {
  MAX_ONSHAPE_CONFIGURATION_LENGTH,
  OnshapeDocumentId,
  OnshapeElementId,
  OnshapeConnectionHost,
  OnshapeProjectHostMismatchError,
  OnshapeProjectInvalidUrlError,
  type OnshapeProjectSource,
  OnshapeWorkspaceId,
  type OnshapeConnectionSummary,
  OnshapeWorkspaceType,
} from "@cadsense/contracts";
import * as Effect from "effect/Effect";

const ONSHAPE_PROJECT_PATH =
  /^\/documents\/([0-9a-f]{24})\/(w|v|m)\/([0-9a-f]{24})(?:\/e\/([0-9a-f]{24}))?\/?$/i;

export type OnshapeSourceUrlError = OnshapeProjectInvalidUrlError | OnshapeProjectHostMismatchError;

/** Parse only the URL shape needed to identify one document context or element. */
export const parse = Effect.fn("OnshapeSourceUrl.parse")(function* (input: {
  readonly url: string;
  readonly connection: Pick<OnshapeConnectionSummary, "connectionId" | "host">;
}): Effect.fn.Return<OnshapeProjectSource, OnshapeSourceUrlError> {
  const parsed = yield* Effect.try({
    try: () => new URL(input.url),
    catch: () => new OnshapeProjectInvalidUrlError(),
  });
  if (
    parsed.protocol !== "https:" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.port !== ""
  ) {
    return yield* new OnshapeProjectInvalidUrlError();
  }

  const connectionUrl = yield* Effect.try({
    try: () => new URL(input.connection.host),
    catch: () => new OnshapeProjectInvalidUrlError(),
  });
  if (parsed.origin !== connectionUrl.origin) {
    return yield* new OnshapeProjectHostMismatchError();
  }

  const match = ONSHAPE_PROJECT_PATH.exec(parsed.pathname);
  if (match === null) {
    return yield* new OnshapeProjectInvalidUrlError();
  }
  const documentId = match[1];
  const workspaceType = match[2];
  const workspaceId = match[3];
  if (documentId === undefined || workspaceType === undefined || workspaceId === undefined) {
    return yield* new OnshapeProjectInvalidUrlError();
  }

  const configurations = parsed.searchParams.getAll("configuration");
  if (
    configurations.length > 1 ||
    (configurations[0]?.length ?? 0) > MAX_ONSHAPE_CONFIGURATION_LENGTH
  ) {
    return yield* new OnshapeProjectInvalidUrlError();
  }
  const elementId = match[4];
  return {
    connectionId: input.connection.connectionId,
    host: OnshapeConnectionHost.make(connectionUrl.origin),
    documentId: OnshapeDocumentId.make(documentId.toLowerCase()),
    workspaceType: OnshapeWorkspaceType.make(workspaceType.toLowerCase() as "w" | "v" | "m"),
    workspaceId: OnshapeWorkspaceId.make(workspaceId.toLowerCase()),
    ...(elementId === undefined
      ? {}
      : { elementId: OnshapeElementId.make(elementId.toLowerCase()) }),
    configuration: configurations[0] ?? "",
  };
});
