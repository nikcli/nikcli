/**
 * Permission beacon — a lamp that lights up when the agent needs you, and a
 * button that answers it.
 *
 * nikcli asks before risky tool calls. On a Pi with an LED on GPIO 18 and a
 * button on GPIO 17, this gadget turns the LED on while a permission is
 * pending and reports the press as `ui.press { key: "approve" }`.
 *
 * This file is the device half only. Closing the loop needs a nikcli mod that
 * turns a pending permission into a `beacon.set` call and the press into the
 * permission reply; that mod is not part of this repository.
 *
 * The LED is driven by a command so such a mod can switch it: `beacon.set`.
 */
import { writeFileSync, existsSync } from "node:fs"
import { Gadget, button } from "@nikcli-ai/gadget"

const LED_PIN = 18
const SYSFS = "/sys/class/gpio"

function led(on: boolean) {
  const dir = `${SYSFS}/gpio${LED_PIN}`
  if (!existsSync(dir)) writeFileSync(`${SYSFS}/export`, String(LED_PIN))
  writeFileSync(`${dir}/direction`, "out")
  writeFileSync(`${dir}/value`, on ? "1" : "0")
}

export default new Gadget({
  name: "permission-beacon",
  builtins: false,
  commands: {
    "beacon.set": {
      description: "Light the beacon (a permission is waiting) or switch it off",
      args: {
        type: "object",
        properties: { on: { type: "boolean" }, blink: { type: "boolean", description: "Pulse instead of steady" } },
        required: ["on"],
      },
      timeoutMs: 5_000,
      async run({ on, blink }: { on: boolean; blink?: boolean }, ctx) {
        if (!on || !blink) {
          led(on)
          return `beacon ${on ? "on" : "off"}`
        }
        for (let i = 0; i < 6 && !ctx.signal.aborted; i++) {
          led(i % 2 === 0)
          await new Promise((resolve) => setTimeout(resolve, 200))
        }
        led(true)
        return "beacon blinking then on"
      },
    },
  },
  buttons: button.gpio({ pins: { approve: 17, reject: 27 } }),
})
