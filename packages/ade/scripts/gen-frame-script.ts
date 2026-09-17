/**
 * Writes `src-tauri/scripts/browser-frame.js`, the script the host runs in
 * every frame, from `src/browser/frame-script.ts`.
 *
 *   bun scripts/gen-frame-script.ts
 *
 * Run it after changing that module or the inspector bridge; a test fails
 * while the file is out of date.
 */

import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { frameScript } from "../src/browser/frame-script"

const out = join(import.meta.dir, "..", "src-tauri", "scripts", "browser-frame.js")
writeFileSync(out, frameScript())
console.log(out)
