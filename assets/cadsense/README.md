# cadsense logo

`logo-source.png` is the original blueprint artwork from
https://github.com/AadiJo/cadsense/blob/main/assets/cadsense/logo-source.png.

`logo-1024.png`, `logo-180.png`, `favicon.ico`, and `windows.ico` show the CS letters
as white ceramic over that blueprint. The letters were traced from `logo-source.png`
and rendered in 3D with Vitrum (https://usevitrum.com) using its Ceramic finish, face
on. They were then composited over `logo-source.png` with the grid faded to 45%. The
dimension lines, rim, and paper texture are unchanged. The ICO files hold PNG-encoded
entries: 16, 32, and 48 px for the favicon, plus 24, 64, 128, and 256 px for Windows.
The marketing site's icons in `apps/marketing/public` are exported from the same render.

Development, nightly, and production share this CS artwork. Run
`vp run icons:export` to copy the exports to existing desktop and renderer paths,
or `vp run icons:check` to verify byte-for-byte consistency. The legacy Icon
Composer projects/exporter are not used by these commands.
