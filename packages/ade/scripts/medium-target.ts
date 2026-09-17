/**
 * Labels `src-tauri/target` Medium when it inherited Low. See `src/host/integrity.ts`.
 *
 * Run before `tauri dev`: once the folder carries its own inheritable Medium
 * label, every binary cargo writes there starts at Medium, so the check costs
 * one `icacls` call and does nothing on a machine without the problem. Only
 * Windows has integrity labels.
 */

import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { hasLowLabel } from "../src/host/integrity"

if (process.platform === "win32") {
  const target = join(import.meta.dir, "..", "src-tauri", "target")
  mkdirSync(target, { recursive: true })
  const read = Bun.spawnSync(["icacls", target])
  if (hasLowLabel(read.stdout.toString())) {
    console.log("ADE: src-tauri/target ha l'etichetta di integrità Low, la porto a Medium…")
    const raised = Bun.spawnSync(["icacls", target, "/setintegritylevel", "(OI)(CI)Medium", "/T", "/C", "/Q"], {
      stdout: "inherit",
      stderr: "inherit",
    })
    if (raised.exitCode !== 0) {
      console.warn(
        "ADE: non sono riuscito a cambiare l'etichetta; nikcli e gli altri agenti potrebbero non scrivere i loro file.",
      )
    }
  }
}
