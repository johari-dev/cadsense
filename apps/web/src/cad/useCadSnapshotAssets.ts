// One CAD snapshot's manifest and part meshes, for right-panel views that work on parts outside
// the 3D viewer (part drawings, plate CAM). Holding the scene lease keeps its ticket valid.
import { useAtomValue } from "@effect/atom-react";
import { CadSnapshotManifest, type ScopedThreadRef } from "@cadsense/contracts";
import * as Schema from "effect/Schema";
import { AsyncResult } from "effect/unstable/reactivity";
import { useEffect, useMemo, useState } from "react";
import { cadPanelEnvironment } from "../state/cadPanel";
import { useEnvironmentHttpBaseUrl } from "../state/environments";
import { analyzePart, type PartAnalysis } from "./drawing/analysis";
import { loadGlbPart } from "./drawing/loadPart";
import {
  glbExtents,
  shopRoute,
  type DrawingSheetEntry,
  type ShopRoute,
} from "./drawing/drawingModel";

const decodeManifest = Schema.decodeUnknownSync(CadSnapshotManifest);

// Meshes and their analysis are content-addressed, so they stay cached for the session.
const assetBySha = new Map<string, Promise<ArrayBuffer>>();
const analysisBySha = new Map<string, Promise<PartAnalysis>>();

export const useCadSnapshotAssets = (threadRef: ScopedThreadRef, snapshotId: string) => {
  const lease = useAtomValue(
    cadPanelEnvironment.scene({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId, snapshotId },
    }),
  );
  const ticket = AsyncResult.isSuccess(lease) ? lease.value : null;
  const baseUrl = useEnvironmentHttpBaseUrl(threadRef.environmentId);
  const [manifest, setManifest] = useState<CadSnapshotManifest | null>(null);
  const [error, setError] = useState<string | null>(null);

  const fetchFromScene = useMemo(() => {
    if (!ticket || !baseUrl) return null;
    return async (path: string) => {
      const response = await fetch(
        new URL(
          `api/cad-panel/${ticket.sceneId}${path}`,
          baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`,
        ),
        { credentials: "omit", headers: { "x-cad-panel-token": ticket.token } },
      );
      if (!response.ok) throw new Error("CAD scene unavailable");
      return response;
    };
  }, [ticket, baseUrl]);

  const fetchAsset = useMemo(() => {
    if (!fetchFromScene) return null;
    return (sha256: string) => {
      const cached = assetBySha.get(sha256);
      if (cached) return cached;
      const bytes = fetchFromScene(`/${sha256}`).then((response) => response.arrayBuffer());
      bytes.catch(() => assetBySha.delete(sha256));
      assetBySha.set(sha256, bytes);
      return bytes;
    };
  }, [fetchFromScene]);

  const analyze = useMemo(() => {
    if (!fetchAsset) return null;
    return (sha256: string) => {
      const cached = analysisBySha.get(sha256);
      if (cached) return cached;
      const work = fetchAsset(sha256).then(loadGlbPart).then(analyzePart);
      work.catch(() => analysisBySha.delete(sha256));
      analysisBySha.set(sha256, work);
      return work;
    };
  }, [fetchAsset]);

  useEffect(() => {
    if (!fetchFromScene || manifest) return;
    let live = true;
    fetchFromScene("?delivery=meshopt-bin-v1")
      .then((response) => response.json())
      .then((json) => live && setManifest(decodeManifest(json)))
      .catch((cause: unknown) => live && setError(String(cause)));
    return () => {
      live = false;
    };
  }, [fetchFromScene, manifest]);

  return { manifest, error, setError, fetchAsset, analyze };
};

/**
 * Where each candidate part goes in the shop (drawing, router, printer), read from its mesh's
 * bounding box. Null until every candidate is routed, or when `enabled` is false.
 */
export const useShopRoutes = (
  candidates: readonly DrawingSheetEntry[],
  fetchAsset: ((sha256: string) => Promise<ArrayBuffer>) | null,
  enabled: boolean,
  onError: (message: string) => void,
) => {
  const [routes, setRoutes] = useState<Record<string, ShopRoute> | null>(null);
  useEffect(() => {
    if (!enabled || !fetchAsset || candidates.length === 0) return;
    let live = true;
    Promise.all(
      candidates.map(async (candidate) => {
        const extents = glbExtents(new Uint8Array(await fetchAsset(candidate.sha256)));
        return [candidate.sha256, shopRoute(candidate.material, extents)] as const;
      }),
    )
      .then((entries) => live && setRoutes(Object.fromEntries(entries)))
      .catch((cause: unknown) => live && onError(String(cause)));
    return () => {
      live = false;
    };
  }, [enabled, fetchAsset, candidates, onError]);
  return enabled ? routes : null;
};

/** Part instances per route among the candidates, for "not drawn" and "not cut" notes. */
export const routeCounts = (
  candidates: readonly DrawingSheetEntry[],
  routes: Record<string, ShopRoute>,
) => {
  const count = (route: ShopRoute) =>
    candidates
      .filter((candidate) => routes[candidate.sha256] === route)
      .reduce((sum, candidate) => sum + candidate.qty, 0);
  return { drawing: count("drawing"), cnc: count("cnc"), print: count("print") };
};
