# Onshape experiment runner reference

`onshape-request-experiment.ts` calls the real acquisition service with isolated
storage. It records requests, responses, manifests, and assets without starting a
server. `onshape-geometry-fidelity.mjs` compares stored assets through Three.js.

## Environment variables

| Variable                         | Meaning                                                                                                        |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `ONSHAPE_SOURCE_URL`             | Required Onshape element URL.                                                                                  |
| `ONSHAPE_EXPERIMENT_DIR`         | Required artifact directory. Use fresh storage for a cold run.                                                 |
| `ONSHAPE_OFFLINE=1`              | Replay only. Missing responses fail without network access.                                                    |
| `ONSHAPE_REPLAY_READS_DIR`       | Colon-separated recording directories on Linux.                                                                |
| `ONSHAPE_CREDENTIAL_FILE`        | Required for live runs. JSON secret containing `accessKeyId` and `secretKey`.                                  |
| `ONSHAPE_REQUEST_BUDGET`         | Request-attempt limit, including connection verification. Default `160`.                                       |
| `ONSHAPE_ASSERT_MAX_REQUESTS`    | Maximum cold-import count. Unchanged sync must use one request and reuse the snapshot.                         |
| `ONSHAPE_BASELINE_MANIFEST`      | Optional baseline for metadata, topology, identity, ordering, and triangle assertions.                         |
| `ONSHAPE_ALLOW_BULK_METADATA=1`  | Permits recorded null optional studio metadata and absent suppressed-part metadata.                            |
| `ONSHAPE_ALLOW_RETESSELLATION=1` | Records triangle-count differences without failing acquisition comparison. Requires a separate geometry audit. |
| `ONSHAPE_UNCHANGED_ONLY=1`       | Runs only the one-request unchanged-sync check.                                                                |
| `ONSHAPE_STATE_DIR`              | Optional existing experiment state, for resume or unchanged-only checks.                                       |
| `ONSHAPE_INJECT_BATCH_FAILURE`   | Offline fault injection: `too-large`, `timeout`, or `missing-part`. Requires recordings for fallback requests. |

Comparisons remap geometry keys across tessellation profiles and normalize negative
zero in transforms. All other source and placement values remain exact. Replay
ignores export correlation IDs, which identify local checkpoints, but still matches
export options. Artifacts contain CAD response data, not authorization headers.

## Nine-request replay

The following command uses this worktree's final live recording. It needs no
credentials. The output directory must be fresh.

```bash
ONSHAPE_SOURCE_URL='https://cad.onshape.com/documents/e5fd6dd412a8653a52ad3252/w/1cc3344ea68c679223cb7558/e/e46921a75b1bb6cff79888e0' \
ONSHAPE_EXPERIMENT_DIR='.cadsense/request-experiments/reproduce-nine' \
ONSHAPE_OFFLINE=1 \
ONSHAPE_REQUEST_BUDGET=12 \
ONSHAPE_ASSERT_MAX_REQUESTS=9 \
ONSHAPE_ALLOW_BULK_METADATA=1 \
ONSHAPE_ALLOW_RETESSELLATION=1 \
ONSHAPE_BASELINE_MANIFEST='.cadsense/request-experiments/baseline-offline/cold-manifest.json' \
ONSHAPE_REPLAY_READS_DIR='.cadsense/request-experiments/bom-targeted-live' \
	node apps/server/scripts/onshape-request-experiment.ts
```

Expected: nine cold requests, one unchanged request, zero network calls, unchanged
review identities, and recorded triangle-count differences. An eight-request limit
makes this replay fail. Replay timing does not measure network or export latency.

## Geometry checks

This strict comparison intentionally reports representation differences between
the original and current importer, including changed tessellation and sidedness:

```bash
ONSHAPE_CANDIDATE_MANIFEST='.cadsense/request-experiments/bom-targeted-live/cold-manifest.json' \
	node apps/server/scripts/onshape-geometry-fidelity.mjs \
	.cadsense/request-experiments/baseline-offline/cold-manifest.json \
	.cadsense/request-experiments/baseline-offline/state/userdata/cad/assets \
	.cadsense/request-experiments/bom-targeted-live/state/userdata/cad/assets \
	.cadsense/request-experiments/bom-targeted-live/fidelity.json
```

Expected: 153 compared, 101 exact, 52 differences, and a nonzero exit status.
The comparator does not silently accept re-tessellation. It normalizes only
normal-vector components below `1e-15` to zero.

The retained local surface audit examines those 52 differences, including the
composite duplication described in the report:

```bash
node .cadsense/request-experiments/surface-fidelity.mjs \
	.cadsense/request-experiments/bom-targeted-live
```

Expected: 52 passing sampled comparisons in `surface-fidelity.json`. This audit
uses the retained baseline and dependencies in `geometry-tools/`. The archive and
CAD response fixtures remain local and are not committed.

## Repository checks

```bash
pnpm --filter @cadsense/server exec vp test run src/onshape src/cad
pnpm --filter @cadsense/contracts test
pnpm --filter @cadsense/server typecheck
pnpm --filter @cadsense/web typecheck
```

The [experiment report](../src/onshape/OnshapeRequestExperiments.md) records live
counts, geometry differences, and limits.
