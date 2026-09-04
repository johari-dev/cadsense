import type { ProjectId } from "@cadsense/contracts";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

export class OnshapeWorkspaceProvisionError extends Data.TaggedError(
  "OnshapeWorkspaceProvisionError",
)<{ readonly projectId: ProjectId }> {
  override get message(): string {
    return `Could not provision the managed workspace for project '${this.projectId}'.`;
  }
}

export interface OnshapeWorkspaceReactorShape {
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  readonly drainThrough: (sequence: number) => Effect.Effect<void, OnshapeWorkspaceProvisionError>;
}

export class OnshapeWorkspaceReactor extends Context.Service<
  OnshapeWorkspaceReactor,
  OnshapeWorkspaceReactorShape
>()("@cadsense/server/orchestration/Services/OnshapeWorkspaceReactor") {}
