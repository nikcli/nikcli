import { defineConfig } from "vite"
import solid from "vite-plugin-solid"
import tailwind from "@tailwindcss/vite"

// Static assets (favicons, manifest, theme preload) are the web app's own, reused as-is.
export default defineConfig({
  plugins: [tailwind(), solid()],
  publicDir: "../app/public",
  clearScreen: false,
  server: { port: 1430, strictPort: true, watch: { ignored: ["**/src-tauri/**"] } },
  build: { target: "esnext" },
})
