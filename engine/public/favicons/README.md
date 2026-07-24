# Favicons

This folder is copied to `dist/favicons/` at build time. Files referenced in `layout.html`:

- `favicon.svg` — modern SVG icon (committed). Works in all modern browsers, scales perfectly.
- `favicon.ico` — legacy ICO for older IE/Edge (drop in if needed).
- `favicon-16x16.png`, `favicon-32x32.png` — fallbacks for older browsers (drop in if needed).
- `apple-touch-icon.png` — 180×180 PNG for iOS home-screen (drop in if needed).
- `android-chrome-192x192.png`, `android-chrome-512x512.png` — referenced by `site.webmanifest` (drop in if needed).
- `safari-pinned-tab.svg` — monochrome SVG for Safari pinned tabs (drop in if needed).
- `site.webmanifest` — PWA manifest (committed).

## Quick way to generate the missing PNG/ICO sizes

If you want full coverage, use [realfavicongenerator.net](https://realfavicongenerator.net) — upload one master image, download the zip, drop the files in here.

The SVG favicon alone is fine for modern browsers (Chrome, Firefox, Safari, Edge).
