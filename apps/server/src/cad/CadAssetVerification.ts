import * as Effect from "effect/Effect";

const MAX_CONCURRENT_ASSETS = 4;
const MAX_COHORT_BYTES = 32 * 1024 ** 2;

/** Verify bounded cohorts without letting interrupted file reads outlive the store lock. */
export const verifyCadAssets = <A extends { readonly byteLength: number }, E, R>(
  assets: readonly A[],
  verify: (asset: A) => Effect.Effect<void, E, R>,
): Effect.Effect<void, E, R> =>
  Effect.suspend(() => {
    const cohorts: A[][] = [];
    let cohort: A[] = [];
    let byteLength = 0;
    for (const asset of assets) {
      if (
        cohort.length > 0 &&
        (cohort.length === MAX_CONCURRENT_ASSETS ||
          byteLength + asset.byteLength > MAX_COHORT_BYTES)
      ) {
        cohorts.push(cohort);
        cohort = [];
        byteLength = 0;
      }
      cohort.push(asset);
      byteLength += asset.byteLength;
    }
    if (cohort.length > 0) cohorts.push(cohort);
    // A permitted asset larger than the budget runs alone. This bounds declared
    // in-flight input, not process RSS or externally modified file lengths.
    return Effect.forEach(
      cohorts,
      (group) =>
        Effect.forEach(group, (asset) => verify(asset).pipe(Effect.uninterruptible), {
          concurrency: MAX_CONCURRENT_ASSETS,
          discard: true,
        }),
      { discard: true },
    );
  });
