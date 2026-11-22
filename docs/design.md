# TALOS Design System

This repository implements the TALOS identity described in
`rebranding/TALOS_Brand_Guidelines.pdf`. The existing application layout,
navigation model, routes, and responsive behavior remain stable; this document
governs visual identity, component treatment, accessibility, and voice.

## Brand direction

TALOS is a dark-first identity with a supported light appearance for an AI
automation and orchestration platform connecting GitLab, Jira, and containerized
workflows. It should feel capable, watchful, calm, and technical.

- Primary descriptor: **Automate • Orchestrate • Deliver**
- Supporting descriptor: **GitLab + Jira + AI in motion**
- Use direct language, visible system state, and clear next actions.
- Provide evidence and context with alerts.
- Avoid alarmist copy, unnecessary animation, and opaque AI jargon.

## Replaceable brand layer

`web/src/styles/brand/talos.css` is the only source of brand colors, font
families, shape values, and elevation. Components consume semantic aliases such
as `--bg`, `--action`, `--focus`, and `--status-danger`; they must not embed
TALOS hex values or color names.

## Logo

Artwork under `web/public/assets/logos` is authoritative.

- Use the horizontal lockup in application and authentication headers.
- Use the sentinel mark for compact navigation and app icons.
- Use Bronze artwork on dark surfaces and Black artwork on light surfaces.
- Keep the primary authentication artwork on its Obsidian brand panel in both
  appearances.
- Never stretch, skew, recolor, add effects, or place the logo over detailed
  imagery.
- Maintain clear space and use a 180px minimum width where the containing layout
  permits it.

## Color

| Token | Hex | Role |
|---|---:|---|
| Obsidian | `#080E15` | Application background and logs |
| Deep Navy | `#0D1823` | Cards and navigation |
| Surface Navy | `#142331` | Hovered and raised surfaces |
| Graphite | `#343B42` | Borders and disabled controls |
| Steel | `#84919E` | Secondary text |
| Ivory | `#ECE9E4` | Primary text |
| Bronze | `#B08C65` | Primary controls, icons, and highlights |
| Bright Bronze | `#CFA473` | Hover and selected states |
| Glow | `#F3B45D` | Keyboard focus and live activity |
| Success | `#52B788` | Healthy pipelines |
| Danger | `#E06C75` | Failures and destructive actions |

Use Ivory for text on Obsidian or Deep Navy. Do not use Bronze for small body
text. Statuses must include an icon and text; color alone never communicates
state.

### Light appearance

Light mode uses warm neutral surfaces and darker TALOS derivatives. Components
must consume the same semantic aliases in both appearances; feature code must not
branch on the theme or embed values from this table.

| Token | Hex | Role |
|---|---:|---|
| Warm Canvas | `#F7F5F1` | Application background |
| White | `#FFFFFF` | Raised cards and dialogs |
| Warm Surface | `#EBE7DF` | Hovered and secondary surfaces |
| Muted Surface | `#DED8CE` | Muted controls and separators |
| Warm Border | `#CBC3B7` | Standard borders |
| Ink | `#171B20` | Primary text |
| Slate | `#59616A` | Secondary text |
| Deep Bronze | `#7B5B3C` | Primary controls, links, and highlights |
| Focus Bronze | `#8A5B16` | Keyboard focus and live activity |
| Deep Success | `#217452` | Healthy pipelines |
| Deep Danger | `#B33C49` | Failures and destructive actions |

The appearance choice is stored as `system`, `light`, or `dark`. CSS receives
only the resolved value through `html[data-appearance]`. Dark remains the default.
Tailwind/shadcn colors and future components must use the semantic mappings in
`web/src/index.css`; fixed brand artwork and third-party theme props are the only
expected appearance-specific exceptions.

## Typography

| Role | Family | Weights | Usage |
|---|---|---:|---|
| Display | Oxanium | 600–700 | Page titles, automation names, key metrics |
| Interface | Space Grotesk | 400–600 | Navigation, controls, and body copy |
| Code | JetBrains Mono | 400–600 | Logs, IDs, commands, and pipeline output |
| Fallback | Inter or system UI | — | Performance-safe fallback |

Type scale:

- Display: `40/48px`
- H1: `32/40px`
- H2: `24/32px`
- H3: `18/26px`
- Body: `16/24px`
- Small: `14/20px`
- Label: `12/16px`, `0.08em` tracking

Uppercase is reserved for short metadata labels. Actions use sentence case.

## Components

- Navigation uses Deep Navy. The selected item uses a Bronze left rule or icon,
  never a full bright fill.
- Primary actions use Bronze with an Obsidian label and Bright Bronze hover.
- Cards use Deep Navy, a Graphite border, and a 16px radius.
- Inputs use Obsidian or Deep Navy, a Graphite border, and a visible Glow focus
  ring.
- Logs use JetBrains Mono on Obsidian. Keep severity labels aligned and
  searchable.
- Prefer surface elevation and borders to shadows. Glow is reserved for intent,
  focus, and live state.

Use a 4px base grid. Preferred gaps are 8, 12, 16, 24, and 32px. Shape values
are 6px for compact controls, 10px for buttons and inputs, and 16px for panels.
Avoid excessive pill shapes.

## Motion and accessibility

- Motion is restrained and operational.
- Respect `prefers-reduced-motion`.
- All controls are keyboard reachable and have visible focus.
- Icon-only controls have accessible labels.
- Touch targets should be at least approximately 34px where practical.
- Preserve semantic landmarks, table headers, and status announcements.
- Do not use emojis in the interface.

## Release checks

Before release, verify text contrast, keyboard focus, icon-plus-text status
semantics, favicon and PWA assets, logo clarity at compact widths, and font
loading.
