/**
 * `device.health` — uptime, load, memory, disk and temperature.
 *
 * Everything comes from `node:os` and `/sys`, so it answers on any Linux
 * board and degrades to "unknown" rather than failing where a sensor is
 * missing: a Pi Zero without a thermal zone still reports its memory.
 */
import { readFileSync } from "node:fs"
import { statfs } from "node:fs/promises"
import { freemem, loadavg, totalmem, uptime } from "node:os"
import type { HealthInfo } from "../protocol.ts"
import type { CommandHandler } from "../gadget.ts"

export const spec = {
  name: "device.health",
  description: "Report the gadget's uptime, load average, memory, disk and temperature.",
  args: { type: "object", properties: {}, additionalProperties: false },
  timeoutMs: 5_000,
} as const

export async function collect(diskPath = "/"): Promise<HealthInfo> {
  const [one, five, fifteen] = loadavg()
  let disk: HealthInfo["disk"]
  try {
    const stats = await statfs(diskPath)
    disk = { path: diskPath, totalBytes: stats.blocks * stats.bsize, freeBytes: stats.bavail * stats.bsize }
  } catch {
    disk = undefined
  }
  let temperatureC: number | undefined
  try {
    const raw = readFileSync("/sys/class/thermal/thermal_zone0/temp", "utf8").trim()
    const value = Number(raw)
    if (Number.isFinite(value)) temperatureC = value > 1000 ? value / 1000 : value
  } catch {
    temperatureC = undefined
  }
  return {
    uptimeSec: Math.floor(uptime()),
    load: [one ?? 0, five ?? 0, fifteen ?? 0],
    memory: { totalBytes: totalmem(), freeBytes: freemem() },
    ...(disk ? { disk } : {}),
    ...(temperatureC === undefined ? {} : { temperatureC }),
    time: Date.now(),
  }
}

export const run: CommandHandler<Record<string, never>> = async () => ({ output: JSON.stringify(await collect()) })
