import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

// Use the image renderer already shipped with Astro; no runtime worker dependency.
const require = createRequire(import.meta.resolve("astro"));
const sharp = require("sharp");
const publicDir = new URL("../public/", import.meta.url);
const wordmark = Buffer.from(
  await Bun.file(new URL("brand/wordmark-dark.png", publicDir)).arrayBuffer(),
).toString("base64");
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <rect width="1200" height="630" fill="#080809"/>
  <path d="M72 510H1128" stroke="#302e2b"/>
  <image href="data:image/png;base64,${wordmark}" x="72" y="64" width="264" height="86"/>
  <g font-family="Arial, Helvetica, sans-serif">
    <text x="72" y="260" fill="#f2f0ec" font-size="62" font-weight="700" letter-spacing="-2">Open-source AI</text>
    <text x="72" y="332" fill="#f2f0ec" font-size="62" font-weight="700" letter-spacing="-2">development agent.</text>
    <text x="75" y="406" fill="#aaa69f" font-size="28">Your terminal. Your models. Your control.</text>
    <text x="75" y="565" fill="#f2f0ec" font-size="25">nikcli.store</text>
    <text x="1125" y="565" fill="#aaa69f" font-size="21" text-anchor="end">Built for developers</text>
  </g>
</svg>`;
await sharp(Buffer.from(svg))
  .png()
  .toFile(fileURLToPath(new URL("og.png", publicDir)));
await sharp(fileURLToPath(new URL("brand/icon-dark.png", publicDir)))
  .resize(180, 180)
  .png()
  .toFile(fileURLToPath(new URL("apple-touch-icon.png", publicDir)));
console.log("Generated og.png (1200×630) and apple-touch-icon.png (180×180)");
