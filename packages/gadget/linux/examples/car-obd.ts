/**
 * Car gadget — a Pi Zero 2 W on the car's OBD-II port through an ELM327
 * adapter, tethered to the phone's hotspot or the car's own Wi-Fi.
 *
 * CarPlay and Android Auto are closed platforms (MFi and Google
 * certification), so nikcli does not run "inside" them. What a gadget can do
 * is read the car: RPM, speed, coolant temperature, fault codes — and the
 * head unit still plays whatever the phone plays, so the agent's replies can
 * reach you through the nikcli mobile app's notifications.
 *
 * ELM327 over serial: `/dev/ttyUSB0` for a USB adapter, `/dev/rfcomm0` after
 * `rfcomm bind` for a Bluetooth one. Lines are `AT` commands and PIDs in hex.
 */
import { spawnSync } from "node:child_process"
import { closeSync, openSync, readSync, writeSync } from "node:fs"
import { Gadget } from "@nikcli-ai/gadget"

const PORT = process.env.OBD_PORT ?? "/dev/ttyUSB0"
const BAUD = process.env.OBD_BAUD ?? "38400"

let configured = false
function port(): number {
  if (!configured) {
    spawnSync("stty", ["-F", PORT, BAUD, "raw", "-echo"], { stdio: "ignore" })
    configured = true
  }
  return openSync(PORT, "r+")
}

/** Send one command and read until the `>` prompt, within `signal`'s life. */
function query(command: string, signal: AbortSignal): string {
  const fd = port()
  try {
    writeSync(fd, `${command}\r`)
    const buffer = Buffer.alloc(256)
    let out = ""
    const started = Date.now()
    while (!out.includes(">") && Date.now() - started < 3_000 && !signal.aborted) {
      let read = 0
      try {
        read = readSync(fd, buffer, 0, buffer.length, null)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EAGAIN") continue
        throw error
      }
      if (read > 0) out += buffer.subarray(0, read).toString("ascii")
    }
    return out.replace(/[\r>]/g, "\n").trim()
  } finally {
    closeSync(fd)
  }
}

function init(signal: AbortSignal) {
  query("ATZ", signal)
  query("ATE0", signal)
  query("ATSP0", signal)
}

function pid(code: string, signal: AbortSignal): number[] {
  const raw = query(code, signal)
  const line = raw.split("\n").find((item) => /^41/.test(item.replace(/\s/g, "")))
  if (!line) throw new Error(`no data for ${code}: ${raw}`)
  const bytes = line.replace(/\s/g, "").match(/.{2}/g) ?? []
  return bytes.slice(2).map((hex) => parseInt(hex, 16))
}

export default new Gadget({
  name: "car",
  builtins: false,
  commands: {
    "car.status": {
      description: "RPM, speed (km/h), coolant temperature (°C) and engine load from the OBD-II port",
      args: { type: "object", properties: {}, additionalProperties: false },
      timeoutMs: 15_000,
      async run(_args, ctx) {
        init(ctx.signal)
        const [a, b] = pid("010C", ctx.signal)
        const [speed] = pid("010D", ctx.signal)
        const [coolant] = pid("0105", ctx.signal)
        const [load] = pid("0104", ctx.signal)
        return JSON.stringify({
          rpm: ((a ?? 0) * 256 + (b ?? 0)) / 4,
          speedKmh: speed ?? 0,
          coolantC: (coolant ?? 40) - 40,
          loadPct: Math.round(((load ?? 0) * 100) / 255),
        })
      },
    },
    "car.dtc": {
      description: "Read stored diagnostic trouble codes (mode 03)",
      args: { type: "object", properties: {}, additionalProperties: false },
      timeoutMs: 15_000,
      async run(_args, ctx) {
        init(ctx.signal)
        const raw = query("03", ctx.signal).replace(/\s/g, "")
        const codes: string[] = []
        const body = raw.startsWith("43") ? raw.slice(2) : raw
        for (const chunk of body.match(/.{4}/g) ?? []) {
          if (chunk === "0000") continue
          const first = parseInt(chunk[0]!, 16)
          const prefix = [
            "P0",
            "P1",
            "P2",
            "P3",
            "C0",
            "C1",
            "C2",
            "C3",
            "B0",
            "B1",
            "B2",
            "B3",
            "U0",
            "U1",
            "U2",
            "U3",
          ][first]
          codes.push(`${prefix}${chunk.slice(1)}`)
        }
        return JSON.stringify({ codes })
      },
    },
    "car.clear": {
      description: "Clear diagnostic trouble codes (mode 04). Ask before using it.",
      args: { type: "object", properties: {}, additionalProperties: false },
      timeoutMs: 15_000,
      async run(_args, ctx) {
        init(ctx.signal)
        return query("04", ctx.signal)
      },
    },
  },
})
