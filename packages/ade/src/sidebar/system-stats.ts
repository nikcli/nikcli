/**
 * The words the footer shows for what ADE is spending.
 *
 * ADE only — the app, its webview, the agents in the panes and their
 * children — never the machine as a whole: the question the strip answers is
 * "how much is ADE costing me", and a machine-wide number would move with a
 * browser in another window.
 *
 * Pure, so the rounding can be tested without a Solid component.
 */

import type { SystemStats } from "../host/shell"
import { t } from "../i18n"

const GB = 1024 ** 3
const MB = 1024 ** 2

/** `812 MB` under a gigabyte, `1.4 GB` above: the unit a person would say. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 MB"
  if (bytes < GB) return `${Math.round(bytes / MB)} MB`
  return `${(bytes / GB).toFixed(bytes < 10 * GB ? 1 : 0)} GB`
}

/** How loaded a number is, for the colour: calm, busy, or close to the ceiling. */
export type Load = "ok" | "busy" | "high"

export function loadOf(percent: number): Load {
  if (percent >= 90) return "high"
  if (percent >= 70) return "busy"
  return "ok"
}

/** `1.6G`, `812M`: the footer's width is the constraint, the tooltip has the words. */
export function formatBytesShort(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0M"
  if (bytes < GB) return `${Math.round(bytes / MB)}M`
  return `${(bytes / GB).toFixed(bytes < 10 * GB ? 1 : 0)}G`
}

/** A whole percent, with `<1%` for the small non-zero readings that would round to a lie. */
function percentShort(value: number): string {
  if (value > 0 && value < 1) return "<1%"
  return `${Math.round(value)}%`
}

export interface StatView {
  cpu: { text: string; load: Load; title: string }
  ram: { text: string; load: Load; title: string }
  mem: { text: string; load: Load; title: string }
}

export function describeStats(stats: SystemStats): StatView {
  const cpu = Math.max(0, Math.min(100, stats.cpu))
  const share = stats.ramTotal > 0 ? (stats.appMem / stats.ramTotal) * 100 : 0
  const who = t("stats.who", stats.processes)
  return {
    cpu: {
      text: percentShort(cpu),
      load: loadOf(cpu),
      title: t("stats.cpu", who, cpu.toFixed(1)),
    },
    ram: {
      text: formatBytesShort(stats.appMem),
      load: loadOf(share),
      title: t("stats.ram", who, formatBytes(stats.appMem)),
    },
    mem: {
      text: percentShort(share),
      load: loadOf(share),
      title: t("stats.mem", formatBytes(stats.ramTotal)),
    },
  }
}
