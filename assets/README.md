# Brand icons

`cadsense/` holds the cadsense logo and every exported size of it. Development,
nightly, and production builds all use these files directly: `scripts/lib/brand-assets.ts`
maps each channel's desktop, Windows, and web icon to them. See
`cadsense/README.md` for how the artwork was made.

The web app also keeps byte-for-byte copies in `apps/web/public` for its favicon and
splash screen. Run `vp run icons:export` from the repository root to refresh them, or
`vp run icons:check` to verify them without changing files.

Do not edit the PNG or ICO files directly.
