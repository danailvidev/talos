# Project Agent Instructions

## Web UI

- Use shadcn components from `web/src/components/ui/` for interactive controls and overlays.
- If the needed control is missing, add the official shadcn component before implementing the feature.
- Do not build feature-level controls from plain HTML or import Radix/Base UI primitives directly when a shadcn component exists.
- Use Tailwind CSS utility classes in TSX for layout and styling.
- Customize shadcn controls through their props, composition, and Tailwind utilities rather than duplicating their behavior or adding feature CSS.
- Do not add custom CSS classes when Tailwind utilities can express the same result.
- Custom CSS is reserved for shared design tokens/global foundations, third-party overrides, and behavior Tailwind cannot reasonably express.
- Plain semantic HTML remains appropriate for non-interactive content.
