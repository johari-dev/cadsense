// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { type CadSnapshotManifest } from "@cadsense/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { describe, expect, vi } from "vite-plus/test";
import { it } from "@effect/vitest";
import { CadSnapshotStore } from "../cad/CadSnapshotStore.ts";
import { cadTransferArtifacts } from "../cad/CadTransferArtifacts.ts";
import { prepareCadSnapshotTransfer } from "./OnshapeSnapshotAcquisition.ts";

const manifest = {
  snapshotId: "00000000-0000-4000-8000-000000000001",
  assets: [],
} as unknown as CadSnapshotManifest;
const unavailable = () => Effect.die("Unexpected store operation");
describe("import transfer preparation scope", () => {
  it.effect(
    "retains the snapshot pin until preparation settles when import cancellation arrives",
    () =>
      Effect.gen(function* () {
        const events: string[] = [];
        let pinned = false;
        const store = CadSnapshotStore.of({
          findGeometry: unavailable,
          checkReserve: unavailable,
          putAsset: unavailable,
          publish: unavailable,
          load: unavailable,
          readAsset: unavailable,
          list: unavailable,
          remove: unavailable,
          withAcquisition: (effect) => effect,
          withPinned: (_id, use) =>
            Effect.acquireUseRelease(
              Effect.sync(() => {
                pinned = true;
                events.push("pin");
              }),
              () =>
                use(manifest, () =>
                  Effect.sync(() => {
                    expect(pinned).toBe(true);
                    events.push("read");
                    return new Uint8Array(0);
                  }),
                ),
              () =>
                Effect.sync(() => {
                  pinned = false;
                  events.push("unpin");
                }),
            ),
        });
        const stateDir = NodePath.join(
          NodeOS.tmpdir(),
          `cad-transfer-scope-${NodeCrypto.randomUUID()}`,
        );
        let entered!: () => void;
        let release!: () => void;
        const started = new Promise<void>((resolve) => {
          entered = resolve;
        });
        const gate = new Promise<void>((resolve) => {
          release = resolve;
        });
        const spy = vi
          .spyOn(cadTransferArtifacts(stateDir), "get")
          .mockImplementation(async (_assets, readAsset) => {
            entered();
            await gate;
            await readAsset("unused");
            return {
              identity: "a".repeat(64),
              index: { version: "meshopt-bin-v1", byteLength: 0, assets: [], bins: [] },
            };
          });
        try {
          const fiber = yield* Effect.forkChild(
            prepareCadSnapshotTransfer(manifest, store, stateDir),
          );
          yield* Effect.promise(() => started);
          const interruption = yield* Effect.forkChild(Fiber.interrupt(fiber));
          yield* Effect.yieldNow;
          expect(pinned).toBe(true);
          release();
          yield* Fiber.join(interruption);
          expect(events).toEqual(["pin", "read", "unpin"]);
          expect(pinned).toBe(false);
        } finally {
          release();
          spy.mockRestore();
        }
      }),
  );

  it.effect(
    "keeps a completed import successful when its derived transfer cannot be prepared",
    () =>
      Effect.gen(function* () {
        const stateDir = NodePath.join(
          NodeOS.tmpdir(),
          `cad-transfer-scope-${NodeCrypto.randomUUID()}`,
        );
        const spy = vi
          .spyOn(cadTransferArtifacts(stateDir), "get")
          .mockRejectedValue(new Error("Disk full"));
        let released = false;
        const store = CadSnapshotStore.of({
          findGeometry: unavailable,
          checkReserve: unavailable,
          putAsset: unavailable,
          publish: unavailable,
          load: unavailable,
          readAsset: unavailable,
          list: unavailable,
          remove: unavailable,
          withAcquisition: (effect) => effect,
          withPinned: (_id, use) =>
            use(manifest, unavailable).pipe(
              Effect.ensuring(
                Effect.sync(() => {
                  released = true;
                }),
              ),
            ),
        });
        try {
          yield* prepareCadSnapshotTransfer(manifest, store, stateDir);
          expect(released).toBe(true);
        } finally {
          spy.mockRestore();
        }
      }),
  );
});
