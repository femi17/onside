import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        pitch: { DEFAULT: "#0E1A1B", 2: "#152523", 3: "#1E312D" },
        chalk: { DEFAULT: "#ECE7DA", 2: "#F6F2E9" },
        ink: { DEFAULT: "#13201D", mute: "#5E6E68" },
        flood: { DEFAULT: "#FFB43C", deep: "#E7952A" },
        grass: { DEFAULT: "#57A773", deep: "#3C8859" },
        brick: "#C2604A",
        onpitch: { DEFAULT: "#E7E2D5", mute: "#8DA19B" },
      },
      fontFamily: {
        disp: ["Bricolage Grotesque", "sans-serif"],
        sans: ["Hanken Grotesk", "system-ui", "sans-serif"],
        mono: ["JetBrains Mono", "monospace"],
      },
      // live "counting" pulse on the match clock, so it never feels stuck
      keyframes: {
        blink: { "0%,100%": { opacity: "1" }, "50%": { opacity: "0.25" } },
      },
      animation: {
        blink: "blink 1.1s ease-in-out infinite",
      },
    },
  },
  plugins: [],
};

export default config;
