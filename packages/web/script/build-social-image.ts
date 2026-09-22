import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"

// Use the image renderer already shipped with Astro; no runtime worker dependency.
const require = createRequire(import.meta.resolve("astro"))
const sharp = require("sharp")
const publicDir = new URL("../public/", import.meta.url)
const readPublic = (path: string) => fileURLToPath(new URL(path, publicDir))
const toBase64 = async (path: string) => Buffer.from(await Bun.file(readPublic(path)).arrayBuffer()).toString("base64")

// Brand tokens mirrored from the artifact viewer shell / global.css dark palette.
const palette = {
  dark: {
    bg: "#080809",
    panel: "#0d0d0f",
    border: "rgba(255,255,255,0.09)",
    text: "#f2f0ec",
    muted: "#8a867e",
    accent: "#60a5fa",
    glow: "rgba(96,165,250,0.14)",
    grid: "rgba(255,255,255,0.03)",
  },
  light: {
    bg: "#faf9f6",
    panel: "#ffffff",
    border: "rgba(12,11,10,0.10)",
    text: "#0c0b0a",
    muted: "#6e685e",
    accent: "#2563eb",
    glow: "rgba(37,99,235,0.10)",
    grid: "rgba(12,11,10,0.035)",
  },
} as const

function socialSvg(p: (typeof palette)["dark" | "light"], wordmark: string) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <defs>
    <radialGradient id="glow" cx="50%" cy="0%" r="80%">
      <stop offset="0%" stop-color="${p.glow}"/>
      <stop offset="100%" stop-color="${p.glow}" stop-opacity="0"/>
    </radialGradient>
    <pattern id="grid" width="48" height="48" patternUnits="userSpaceOnUse">
      <path d="M48 0H0V48" fill="none" stroke="${p.grid}" stroke-width="1"/>
    </pattern>
  </defs>

  <rect width="1200" height="630" fill="${p.bg}"/>
  <rect width="1200" height="630" fill="url(#grid)"/>
  <rect width="1200" height="630" fill="url(#glow)"/>

  <!-- Wordmark + origin line -->
  <image href="data:image/png;base64,${wordmark}" x="72" y="60" width="252" height="82"/>
  <text x="1128" y="104" text-anchor="end" font-family="Arial, Helvetica, sans-serif" font-size="17" fill="${p.muted}">Open source · MIT license</text>

  <!-- Headline -->
  <g font-family="Arial, Helvetica, sans-serif">
    <text x="72" y="300" fill="${p.text}" font-size="64" font-weight="800" letter-spacing="-2">Open-source AI</text>
    <text x="72" y="376" fill="${p.text}" font-size="64" font-weight="800" letter-spacing="-2">development agent.</text>
    <text x="72" y="438" fill="${p.muted}" font-size="27">Your terminal. Your models. Your control.</text>
  </g>

  <!-- Terminal chip, echoing the hero window -->
  <g>
    <rect x="72" y="470" width="424" height="62" rx="12" fill="${p.panel}" stroke="${p.border}"/>
    <text x="102" y="510" font-family="'JetBrains Mono', 'Courier New', monospace" font-size="21" font-weight="700">
      <tspan fill="${p.accent}">$</tspan><tspan fill="${p.text}" dx="10">nikcli --agent=build</tspan>
    </text>
  </g>

  <!-- Footer strip -->
  <path d="M72 560H1128" stroke="${p.border}"/>
  <text x="72" y="600" font-family="Arial, Helvetica, sans-serif" font-size="22" font-weight="700" fill="${p.text}">nikcli-ai.dev</text>
  <text x="1128" y="600" text-anchor="end" font-family="Arial, Helvetica, sans-serif" font-size="17" fill="${p.muted}">21+ providers · 40+ built-in tools</text>
</svg>`
}

const wordmarkDark = await toBase64("brand/wordmark-dark.png")
const wordmarkLight = await toBase64("brand/wordmark-light.png")

await sharp(Buffer.from(socialSvg(palette.dark, wordmarkDark)))
  .png()
  .toFile(readPublic("og.png"))
await sharp(Buffer.from(socialSvg(palette.light, wordmarkLight)))
  .png()
  .toFile(readPublic("og-light.png"))
await sharp(readPublic("brand/icon-dark.png")).resize(180, 180).png().toFile(readPublic("apple-touch-icon.png"))
await sharp(readPublic("brand/icon-light.png")).resize(180, 180).png().toFile(readPublic("apple-touch-icon-light.png"))
console.log("Generated og.png + og-light.png (1200×630) and apple-touch-icon(-light).png (180×180)")
