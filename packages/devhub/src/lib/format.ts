export function bytes(n: number): string {
  if (!Number.isFinite(n)) return "–"
  const units = ["B", "KB", "MB", "GB", "TB"]
  let i = 0
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024
    i++
  }
  return `${n >= 100 || i === 0 ? n.toFixed(0) : n.toFixed(1)} ${units[i]}`
}

export function duration(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds))
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  if (d) return `${d}d ${h}h`
  if (h) return `${h}h ${m}m`
  if (m) return `${m}m ${s % 60}s`
  return `${s}s`
}

export function ms(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(2)} s`
  if (n >= 10) return `${n.toFixed(0)} ms`
  if (n >= 0.1) return `${n.toFixed(2)} ms`
  return `${(n * 1000).toFixed(0)} µs`
}

export const pct = (n: number, digits = 1) => `${n.toFixed(digits)}%`
export const num = (n: number) => new Intl.NumberFormat("en").format(Math.round(n))
export const compact = (n: number) =>
  new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(n)
export const usd = (n: number) => `$${n.toFixed(n < 10 ? 3 : 2)}`
export const when = (t: number | string) => new Date(t).toLocaleString()
export const ago = (t: number) => `${duration((Date.now() - t) / 1000)} ago`
