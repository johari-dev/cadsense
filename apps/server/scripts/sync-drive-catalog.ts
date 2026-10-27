// @effect-diagnostics nodeBuiltinImport:off globalConsole:off preferSchemaOverJson:off globalFetch:off
// Writes apps/server/src/cad/driveCatalog.json, the stock FRC gears, pulleys, belts, and sprockets
// cad_drive_options searches, from ReCalc's vendor data (https://github.com/tervay/recalc, MIT) at a
// pinned commit. Pass a newer commit to refresh it:
//   node apps/server/scripts/sync-drive-catalog.ts [commit]
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

const commit = process.argv[2] ?? "8ac77bb5b1779a228d615ea224e91a66e8d5ab10";
const vendors = ["AndyMark", "LastAnvil", "REV", "SDS", "Swyft", "Thrifty", "VBeltGuys", "WCP"];

interface Raw {
  readonly teeth: number;
  readonly sku: string | null;
  readonly url: string;
  readonly vendor: string;
  readonly bore?: string;
  readonly dp?: number;
  readonly profile?: string;
  readonly pitch?: number;
  readonly width?: number;
  readonly chainType?: string;
}

const read = async (vendor: string, kind: string): Promise<Raw[]> => {
  const url = `https://raw.githubusercontent.com/tervay/recalc/${commit}/app/genData/${vendor}/${kind}.json`;
  const response = await fetch(url);
  if (response.status === 404) return [];
  if (!response.ok) throw new Error(`${url}: ${response.status}`);
  return (await response.json()) as Raw[];
};
const all = async (kind: string) => (await Promise.all(vendors.map((v) => read(v, kind)))).flat();
const part = (raw: Raw) => ({ vendor: raw.vendor, sku: raw.sku, url: raw.url });
const byTeeth = <T extends { teeth: number; url: string }>(items: T[]) =>
  items.toSorted((a, b) => a.teeth - b.teeth || a.url.localeCompare(b.url));

const catalog = {
  source: `https://github.com/tervay/recalc/tree/${commit}/app/genData`,
  gears: byTeeth(
    (await all("gears")).flatMap((raw) =>
      raw.dp === 20 || raw.dp === 32
        ? [{ teeth: raw.teeth, dp: raw.dp, bore: raw.bore ?? null, ...part(raw) }]
        : [],
    ),
  ),
  pulleys: byTeeth(
    (await all("pulleys")).flatMap((raw) =>
      raw.profile && raw.pitch
        ? [
            {
              teeth: raw.teeth,
              profile: raw.profile,
              pitchMm: raw.pitch,
              bore: raw.bore ?? null,
              ...part(raw),
            },
          ]
        : [],
    ),
  ),
  belts: byTeeth(
    (await all("belts")).flatMap((raw) =>
      raw.profile && raw.pitch
        ? [
            {
              teeth: raw.teeth,
              profile: raw.profile,
              pitchMm: raw.pitch,
              widthMm: raw.width ?? null,
              ...part(raw),
            },
          ]
        : [],
    ),
  ),
  sprockets: byTeeth(
    (await all("sprockets")).flatMap((raw) =>
      raw.chainType
        ? [{ teeth: raw.teeth, chain: raw.chainType, bore: raw.bore ?? null, ...part(raw) }]
        : [],
    ),
  ),
};
const out = NodePath.join(import.meta.dirname, "../src/cad/driveCatalog.json");
NodeFS.writeFileSync(out, `${JSON.stringify(catalog, null, 2)}\n`);
console.log(
  `${out}: ${catalog.gears.length} gears, ${catalog.pulleys.length} pulleys, ${catalog.belts.length} belts, ${catalog.sprockets.length} sprockets`,
);
