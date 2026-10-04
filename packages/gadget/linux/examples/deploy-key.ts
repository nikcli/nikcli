/**
 * Deploy key — a physical key switch that gates the agent's deploys.
 *
 * This file is the device half only. A nikcli mod (not included here) would
 * hook `tool.check` for `bash` calls matching `git push` or your deploy
 * script, ask this gadget `key.state`, and refuse the call while the key is
 * not turned, whatever the permission rules say. Turning the key is then the
 * approval, and taking it out of the drawer is the audit trail.
 *
 * Key switch between GPIO 22 and ground (pull-up): 0 = turned.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs"
import { Gadget } from "@nikcli-ai/gadget"

const KEY_PIN = 22
const SYSFS = "/sys/class/gpio"

function keyTurned(): boolean {
  const dir = `${SYSFS}/gpio${KEY_PIN}`
  if (!existsSync(dir)) {
    writeFileSync(`${SYSFS}/export`, String(KEY_PIN))
    writeFileSync(`${dir}/direction`, "in")
  }
  return readFileSync(`${dir}/value`, "utf8").trim() === "0"
}

export default new Gadget({
  name: "deploy-key",
  builtins: false,
  commands: {
    "key.state": {
      description: "Whether the deploy key is turned. The agent may deploy only while it is.",
      args: { type: "object", properties: {}, additionalProperties: false },
      timeoutMs: 2_000,
      async run() {
        const turned = keyTurned()
        return { output: JSON.stringify({ turned, time: Date.now() }), isError: false }
      },
    },
  },
})
