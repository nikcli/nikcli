import { describe, expect, test } from "bun:test"
import { describeStats, formatBytes, loadOf } from "./system-stats"

const GB = 1024 ** 3

describe("system stats", () => {
  test("bytes read in the unit a person would say", () => {
    expect(formatBytes(512 * 1024 ** 2)).toBe("512 MB")
    expect(formatBytes(1.44 * GB)).toBe("1.4 GB")
    expect(formatBytes(32 * GB)).toBe("32 GB")
    expect(formatBytes(0)).toBe("0 MB")
    expect(formatBytes(Number.NaN)).toBe("0 MB")
  })

  test("load turns amber at 70% and red at 90%", () => {
    expect([loadOf(10), loadOf(70), loadOf(95)]).toEqual(["ok", "busy", "high"])
  })

  test("the three numbers describe ADE, not the machine", () => {
    const view = describeStats({ cpu: 3.24, appMem: 1.2 * GB, ramTotal: 32 * GB, processes: 14 })
    expect([view.cpu.text, view.ram.text, view.mem.text]).toEqual(["3%", "1.2G", "4%"])
    expect(view.ram.title).toContain("1.2 GB")
    expect(describeStats({ cpu: 0.4, appMem: 300 * 1024 ** 2, ramTotal: 32 * GB, processes: 2 }).cpu.text).toBe("<1%")
    expect(view.ram.title).toContain("14 processi")
    expect(describeStats({ cpu: 140, appMem: 0, ramTotal: 0, processes: 1 }).cpu.text).toBe("100%")
  })
})
