# TALOS light theme implementation plan

Status: implemented on October 23, 2026.

## Objective

Add a production-ready light appearance without weakening the existing TALOS dark identity. Users will be able to select **System**, **Light**, or **Dark**. The choice will:

- apply immediately;
- persist in the existing user-preferences system;
- follow the user across devices;
- apply before the first React paint when cached locally;
- update automatically when the operating-system theme changes while **System** is selected.

The implementation will preserve the existing semantic token boundary. Feature components should not gain theme checks or TALOS color literals.

## Scope

### Included

- Light-mode TALOS color tokens.
- System/light/dark appearance selection.
- Persistence through `PreferencesContext`.
- Pre-paint theme bootstrap to avoid a dark or light flash.
- Theme-aware TALOS logo handling.
- Theme-aware Sonner notifications and charts.
- Contrast and visual review of shared controls and major routes.
- Documentation of the light palette and logo rules.

### Not included

- Restoring the old coral/violet/azure/emerald accent palettes.
- A free-form color picker.
- User-defined themes.
- Layout, typography, spacing, or navigation redesign.
- Changing the meaning of status colors.
- Theme-dependent third-party integration logos.

## Current foundation

- `web/src/styles/brand/talos.css` owns the approved palette and exposes semantic aliases such as `--bg`, `--text`, `--action`, and `--status-danger`.
- `web/src/index.css` maps those aliases into Tailwind and shadcn semantic tokens.
- Most application surfaces consume semantic variables, so a light appearance can be implemented centrally.
- `web/src/PreferencesContext.tsx` already persists preferences on the server and mirrors them to local storage.
- The repository history contains the removed theme bootstrap, provider, and selector. Their behavior can be adapted to the TALOS tokens instead of designed from scratch.
- Black, bronze, and white vector variants already exist under `rebranding/svg-new/`.
- `web/src/AssistantIcon.tsx` uses `currentColor`; it will follow the active semantic color automatically.

## Design decisions

### 1. Keep one semantic token API

Components will continue to consume the current aliases:

- Surfaces: `--bg`, `--bg-deep`, `--bg-raised`, `--bg-hover`, `--bg-muted`.
- Borders: `--border`, `--border-strong`.
- Text: `--text`, `--text-dim`, `--text-muted`, `--text-faint`.
- Actions: `--action`, `--action-hover`, `--action-strong`, `--action-wash`.
- Focus and live state: `--focus`, `--live`, `--live-wash`.
- Statuses: `--status-success`, `--status-warning`, `--status-danger`, and their strong/wash variants.

Light mode will override those aliases at the root. Components must not branch on the active appearance unless they are selecting fixed brand artwork or configuring a third-party library.

### 2. Use a resolved root attribute

The root element will carry:

```html
<html data-appearance="light">
```

or:

```html
<html data-appearance="dark">
```

The stored choice may be `system`, but CSS will only receive the resolved `light` or `dark` value. This keeps selectors simple and ensures an explicit user choice takes precedence over `prefers-color-scheme`.

Do not use `.dark` as the primary theme mechanism. Existing shadcn `dark:` variants can be audited separately, while application colors continue to flow through semantic tokens.

### 3. Keep dark as the default

Users without a stored preference will retain the current dark appearance. This avoids changing existing installations unexpectedly and matches TALOS's dark-first brand direction.

### 4. Preserve status meaning

Success, warning, danger, and live colors retain their semantic roles. Their light-mode values may be darkened to meet contrast requirements, but their meaning and relative hue must not change.

### 5. Treat brand artwork separately from interface icons

- Copy the approved black horizontal logo and sentinel mark into `web/public/assets/logos/`.
- Use bronze artwork on dark surfaces and black artwork on light surfaces.
- Keep the authentication artwork on an intentionally dark Obsidian brand panel. This allows the existing bronze primary artwork to remain unchanged and protects the approved composition.
- Keep the favicon bronze and appearance-independent. Browser favicon theming is inconsistent and is not required for interface accessibility.
- Continue using `currentColor` for `AssistantIcon`; no alternate image is needed.
- Lucide and integration icons continue to inherit semantic foreground colors where applicable.

## Proposed light palette process

The final values must be approved visually and pass contrast checks. Start from a warm, neutral surface stack that complements Ivory and Bronze rather than using pure white throughout.

The light theme must define explicit values for:

| Role | Requirement |
|---|---|
| Page background | Warm near-white; distinct from raised cards |
| Deep background | Slightly darker neutral for inset areas |
| Raised surface | Lightest surface |
| Hover/muted surfaces | Visible without appearing disabled |
| Borders | Visible against both page and raised surfaces |
| Primary text | Near-black with at least 4.5:1 contrast |
| Muted text | At least 4.5:1 where it conveys required information |
| Bronze action | Preserve TALOS identity; use a darker approved derivative when bronze is foreground text |
| Focus | At least 3:1 against adjacent surfaces |
| Status colors | At least 4.5:1 for small text and 3:1 for non-text indicators |

The current `#B08C65` Bronze can remain a filled-control background with dark text where contrast passes. It should not automatically be used as small text on a light background. If a darker action value is required, document it as a light-mode derivative rather than changing the dark brand token.

## Implementation phases

## Phase 1: Define and validate the light tokens

### Work

1. Add a `[data-appearance="light"]` block to `web/src/styles/brand/talos.css`.
2. Override the complete surface, border, text, action, focus, live, and status ramps.
3. Override `color-scheme` to `light`.
4. Keep typography, radii, and spacing shared across appearances.
5. Verify all shadcn aliases continue to derive from the semantic TALOS aliases.
6. Record the approved light values and intended contrast pairs in `design.md`.

### Files

- `web/src/styles/brand/talos.css`
- `web/src/index.css` only if selector bridging is required
- `design.md`

### Acceptance criteria

- No feature component needs a new color literal to display correctly.
- Native controls and scrollbars receive the correct `color-scheme`.
- Text, controls, focus rings, and status indicators meet WCAG AA contrast targets.
- Dark mode is pixel-equivalent apart from intentional fixes discovered during the audit.

## Phase 2: Restore theme state and pre-paint bootstrap

### Work

1. Reintroduce a framework-independent `theme.ts` module containing:
   - `Appearance = "system" | "light" | "dark"`;
   - preference key and parser;
   - default appearance (`dark`);
   - system preference resolution;
   - root-attribute application;
   - pre-paint local-storage bootstrap.
2. Reintroduce `ThemeContext.tsx`:
   - read and write through `usePreference`;
   - expose selected and resolved appearances;
   - apply root changes in a layout effect;
   - subscribe to `prefers-color-scheme` only while **System** is selected.
3. Call `bootstrapTheme()` in `web/src/main.tsx` before `createRoot(...).render(...)`.
4. Mount `ThemeProvider` inside `PreferencesProvider` in the authenticated application tree.
5. Preserve the cached appearance across logout so authentication pages do not flash or unexpectedly revert.

### Files

- `web/src/theme.ts` — add
- `web/src/ThemeContext.tsx` — add
- `web/src/main.tsx`
- `web/src/App.tsx`
- `web/src/PreferencesContext.tsx` — comments or exports only if needed

### Acceptance criteria

- A cached light choice paints light on the first frame.
- An explicit choice ignores later OS changes.
- **System** follows OS changes without reloading.
- Invalid or stale stored values safely resolve to dark.
- The setting follows the user through the existing server-side preference API.

## Phase 3: Add the appearance selector

### Work

1. Add a **Theme** entry to the user menu.
2. Implement a shadcn-based dialog with three options:
   - System;
   - Light;
   - Dark.
3. Apply the selection immediately so the application behind the dialog acts as the preview.
4. Show the currently resolved appearance when **System** is selected.
5. Do not add accent-palette controls in this phase.
6. Use existing `Button`, `Modal`, and layout primitives rather than feature-level plain controls.

### Files

- `web/src/ThemeDialog.tsx` — add
- `web/src/UserMenu.tsx`
- `web/src/ThemeContext.tsx`
- `web/src/theme.ts`

### Acceptance criteria

- All three options are keyboard accessible and expose selected state through `aria-pressed` or an equivalent shadcn primitive.
- The menu and dialog remain usable on narrow layouts.
- Theme changes require no Save action and are visible immediately.

## Phase 4: Wire theme-aware brand assets

### Work

1. Bundle these approved files directly from `rebranding/svg-new/`:
   - `talos-logo-horizontal-black.svg`;
   - `talos-mark-black.svg`.
2. Keep the existing bronze variants for dark surfaces.
3. Update `Logo.tsx` to render the correct approved variant for the resolved appearance.
4. Ensure the logo swaps without changing its dimensions and causing layout shift.
5. Keep `AuthSplitCard`'s brand panel explicitly Obsidian in both appearances and retain bronze artwork there.
6. Review the imported primary PNG. If it contains a transparent bronze composition, retain it; otherwise replace it with the equivalent approved bronze SVG without changing layout.
7. Confirm `AssistantIcon` and other `currentColor` icons inherit suitable light-mode colors.

### Files

- `rebranding/svg-new/talos-logo-horizontal-black.svg` — bundled by `Logo`
- `rebranding/svg-new/talos-mark-black.svg` — bundled by `Logo`
- `web/src/Logo.tsx`
- `web/src/AuthSplitCard.tsx`
- `web/src/AssistantIcon.tsx` — verification only unless contrast requires a semantic class change

### Acceptance criteria

- Black artwork is used on light surfaces and bronze artwork on dark surfaces.
- No logo is stretched, filtered, recolored, or given effects.
- The authentication brand panel remains visually intentional in both appearances.
- Switching appearance causes no logo layout shift.

## Phase 5: Adapt theme-sensitive libraries and dark assumptions

### Work

1. Change `web/src/components/ui/sonner.tsx` from hardcoded `theme="dark"` to the resolved appearance.
2. Align `web/src/components/ui/chart.tsx` theme selectors with `data-appearance`, or ensure all chart configurations use semantic CSS variables.
3. Audit existing shadcn `dark:` variants. Decide whether each should:
   - become a semantic-token style;
   - use `[data-appearance="dark"]`;
   - remain inactive because it is redundant.
4. Review fixed black/white styles:
   - image viewers and overlays should remain black where they intentionally frame media;
   - decorative dark-mode inset highlights should be tokenized or removed in light mode;
   - modal overlays can remain translucent black.
5. Review shadows. Dark shadows may remain, but opacity should be reduced where they appear too heavy on light surfaces.
6. Verify browser-native form controls, code blocks, logs, Markdown, charts, and tooltips.

### Primary audit targets

- `web/src/components/ui/sonner.tsx`
- `web/src/components/ui/chart.tsx`
- `web/src/components/ui/tabs.tsx`
- `web/src/components/ui/input-group.tsx`
- `web/src/components/ui/dropdown-menu.tsx`
- `web/src/components/ui/dialog.tsx`
- `web/src/components/ui/drawer.tsx`
- `web/src/components/ui/alert-dialog.tsx`
- `web/src/AuthSplitCard.tsx`
- `web/src/TaskDetail.tsx`
- `web/src/graph/TicketDetail.tsx`
- `web/src/SlackInboxPage.tsx`
- `web/src/pr/Markdown.tsx`

### Acceptance criteria

- No general application surface remains dark accidentally.
- Intentional media viewers, log viewers, and overlays may remain dark and are documented as such.
- Toasts, charts, menus, dialogs, and native controls match the selected appearance.

## Phase 6: Tests and visual QA

### Automated tests

Add focused tests for pure theme behavior:

- missing preference defaults to dark;
- valid system/light/dark values parse correctly;
- invalid values fall back safely;
- system resolution follows `matchMedia`;
- applying a theme writes only resolved `light` or `dark` to the root;
- cached preference bootstrap applies before React initialization.

Run:

```bash
cd web
bun test
bun run build
```

### Visual matrix

Review each target in both light and dark appearances, at desktop and narrow/mobile widths:

1. Landing and authentication.
2. Main navigation and user menu.
3. Profile, notifications, provider access, and theme dialogs.
4. Graph board, ticket panel, and ticket details.
5. Pull request list, details, Markdown, and diffs.
6. Loops dashboard, run timeline, and charts.
7. Automation and failures inbox.
8. Settings and form-heavy pages.
9. Toasts, loading, empty, error, destructive, disabled, hover, selected, and focus-visible states.
10. Media thumbnails and fullscreen viewers.

### Accessibility checks

- Normal text: at least 4.5:1.
- Large text: at least 3:1.
- Focus indicators and meaningful non-text controls: at least 3:1.
- Selected and status states remain understandable without color.
- Keyboard focus remains visible in both appearances.
- `prefers-reduced-motion` behavior remains unchanged.

### Acceptance criteria

- Existing tests pass.
- Production build succeeds.
- No first-paint theme flash is visible with cached light or dark preferences.
- No critical contrast failures remain.
- Visual QA covers all routes listed above in both appearances.

## Phase 7: Documentation and rollout

### Work

1. Update `design.md` to describe TALOS as dark-first with a supported light appearance.
2. Document both surface/text ramps and approved logo usage.
3. State that feature code must consume semantic aliases and must not branch on appearance.
4. Keep dark as the default for existing and new users.
5. Release behind no feature flag unless visual QA identifies route-specific blockers. The user can always return to dark from the theme dialog.

### Acceptance criteria

- The design documentation matches the implementation.
- Future components have clear token and artwork guidance.
- Removing light mode would not require changes throughout feature components.

## Suggested implementation order

1. Approve light palette and logo behavior.
2. Add tokens and root selector.
3. Add theme parsing, bootstrap, and provider.
4. Add the user-facing selector.
5. Add black logo assets and switching.
6. Adapt Sonner, charts, and remaining dark assumptions.
7. Add tests and run the full visual matrix.
8. Update documentation.

This order makes the token layer testable before UI work and keeps theme-specific decisions out of feature components.

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| Bronze lacks contrast as small text on light surfaces | Use a documented darker light-mode action derivative; retain original Bronze for suitable fills and artwork |
| Theme flashes during startup | Apply cached preference before React mounts |
| Explicit preference conflicts with OS media queries | Resolve `system` in TypeScript and expose only the resolved root attribute |
| Black logo assets introduce layout changes | Match existing intrinsic dimensions and reserve width/height |
| Dark-only component styles remain hidden in rarely used routes | Use the route/state visual matrix and search for fixed black/white or `dark:` classes |
| Light fixes regress the established dark theme | Keep dark tokens unchanged and verify both appearances for every shared primitive |
| Authentication pages lack authenticated preferences | Retain the last cached appearance and bootstrap it before the auth gate |
| Third-party controls ignore tokens | Pass resolved appearance explicitly to libraries such as Sonner and align chart selectors |

## Estimated effort

| Work | Estimate |
|---|---:|
| Palette definition and contrast validation | 0.5 day |
| Theme state, bootstrap, and selector | 0.5–1 day |
| Brand assets and third-party adaptations | 0.5 day |
| Route audit, fixes, and automated tests | 1–1.5 days |
| Final visual/accessibility QA | 0.5 day |
| **Total** | **2–4 engineering days** |

The estimate assumes the light palette can be approved without a separate brand-design cycle. Palette revisions or exhaustive screenshot-regression infrastructure would add time.

## Definition of done

- System, Light, and Dark choices work and persist.
- Cached preference is applied before first paint.
- Dark remains the default and retains its current visual identity.
- Light mode uses an approved, documented TALOS palette.
- Logos use approved artwork appropriate to their surfaces.
- Assistant and interface icons remain legible without duplicate image assets.
- Shared controls, toasts, charts, forms, Markdown, logs, and major routes work in both appearances.
- Contrast requirements pass for text, controls, focus, and statuses.
- Tests and production build pass.
- `design.md` documents the resulting theme system.
