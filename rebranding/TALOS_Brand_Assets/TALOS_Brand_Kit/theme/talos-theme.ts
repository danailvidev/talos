export const talosTheme = {
  colors: {
    background: "#080E15",
    surface: "#0D1823",
    surfaceRaised: "#142331",
    border: "#343B42",
    text: "#ECE9E4",
    textMuted: "#84919E",
    primary: "#B08C65",
    primaryHover: "#CFA473",
    focus: "#F3B45D",
    success: "#52B788",
    danger: "#E06C75",
  },
  radius: { sm: 6, md: 10, lg: 16 },
  fonts: {
    ui: '"Space Grotesk", Inter, system-ui, sans-serif',
    display: '"Oxanium", "Space Grotesk", sans-serif',
    mono: '"JetBrains Mono", ui-monospace, monospace',
  },
} as const;

export type TalosTheme = typeof talosTheme;
