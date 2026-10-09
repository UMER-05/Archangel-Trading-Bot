/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
    "./lib/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        // Brand accent — deliberately separate from the profit/loss colors
        // below. The old palette used the same green as both "brand" and
        // "gain", so a primary button and a winning trade were visually the
        // same color with no way to tell them apart at a glance.
        primary: "#8B5CF6",
        "primary-hover": "#A78BFA",
        secondary: "#22D3EE",
        success: "#34D399",
        danger: "#FB7185",
        warning: "#FBBF24",
        base: {
          100: "#08080D", // page background
          200: "#100F17", // card / panel surface
          300: "#1B1A26", // nested surface, hover state
          content: "#EDEEF5",
        },
      },
      fontFamily: {
        // CSS vars set by next/font in app/layout.tsx — real self-hosted
        // fonts, not a Google Fonts <link> that may or may not load.
        sans: ["var(--font-body)", "Inter", "system-ui", "sans-serif"],
        display: ["var(--font-display)", "Sora", "system-ui", "sans-serif"],
        mono: [
          "var(--font-mono)",
          "JetBrains Mono",
          "ui-monospace",
          "monospace",
        ],
      },
      boxShadow: {
        glow: "0 0 24px rgba(139, 92, 246, 0.28)",
        "glow-success": "0 0 24px rgba(52, 211, 153, 0.22)",
        "glow-danger": "0 0 24px rgba(251, 113, 133, 0.22)",
        elevated:
          "0 1px 0 rgba(255,255,255,0.04) inset, 0 12px 32px -12px rgba(0,0,0,0.55)",
      },
      backgroundImage: {
        "grid-fade":
          "radial-gradient(circle at 50% 0%, rgba(139,92,246,0.10), transparent 60%)",
      },
    },
  },
  plugins: [require("@tailwindcss/typography"), require("daisyui")],
  daisyui: {
    styled: true,
    themes: [
      {
        archangel: {
          primary: "#8B5CF6",
          secondary: "#1B1A26",
          accent: "#FB7185",
          neutral: "#14141C",
          "base-100": "#08080D",
          "base-200": "#100F17",
          "base-300": "#1B1A26",
          "base-content": "#EDEEF5",
        },
      },
      "night",
      "retro",
    ],
    base: true,
    utils: true,
    logs: false,
    rtl: false,
  },
};
