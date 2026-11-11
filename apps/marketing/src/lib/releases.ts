// Which Cadsense build the site offers, read from the repository's GitHub releases in the browser.
// `DOWNLOADS` is every installer the site lists. `fetchOfferedRelease()` returns the release to offer
// and the download link it has for each of them.
import { GITHUB_REPOSITORY_URL } from "./site";

export const RELEASES_URL = `${GITHUB_REPOSITORY_URL}/releases`;

const API_URL = `${GITHUB_REPOSITORY_URL.replace("github.com/", "api.github.com/repos/")}/releases`;
const CACHE_KEY = "cadsense-offered-release";

// One row per installer. `platform` matches the `data-platform` that SiteLayout sets on <html>.
// Linux is not here: the release pipeline does not build it.
// `suffix` is how the release pipeline ends that installer's file name, as in
// "Cadsense-1.2.0-arm64.dmg" (scripts/build-desktop-artifact.ts).
export const DOWNLOADS = [
  { platform: "mac", name: "macOS", detail: "Apple Silicon", format: ".dmg", suffix: "-arm64.dmg" },
  {
    platform: "windows",
    name: "Windows",
    detail: "Windows 10 and 11, 64-bit",
    format: ".exe",
    suffix: "-x64.exe",
  },
] as const;

export type DownloadPlatform = (typeof DOWNLOADS)[number]["platform"];

export interface OfferedRelease {
  /** The version without its leading "v", as in "0.0.1-nightly.20261110.16". */
  readonly version: string;
  readonly channel: "stable" | "nightly";
  /** The release's page on GitHub. */
  readonly url: string;
  /** The download link for each platform this release has an installer for. */
  readonly assets: Partial<Record<DownloadPlatform, string>>;
}

// The fields of GitHub's release objects that the site reads.
interface GithubRelease {
  readonly tag_name: string;
  readonly html_url: string;
  readonly draft: boolean;
  readonly prerelease: boolean;
  readonly assets: readonly { readonly name: string; readonly browser_download_url: string }[];
}

// The offer for one GitHub release: its version, and the installers it has from DOWNLOADS.
function offer(release: GithubRelease, channel: OfferedRelease["channel"]): OfferedRelease {
  return {
    version: release.tag_name.replace(/^v/, ""),
    channel,
    url: release.html_url,
    assets: Object.fromEntries(
      DOWNLOADS.flatMap(({ platform, suffix }) => {
        const asset = release.assets.find(({ name }) => name.endsWith(suffix));
        return asset ? [[platform, asset.browser_download_url]] : [];
      }),
    ),
  };
}

// GitHub's latest stable release. Until one exists, the newest nightly among the 30 most recent
// releases. Other pre-releases, such as the per-pull-request "desktop-preview" builds, are never
// offered. The stable release comes from GitHub's own "latest" endpoint and not from the list,
// because several nightlies are published a day and would soon push it off the list's first page.
async function findRelease(): Promise<OfferedRelease | undefined> {
  const latest = await fetch(`${API_URL}/latest`);
  if (latest.ok) return offer(await latest.json(), "stable");
  // 404 means the repository has no stable release yet.
  if (latest.status !== 404) throw new Error(`GitHub answered ${latest.status}`);

  const recent = await fetch(`${API_URL}?per_page=30`);
  if (!recent.ok) throw new Error(`GitHub answered ${recent.status}`);
  const releases: readonly GithubRelease[] = await recent.json();
  const nightly = releases.find(({ draft, tag_name }) => !draft && tag_name.includes("-nightly."));
  return nightly && offer(nightly, "nightly");
}

// Resolves to the release to offer, or undefined when the repository has none. It rejects when
// GitHub cannot be reached. The answer is kept for the rest of the browser session.
export async function fetchOfferedRelease(): Promise<OfferedRelease | undefined> {
  const cached = sessionStorage.getItem(CACHE_KEY);
  if (cached) return JSON.parse(cached);

  const offered = await findRelease();
  if (offered) sessionStorage.setItem(CACHE_KEY, JSON.stringify(offered));
  return offered;
}
