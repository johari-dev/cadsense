import {
  CadUpdateViewInput,
  CadViewError,
  CadViewState,
  type CadSnapshotManifest,
} from "@cadsense/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { indexCadSnapshot, revealCadOccurrences } from "@cadsense/shared/cadScene";
export { indexCadSnapshot } from "@cadsense/shared/cadScene";

const decodeUpdate = Schema.decodeUnknownEffect(CadUpdateViewInput);
const invalid = () => new CadViewError({ reason: "invalid-operation" });

export const initialCadView = (snapshot: CadSnapshotManifest, revision = 0): CadViewState => ({
  rootId: snapshot.rootId,
  snapshotId: snapshot.snapshotId,
  revision,
  camera: { kind: "preset", preset: "isometric", fit: [] },
  visibility: {},
  isolatedOccurrenceIds: [],
  explosion: 0,
});

/** The complete batch is evaluated privately; callers persist only the returned successful state. */
export const updateCadView = Effect.fn("updateCadView")(function* (
  current: CadViewState,
  input: unknown,
  snapshots: ReadonlyMap<string, CadSnapshotManifest>,
) {
  const update = yield* decodeUpdate(input).pipe(Effect.mapError(invalid));
  if (update.expectedRevision !== current.revision)
    return yield* new CadViewError({ reason: "revision-conflict" });
  let state = current;
  let snapshot = snapshots.get(state.rootId);
  if (!snapshot || snapshot.snapshotId !== state.snapshotId)
    return yield* new CadViewError({ reason: "capability-unavailable" });
  let index = indexCadSnapshot(snapshot);
  for (const operation of update.operations) {
    if ("occurrenceIds" in operation && operation.occurrenceIds.some((id) => !index.nodes.has(id)))
      return yield* invalid();
    switch (operation.type) {
      case "select-root": {
        snapshot = snapshots.get(operation.rootId);
        if (!snapshot) return yield* new CadViewError({ reason: "capability-unavailable" });
        if (snapshot.snapshotId !== state.snapshotId)
          state = initialCadView(snapshot, current.revision);
        index = indexCadSnapshot(snapshot);
        break;
      }
      case "camera-preset":
        state = { ...state, camera: { kind: "preset", preset: operation.preset, fit: [] } };
        break;
      case "camera-pose":
        state = { ...state, camera: { kind: "pose", pose: operation.pose, fit: null } };
        break;
      case "fit":
        state = { ...state, camera: { ...state.camera, fit: operation.occurrenceIds } };
        break;
      case "show":
      case "hide": {
        const visibility = { ...state.visibility };
        for (const id of index.subtree(operation.occurrenceIds))
          visibility[id] = operation.type === "show";
        state = { ...state, visibility };
        break;
      }
      case "isolate": {
        const visibility = revealCadOccurrences(index, state, operation.occurrenceIds);
        state = {
          ...state,
          visibility,
          isolatedOccurrenceIds: [...new Set(operation.occurrenceIds)],
        };
        break;
      }
      case "reset-visibility":
        state = { ...state, visibility: {}, isolatedOccurrenceIds: [] };
        break;
      case "highlight":
        state = { ...state, highlightedOccurrenceIds: [...new Set(operation.occurrenceIds)] };
        break;
      case "ghost":
        state = {
          ...state,
          ghost: {
            occurrenceIds: [...new Set(operation.occurrenceIds)],
            opacity: operation.opacity,
          },
        };
        break;
      case "section":
        state = { ...state, sectionPlanes: operation.planes };
        break;
      case "reset-inspection":
        state = { ...state, highlightedOccurrenceIds: [], ghost: null, sectionPlanes: [] };
        break;
      case "explode":
        state = { ...state, explosion: operation.amount };
        break;
    }
  }
  if (!Number.isSafeInteger(current.revision + 1)) return yield* invalid();
  return { ...state, revision: current.revision + 1 };
});

/** Idle views adopt a newer root without retaining obsolete occurrence references or geometry pins. */
export const rebaseCadView = (state: CadViewState, snapshot: CadSnapshotManifest): CadViewState => {
  if (state.rootId !== snapshot.rootId) return initialCadView(snapshot, state.revision);
  const ids = new Set(snapshot.nodes.map((node) => node.id));
  const fit = state.camera.fit;
  const framingLost = fit !== null && fit.some((id) => !ids.has(id));
  return {
    ...state,
    snapshotId: snapshot.snapshotId,
    ...(state.highlightedOccurrenceIds
      ? { highlightedOccurrenceIds: state.highlightedOccurrenceIds.filter((id) => ids.has(id)) }
      : {}),
    ...(state.ghost
      ? {
          ghost: {
            ...state.ghost,
            occurrenceIds: state.ghost.occurrenceIds.filter((id) => ids.has(id)),
          },
        }
      : {}),
    visibility: Object.fromEntries(Object.entries(state.visibility).filter(([id]) => ids.has(id))),
    isolatedOccurrenceIds: state.isolatedOccurrenceIds.filter((id) => ids.has(id)),
    camera: framingLost ? { kind: "preset", preset: "isometric", fit: [] } : state.camera,
  };
};
