# TALOS Brand Kit

Use `talos-logo-horizontal.png` in the React app header and `talos-mark-square.png` for compact navigation. Copy `theme/talos-theme.css` to `src/styles/` and import it once from `src/main.tsx` or `src/App.tsx`. Copy the logo and favicon folders into `public/assets/`, then reference `favicon.ico` and `site.webmanifest` from the application HTML metadata.

`theme/talos-theme.ts` provides typed JavaScript tokens for CSS-in-JS, component props, charts, and other places where CSS custom properties are not convenient. The CSS file remains the source of truth for global styling.

Transparent SVG logos and favicons are in `assets/svg/`. Each logo has approved bronze, monochrome white, and monochrome black versions. Use white on dark surfaces and black on light surfaces.

The source identity is raster artwork. Keep its proportions intact; do not recolor, stretch, outline, or place it on busy imagery. The recommended app theme is dark-first so the bronze sentinel retains its intended depth and contrast.
