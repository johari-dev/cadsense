/**
 * Stock FRC gears, pulleys, belts, and sprockets for cad_drive_options, fetched from ReCalc's
 * vendor data (https://github.com/tervay/recalc, MIT) instead of shipped with the app. See
 * "Catalog" in CadDriveOptions.md.
 */
import { CadViewError } from "@cadsense/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { ServerConfig } from "../config.ts";

const SOURCE = "https://github.com/tervay/recalc/tree/main/app/genData";
const RAW = "https://raw.githubusercontent.com/tervay/recalc/main/app/genData";
const VENDORS = ["AndyMark", "LastAnvil", "REV", "SDS", "Swyft", "Thrifty", "VBeltGuys", "WCP"];
/** How long a download stays fresh. */
const TTL_MS = 24 * 60 * 60 * 1000;
/** After a failed download, so an offline server does not wait on the network every call. */
const RETRY_MS = 5 * 60 * 1000;
const TIMEOUT_MS = 20_000;

const Listing = {
  teeth: Schema.Int,
  vendor: Schema.String,
  sku: Schema.NullOr(Schema.String),
  url: Schema.String,
};
const Bore = Schema.NullOr(Schema.String);
export const DriveCatalog = Schema.Struct({
  source: Schema.String,
  gears: Schema.Array(Schema.Struct({ ...Listing, dp: Schema.Finite, bore: Bore })),
  pulleys: Schema.Array(
    Schema.Struct({ ...Listing, profile: Schema.String, pitchMm: Schema.Finite, bore: Bore }),
  ),
  belts: Schema.Array(
    Schema.Struct({
      ...Listing,
      profile: Schema.String,
      pitchMm: Schema.Finite,
      widthMm: Schema.NullOr(Schema.Finite),
    }),
  ),
  sprockets: Schema.Array(Schema.Struct({ ...Listing, chain: Schema.String, bore: Bore })),
});
export type DriveCatalog = typeof DriveCatalog.Type;

/** One entry in a ReCalc genData file. Entries that do not match are skipped, not fatal. */
const RecalcEntry = Schema.Struct({
  teeth: Schema.Int.check(Schema.isGreaterThan(0)),
  vendor: Schema.String,
  url: Schema.String,
  sku: Schema.optionalKey(Schema.NullOr(Schema.String)),
  bore: Schema.optionalKey(Schema.NullOr(Schema.String)),
  dp: Schema.optionalKey(Schema.Finite),
  profile: Schema.optionalKey(Schema.String),
  pitch: Schema.optionalKey(Schema.Finite),
  width: Schema.optionalKey(Schema.NullOr(Schema.Finite)),
  chainType: Schema.optionalKey(Schema.String),
});
type RecalcEntry = typeof RecalcEntry.Type;
const decodeEntry = Schema.decodeUnknownOption(RecalcEntry);
const decodeFile = Schema.decodeUnknownEffect(Schema.Array(Schema.Unknown));
const CatalogCache = Schema.Struct({ fetchedAtMs: Schema.Finite, catalog: DriveCatalog });
const CatalogCacheJson = Schema.fromJsonString(CatalogCache);
const decodeCache = Schema.decodeUnknownEffect(CatalogCacheJson);
const encodeCache = Schema.encodeEffect(CatalogCacheJson);

const listing = (entry: RecalcEntry) => ({
  teeth: entry.teeth,
  vendor: entry.vendor,
  sku: entry.sku ?? null,
  url: entry.url,
});
const byTeeth = <T extends { readonly teeth: number; readonly url: string }>(items: readonly T[]) =>
  items.toSorted((a, b) => a.teeth - b.teeth || a.url.localeCompare(b.url));
/** The catalog from every vendor's files of each kind, keeping only the fields the search reads. */
interface RecalcFiles {
  readonly gears: readonly RecalcEntry[];
  readonly pulleys: readonly RecalcEntry[];
  readonly belts: readonly RecalcEntry[];
  readonly sprockets: readonly RecalcEntry[];
}
const catalogOf = (files: RecalcFiles): DriveCatalog => ({
  source: SOURCE,
  gears: byTeeth(
    files.gears.flatMap((entry) =>
      entry.dp === undefined ? [] : [{ ...listing(entry), dp: entry.dp, bore: entry.bore ?? null }],
    ),
  ),
  pulleys: byTeeth(
    files.pulleys.flatMap((entry) =>
      entry.profile === undefined || entry.pitch === undefined
        ? []
        : [
            {
              ...listing(entry),
              profile: entry.profile,
              pitchMm: entry.pitch,
              bore: entry.bore ?? null,
            },
          ],
    ),
  ),
  belts: byTeeth(
    files.belts.flatMap((entry) =>
      entry.profile === undefined || entry.pitch === undefined
        ? []
        : [
            {
              ...listing(entry),
              profile: entry.profile,
              pitchMm: entry.pitch,
              widthMm: entry.width ?? null,
            },
          ],
    ),
  ),
  sprockets: byTeeth(
    files.sprockets.flatMap((entry) =>
      entry.chainType === undefined
        ? []
        : [{ ...listing(entry), chain: entry.chainType, bore: entry.bore ?? null }],
    ),
  ),
});

const unavailable = (details: string) =>
  new CadViewError({ reason: "capability-unavailable", details });

export interface CadDriveCatalogShape {
  /** The current catalog: fetched at most once a day, else the last good copy. */
  readonly current: Effect.Effect<DriveCatalog, CadViewError>;
}
export class CadDriveCatalog extends Context.Service<CadDriveCatalog, CadDriveCatalogShape>()(
  "@cadsense/server/cad/CadDriveCatalog",
) {}

export const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig;
  const httpClient = yield* HttpClient.HttpClient;
  const cachePath = path.join(config.stateDir, "drive-catalog.json");
  const gate = yield* Semaphore.make(1);
  let catalog: DriveCatalog | null = null;
  let fetchedAtMs: number | null = null;
  let attemptedAtMs: number | null = null;

  const loadDisk = yield* Effect.cached(
    fileSystem.readFileString(cachePath).pipe(
      Effect.flatMap(decodeCache),
      Effect.map((cached) => {
        catalog = cached.catalog;
        fetchedAtMs = cached.fetchedAtMs;
      }),
      Effect.catchCause(() => Effect.void),
    ),
  );
  // A vendor that does not sell a kind has no file for it, so a 404 is an empty list.
  const fetchFile = (vendor: string, kind: string) =>
    httpClient.get(`${RAW}/${vendor}/${kind}.json`).pipe(
      Effect.flatMap((response) =>
        response.status === 404
          ? Effect.succeed([])
          : HttpClientResponse.filterStatusOk(response).pipe(
              Effect.flatMap((ok) => ok.json),
              Effect.flatMap(decodeFile),
              Effect.map((entries) =>
                entries.flatMap((entry) => Option.toArray(decodeEntry(entry))),
              ),
            ),
      ),
    );
  const kind = (name: keyof RecalcFiles) =>
    Effect.forEach(VENDORS, (vendor) => fetchFile(vendor, name), { concurrency: "unbounded" }).pipe(
      Effect.map((files) => files.flat()),
    );
  const download = Effect.all(
    {
      gears: kind("gears"),
      pulleys: kind("pulleys"),
      belts: kind("belts"),
      sprockets: kind("sprockets"),
    },
    { concurrency: "unbounded" },
  ).pipe(Effect.map(catalogOf), Effect.timeout(TIMEOUT_MS));

  const current = gate.withPermits(1)(
    Effect.gen(function* () {
      yield* loadDisk;
      const now = yield* Clock.currentTimeMillis;
      // A time in the future means the clock moved back: treat it as expired.
      const within = (since: number | null, windowMs: number) =>
        since !== null && now >= since && now - since < windowMs;
      if (catalog && within(fetchedAtMs, TTL_MS)) return catalog;
      if (!within(attemptedAtMs, RETRY_MS)) {
        attemptedAtMs = now;
        const fetched = yield* download.pipe(Effect.catchCause(() => Effect.succeed(null)));
        if (
          fetched &&
          fetched.gears.length + fetched.pulleys.length + fetched.sprockets.length > 0
        ) {
          catalog = fetched;
          fetchedAtMs = now;
          yield* encodeCache({ fetchedAtMs: now, catalog: fetched }).pipe(
            Effect.flatMap((json) => fileSystem.writeFileString(cachePath, json)),
            Effect.catchCause(() => Effect.void),
          );
        }
      }
      if (catalog) return catalog;
      return yield* unavailable(
        "ReCalc's parts catalog could not be downloaded from GitHub, and no earlier copy is saved. Check the network and try again in a few minutes.",
      );
    }),
  );
  return CadDriveCatalog.of({ current });
});

export const layer = Layer.effect(CadDriveCatalog, make);
