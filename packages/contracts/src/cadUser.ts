import * as Schema from "effect/Schema";
import { ProjectId } from "./baseSchemas.ts";
import { CadOperationId } from "./cadLifecycle.ts";
import { CadRootKind } from "./cad.ts";
import { OnshapeElementId } from "./onshape.ts";

export const CadUserStartInput = Schema.Union([
  Schema.Struct({ projectId: ProjectId, kind: Schema.Literal("discover") }),
  Schema.Struct({
    projectId: ProjectId,
    kind: Schema.Literal("sync"),
    root: Schema.Struct({
      elementId: OnshapeElementId,
      kind: CadRootKind,
      configuration: Schema.String.check(Schema.isMaxLength(4096)),
    }),
  }),
]);
export type CadUserStartInput = typeof CadUserStartInput.Type;
export const CadUserOperationInput = Schema.Struct({
  projectId: ProjectId,
  operationId: CadOperationId,
});
export const CadUserStartResult = Schema.Struct({ operationId: CadOperationId });
export const CadUserEnabledInput = Schema.Struct({ projectId: ProjectId, enabled: Schema.Boolean });
export class CadUserOperationError extends Schema.TaggedErrorClass<CadUserOperationError>()(
  "CadUserOperationError",
  {
    reason: Schema.Literals([
      "busy",
      "not-found",
      "unavailable",
      "invalid-root",
      "disk-space",
      "operation-failed",
    ]),
  },
) {}
