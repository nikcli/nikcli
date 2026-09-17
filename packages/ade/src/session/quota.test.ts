import { describe, expect, test } from "bun:test"
import {
  cooldownRemainingMs,
  calculateReadiness,
  backoffForProvider,
  selectBestProvider,
  parseClaudeSnapshot,
  parseAntigravitySnapshot,
  compareUsage,
  formatCountdown,
  formatSessionQuota,
  parseQuotaAxiSnapshot,
  quotaForAgent,
  readQuotaAxiSnapshot,
  isQuotaUnavailable,
  QUOTA_STALE_MS,
  AGY_QUOTA_STALE_MS,
  readAgyQuota,
  readClaudeQuota,
  type ProviderQuota,
} from "./quota"
import type { TokenUsage } from "./shared"
import { resetLocaleForTests } from "../i18n"

describe("cooldownRemainingMs", () => {
  test("returns 0 if resetAt is missing or invalid", () => {
    expect(cooldownRemainingMs({ label: "test" }, 1000)).toBe(0)
    expect(cooldownRemainingMs({ label: "test", resetAt: "invalid-date" }, 1000)).toBe(0)
  })

  test("returns 0 if resetAt is in the past", () => {
    const now = 1_000_000
    const past = new Date(now - 5000).toISOString()
    expect(cooldownRemainingMs({ label: "test", resetAt: past }, now)).toBe(0)
  })

  test("returns remaining milliseconds if resetAt is in the future", () => {
    const now = 1_000_000
    const future = new Date(now + 12_000).toISOString()
    expect(cooldownRemainingMs({ label: "test", resetAt: future }, now)).toBe(12_000)
  })
})

describe("calculateReadiness", () => {
  const now = 1_000_000

  test("rate_limited status returns score 0.0 and calculates cooldown", () => {
    const quota: ProviderQuota = {
      id: "claude",
      name: "Claude Code",
      status: "rate_limited",
      metrics: [{ label: "5h", used: 100, remaining: 0, resetAt: new Date(now + 30_000).toISOString() }],
    }
    const r = calculateReadiness(quota, now)
    expect(r.score).toBe(0.0)
    expect(r.isAvailable).toBe(false)
    expect(r.cooldownMs).toBe(30_000)
    expect(r.resetAt).toBeDefined()
  })

  test("unauthenticated or error status returns score 0.0", () => {
    const quota: ProviderQuota = {
      id: "codex",
      name: "Codex",
      status: "unauthenticated",
      metrics: [],
      message: "login richiesto",
    }
    const r = calculateReadiness(quota, now)
    expect(r.score).toBe(0.0)
    expect(r.isAvailable).toBe(false)
    expect(r.reason).toContain("login richiesto")
  })

  test("healthy quota returns score proportional to lowest remaining metric", () => {
    const quota: ProviderQuota = {
      id: "claude",
      name: "Claude Code",
      status: "ok",
      metrics: [
        { label: "5h", remaining: 40 },
        { label: "7d", remaining: 85 },
      ],
    }
    const r = calculateReadiness(quota, now)
    expect(r.score).toBe(0.4)
    expect(r.isAvailable).toBe(true)
    expect(r.worstRemainingPct).toBe(40)
  })

  test("metric with 0 remaining makes provider unavailable", () => {
    const quota: ProviderQuota = {
      id: "claude",
      name: "Claude Code",
      status: "ok",
      metrics: [{ label: "5h", remaining: 0, resetAt: new Date(now + 10_000).toISOString() }],
    }
    const r = calculateReadiness(quota, now)
    expect(r.score).toBe(0.0)
    expect(r.isAvailable).toBe(false)
    expect(r.cooldownMs).toBe(10_000)
  })

  test("nominal availability when no metric limits are given", () => {
    const quota: ProviderQuota = {
      id: "agy",
      name: "Antigravity",
      status: "ok",
      metrics: [],
    }
    const r = calculateReadiness(quota, now)
    expect(r.score).toBe(1.0)
    expect(r.isAvailable).toBe(true)
  })

  test("multi-window: cooldown is taken only from the exhausted metric, not longer healthy ones (P1)", () => {
    const oneHour = 3_600_000
    const sevenDays = 7 * 24 * 3_600_000
    const quota: ProviderQuota = {
      id: "claude",
      name: "Claude Code",
      status: "ok",
      metrics: [
        { label: "5h", remaining: 0, resetAt: new Date(now + oneHour).toISOString() },
        { label: "7d", remaining: 50, resetAt: new Date(now + sevenDays).toISOString() },
      ],
    }
    const r = calculateReadiness(quota, now)
    expect(r.score).toBe(0.0)
    expect(r.isAvailable).toBe(false)
    expect(r.cooldownMs).toBe(oneHour)
    expect(r.resetAt).toBe(new Date(now + oneHour).toISOString())

    const plan = backoffForProvider(quota, now)
    expect(plan.mustWait).toBe(true)
    expect(plan.waitMs).toBe(oneHour + 500)
  })

  test("remaining percentage is clamped to [0, 100] and NaN safely handled (P2)", () => {
    const over100: ProviderQuota = {
      id: "claude",
      name: "Claude Code",
      status: "ok",
      metrics: [{ label: "credits", remaining: 150 }],
    }
    const r1 = calculateReadiness(over100, now)
    expect(r1.score).toBe(1.0)
    expect(r1.worstRemainingPct).toBe(100)

    const negative: ProviderQuota = {
      id: "claude",
      name: "Claude Code",
      status: "ok",
      metrics: [{ label: "credits", remaining: -20 }],
    }
    const r2 = calculateReadiness(negative, now)
    expect(r2.score).toBe(0.0)
    expect(r2.isAvailable).toBe(false)

    const nanMetric: ProviderQuota = {
      id: "claude",
      name: "Claude Code",
      status: "ok",
      metrics: [{ label: "credits", remaining: Number.NaN }],
    }
    const r3 = calculateReadiness(nanMetric, now)
    expect(r3.score).toBe(0.0)
    expect(r3.isAvailable).toBe(false)
  })
})

describe("backoffForProvider", () => {
  const now = 1_000_000

  test("available provider requires no wait", () => {
    const quota: ProviderQuota = {
      id: "codex",
      name: "Codex",
      status: "ok",
      metrics: [{ label: "limit", remaining: 80 }],
    }
    const plan = backoffForProvider(quota, now)
    expect(plan.mustWait).toBe(false)
    expect(plan.waitMs).toBe(0)
  })

  test("rate limited provider with resetAt gets deterministic wait with safety margin", () => {
    const future = new Date(now + 5_000).toISOString()
    const quota: ProviderQuota = {
      id: "claude",
      name: "Claude Code",
      status: "rate_limited",
      metrics: [{ label: "5h", remaining: 0, resetAt: future }],
    }
    const plan = backoffForProvider(quota, now)
    expect(plan.mustWait).toBe(true)
    // 5000ms + 500ms margin = 5500ms
    expect(plan.waitMs).toBe(5500)
    expect(plan.resetAt).toBe(future)
  })
})

describe("selectBestProvider", () => {
  const now = 1_000_000
  const quotas: Record<string, ProviderQuota> = {
    claude: {
      id: "claude",
      name: "Claude Code",
      status: "ok",
      metrics: [{ label: "5h", remaining: 15 }], // 15% residuo
    },
    codex: {
      id: "codex",
      name: "Codex",
      status: "rate_limited",
      metrics: [{ label: "limit", remaining: 0, resetAt: new Date(now + 60_000).toISOString() }],
    },
    gemini: {
      id: "gemini",
      name: "Gemini",
      status: "ok",
      metrics: [{ label: "pro", remaining: 90 }], // 90% residuo
    },
  }

  test("picks provider with highest readiness score", () => {
    const choice = selectBestProvider(["claude", "codex", "gemini"], quotas, now)
    expect(choice.chosen).toBe("gemini")
    expect(choice.readiness?.score).toBe(0.9)
  })

  test("skips rate limited providers even if listed first", () => {
    const choice = selectBestProvider(["codex", "claude"], quotas, now)
    expect(choice.chosen).toBe("claude")
    expect(choice.readiness?.score).toBe(0.15)
  })

  test("fails gracefully when all candidates are blocked", () => {
    const choice = selectBestProvider(["codex"], quotas, now)
    expect(choice.chosen).toBeUndefined()
    expect(choice.reason).toContain("non disponibili")
  })
})

describe("parseClaudeSnapshot", () => {
  test("parses live snapshot from official-bridge", () => {
    const raw = {
      version: 1,
      provider: "claude",
      capturedAt: "2026-09-15T12:00:00.000Z",
      data: {
        rateLimits: {
          five_hour: { used_percentage: 23.4, resets_at: "2026-09-15T15:00:00.000Z" },
          seven_day: { used_percentage: 12.0, resets_at: "2026-09-22T00:00:00.000Z" },
        },
      },
    }
    const quota = parseClaudeSnapshot(raw)
    expect(quota.status).toBe("ok")
    expect(quota.metrics).toHaveLength(2)
    expect(quota.metrics[0].label).toBe("Finestra 5h")
    expect(quota.metrics[0].used).toBe(23)
    expect(quota.metrics[0].remaining).toBe(77)
    expect(quota.metrics[0].resetAt).toBe("2026-09-15T15:00:00.000Z")
  })

  test("detects 100% usage as rate_limited", () => {
    const raw = {
      version: 1,
      provider: "claude",
      data: {
        rateLimits: {
          five_hour: { used_percentage: 100, resets_at: "2026-09-15T16:00:00.000Z" },
        },
      },
    }
    const quota = parseClaudeSnapshot(raw)
    expect(quota.status).toBe("rate_limited")
    expect(quota.metrics[0].remaining).toBe(0)
  })
})

describe("parseAntigravitySnapshot", () => {
  test("parses Gemini buckets from statusLine bridge", () => {
    const raw = {
      version: 1,
      provider: "antigravity",
      capturedAt: "2026-09-15T12:00:00.000Z",
      data: {
        planTier: "Ultra",
        quota: {
          "gemini-2.5-pro": { remaining_fraction: 0.85, reset_time: "2026-09-15T18:00:00.000Z" },
          "gemini-2.5-flash": { remaining_fraction: 1.0 },
        },
      },
    }
    const quota = parseAntigravitySnapshot(raw)
    expect(quota.status).toBe("ok")
    expect(quota.plan).toBe("Ultra")
    expect(quota.metrics).toHaveLength(2)
    const pro = quota.metrics.find((m) => m.label === "gemini-2.5-pro")
    expect(pro?.remaining).toBe(85)
    expect(pro?.resetAt).toBe("2026-09-15T18:00:00.000Z")
  })
})

describe("compareUsage", () => {
  test("identifies perfect match between ledger and transcript", () => {
    const a: TokenUsage = { input: 100, cacheRead: 50, cacheWrite: 20, output: 30, requests: 2 }
    const b: TokenUsage = { input: 100, cacheRead: 50, cacheWrite: 20, output: 30, requests: 2 }
    const res = compareUsage(a, b)
    expect(res.match).toBe(true)
    expect(res.totalDiff).toBe(0)
  })

  test("calculates deltas when there is variance", () => {
    const ledger: TokenUsage = { input: 120, cacheRead: 80, cacheWrite: 10, output: 40, requests: 3 }
    const transcript: TokenUsage = { input: 100, cacheRead: 50, cacheWrite: 10, output: 30, requests: 2 }
    const res = compareUsage(ledger, transcript)
    expect(res.match).toBe(false)
    expect(res.inputDiff).toBe(20)
    expect(res.cacheReadDiff).toBe(30)
    expect(res.outputDiff).toBe(10)
    expect(res.totalDiff).toBe(30)
  })
})

describe("formatCountdown", () => {
  test("formats hours and minutes", () => {
    expect(formatCountdown(1 * 3600_000 + 40 * 60_000)).toBe("1h 40m")
  })

  test("under an hour, minutes only: the bar is redrawn every 30 s, so seconds would be wrong", () => {
    expect(formatCountdown(5 * 60_000 + 12_000)).toBe("5m")
    expect(formatCountdown(5 * 60_000 + 59_000)).toBe("5m")
  })

  test("the last minute reads <1m, and a reset already due reads 0m", () => {
    expect(formatCountdown(45_000)).toBe("<1m")
    expect(formatCountdown(0)).toBe("0m")
    expect(formatCountdown(-5000)).toBe("0m")
  })
})

describe("formatSessionQuota", () => {
  const now = 1_000_000

  test("formats provider quota with binding window, level and countdown", () => {
    const quota: ProviderQuota = {
      id: "claude",
      name: "Anthropic · Max",
      status: "ok",
      metrics: [
        { label: "5h", remaining: 62, resetAt: new Date(now + 6_000_000).toISOString() }, // 1h 40m
        { label: "sett.", remaining: 71, resetAt: new Date(now + 172_800_000).toISOString() },
      ],
    }
    const view = formatSessionQuota(quota, now)
    expect(view.bindingKey).toBe("5h")
    expect(view.remainingRatio).toBe(0.62)
    expect(view.displayValue).toBe("62%")
    expect(view.level).toBe("ok")
    expect(view.countdown).toBe("1h 40m")
    expect(view.tooltip).toContain("Quota Anthropic · Max")
    expect(view.tooltip).toContain("5h: 62% rimasto")
  })

  test("flags critical level when remaining ratio is below 20%", () => {
    const quota: ProviderQuota = {
      id: "agy",
      name: "Google · Gemini",
      status: "ok",
      metrics: [
        { label: "2.5 Pro", remaining: 12, resetAt: new Date(now + 22_200_000).toISOString() },
        { label: "Flash", remaining: 90 },
      ],
    }
    const view = formatSessionQuota(quota, now)
    expect(view.bindingKey).toBe("2.5 Pro")
    expect(view.remainingRatio).toBe(0.12)
    expect(view.level).toBe("crit")
  })
})

describe("parseQuotaAxiSnapshot", () => {
  test("correctly parses quota-axi json format for claude and codex", () => {
    const raw = {
      generatedAt: "2026-09-15T18:45:14.212Z",
      schemaVersion: 1,
      providers: [
        {
          provider: "claude",
          label: "Claude",
          plan: "max",
          windows: [
            {
              id: "five_hour",
              label: "session",
              kind: "session",
              percentUsed: 21,
              percentRemaining: 79,
              resetsAt: "2026-09-15T22:40:00Z",
            },
            {
              id: "seven_day",
              label: "week",
              kind: "weekly",
              percentUsed: 41,
              percentRemaining: 59,
              resetsAt: "2026-09-21T13:00:00Z",
            },
          ],
        },
        {
          provider: "codex",
          label: "Codex",
          plan: "free",
          windows: [
            {
              id: "window:720h",
              label: "720h window",
              kind: "unknown",
              percentUsed: 100,
              percentRemaining: 0,
              resetsAt: "2026-10-13T13:12:12Z",
            },
          ],
        },
      ],
    }
    const parsed = parseQuotaAxiSnapshot(raw)
    expect(parsed.length).toBe(2)

    const claude = parsed.find((p) => p.id === "claude")
    expect(claude).toBeDefined()
    expect(claude?.name).toBe("Anthropic · Max")
    // The plan the report states, not an upgrade: "free" stays Free.
    expect(parsed.find((p) => p.id === "codex")?.name).toBe("OpenAI · Free")
    expect(claude?.metrics.find((m) => m.label === "5h")?.remaining).toBe(79)
    expect(claude?.metrics.find((m) => m.label === "sett.")?.remaining).toBe(59)

    const view = formatSessionQuota(claude!, Date.parse("2026-09-15T19:00:00Z"))
    expect(view.bindingKey).toBe("sett.")
    expect(view.displayValue).toBe("59%")
    expect(view.countdown).toBe("21/09")

    const codex = parsed.find((p) => p.id === "codex")
    expect(codex).toBeDefined()
    expect(codex?.status).toBe("rate_limited")
  })
})

describe("quotaForAgent: a real reading or n/d, never a made-up figure", () => {
  const written = Date.parse("2026-09-15T19:45:00Z")
  const report = {
    generatedAt: new Date(written).toISOString(),
    providers: [
      {
        provider: "claude",
        plan: "max",
        windows: [
          { id: "five_hour", kind: "session", percentRemaining: 64, resetsAt: "2026-09-15T22:40:00Z" },
          { id: "seven_day", kind: "weekly", percentRemaining: 57, resetsAt: "2026-09-21T13:00:00Z" },
        ],
        state: { stale: false },
      },
      {
        provider: "codex",
        plan: "free",
        windows: [{ id: "window:720h", percentRemaining: 0, resetsAt: "2026-10-13T13:12:12Z" }],
      },
      { provider: "cursor", windows: [{ id: "included_usage", percentRemaining: 97 }] },
    ],
  }
  const snapshot = readQuotaAxiSnapshot(report)
  const soon = written + 60_000

  test("Claude and Codex show what quota-axi reported", () => {
    const claude = quotaForAgent("claude-code", snapshot, soon)
    expect(isQuotaUnavailable(claude)).toBe(false)
    if (!claude || isQuotaUnavailable(claude)) throw new Error("unreachable")
    expect(claude.bindingKey).toBe("sett.")
    expect(claude.displayValue).toBe("57%")
    expect(claude.tooltip).toContain("Letto da quota-axi")

    const codex = quotaForAgent("codex", snapshot, soon)
    if (!codex || isQuotaUnavailable(codex)) throw new Error("expected a reading")
    expect(codex.isLimit).toBe(true)
  })

  test("agy is n/d without its own file, and nikcli is always n/d", () => {
    expect(isQuotaUnavailable(quotaForAgent("agy", snapshot, soon))).toBe(true)
    expect(isQuotaUnavailable(quotaForAgent("nikcli", snapshot, soon))).toBe(true)
  })

  test("no report or an undated one is n/d; an old or stale report stays, marked with its time", () => {
    expect(isQuotaUnavailable(quotaForAgent("claude-code", undefined, soon))).toBe(true)
    const undated = readQuotaAxiSnapshot({ providers: report.providers })
    expect(isQuotaUnavailable(quotaForAgent("claude-code", undated, soon))).toBe(true)

    const fresh = quotaForAgent("claude-code", snapshot, soon)
    if (!fresh || isQuotaUnavailable(fresh)) throw new Error("expected a reading")
    expect(fresh.stale).toBe(false)

    const old = quotaForAgent("claude-code", snapshot, written + QUOTA_STALE_MS + 1)
    if (!old || isQuotaUnavailable(old)) throw new Error("an old report must stay visible")
    expect(old.stale).toBe(true)
    expect(old.displayValue).toBe("57%")
    expect(old.readAt).toBeTruthy()
    expect(old.tooltip).toContain("Dato non recente")

    const marked = readQuotaAxiSnapshot({
      ...report,
      providers: [{ ...report.providers[0], state: { stale: true } }],
    })
    const kept = quotaForAgent("claude-code", marked, soon)
    if (!kept || isQuotaUnavailable(kept)) throw new Error("a report quota-axi marks stale must stay visible")
    expect(kept.stale).toBe(true)
  })

  test("a provider with no windows is n/d, not 100%", () => {
    const empty = readQuotaAxiSnapshot({
      generatedAt: report.generatedAt,
      providers: [{ provider: "claude", windows: [] }],
    })
    expect(isQuotaUnavailable(quotaForAgent("claude-code", empty, soon))).toBe(true)
  })

  test("an agent ADE has no quota notion for shows nothing", () => {
    expect(quotaForAgent("terminal", snapshot, soon)).toBeUndefined()
    expect(quotaForAgent(undefined, snapshot, soon)).toBeUndefined()
  })
})

describe("agy's quota from its status line (S30)", () => {
  const captured = Date.parse("2026-09-16T13:05:25.8021499Z")
  const file = {
    version: 1,
    provider: "antigravity",
    capturedAt: "2026-09-16T13:05:25.8021499Z",
    data: {
      quota: {
        "3p-5h": { remaining_fraction: 1, reset_time: "2026-09-16T18:03:04Z", reset_in_seconds: 17858 },
        "3p-weekly": { remaining_fraction: 1, reset_time: "2026-09-23T13:03:04Z", reset_in_seconds: 604658 },
        "gemini-5h": { remaining_fraction: 1, reset_time: "2026-09-16T18:03:04Z", reset_in_seconds: 17858 },
        "gemini-weekly": {
          remaining_fraction: 0.9404899,
          reset_time: "2026-09-23T06:46:39Z",
          reset_in_seconds: 582073,
        },
      },
      planTier: "Google AI Pro",
    },
  }
  const reading = readAgyQuota(file)
  const snapshot = { providers: {}, axiMissing: true, agy: reading }

  test("the real file reads as agy's windows, named for the bar", () => {
    expect(reading?.capturedAt).toBe(captured)
    expect(reading?.quota.name).toBe("Google AI Pro")
    expect(reading?.quota.metrics.map((m) => `${m.label} ${m.remaining}`)).toEqual([
      "3p 5h 100",
      "3p sett. 100",
      "Gemini 5h 100",
      "Gemini sett. 94",
    ])
  })

  test("a fresh file is agy's quota, bound by the lowest window, even without quota-axi", () => {
    const agy = quotaForAgent("agy", snapshot, captured + 60_000)
    if (!agy || isQuotaUnavailable(agy)) throw new Error("expected a reading")
    expect(agy.providerName).toBe("Google AI Pro")
    expect(agy.displayValue).toBe("94%")
    expect(agy.bindingKey).toBe("Gemini sett.")
    expect(agy.tooltip).toContain("statusLine di agy")
    expect(quotaForAgent("gemini-2.5-pro", snapshot, captured + 60_000)?.providerName).toBe("Google AI Pro")
  })

  test("quota-axi missing still leaves Claude n/d when only agy's file is there", () => {
    const claude = quotaForAgent("claude-code", snapshot, captured + 60_000)
    expect(isQuotaUnavailable(claude)).toBe(true)
    if (isQuotaUnavailable(claude)) expect(claude.tooltip).toContain("quota-axi")
  })

  test("a file older than an hour stays, marked; undated, empty or missing is n/d", () => {
    const recent = quotaForAgent("agy", snapshot, captured + AGY_QUOTA_STALE_MS - 1)
    if (!recent || isQuotaUnavailable(recent)) throw new Error("expected a reading")
    expect(recent.stale).toBe(false)
    const old = quotaForAgent("agy", snapshot, captured + AGY_QUOTA_STALE_MS + 1)
    if (!old || isQuotaUnavailable(old)) throw new Error("an old file must stay visible")
    expect(old.stale).toBe(true)
    expect(old.displayValue).toBe("94%")
    const undated = { providers: {}, agy: readAgyQuota({ ...file, capturedAt: undefined }) }
    expect(isQuotaUnavailable(quotaForAgent("agy", undated, captured))).toBe(true)
    const empty = { providers: {}, agy: readAgyQuota({ ...file, data: { planTier: "Google AI Pro" } }) }
    expect(isQuotaUnavailable(quotaForAgent("agy", empty, captured))).toBe(true)
    expect(isQuotaUnavailable(quotaForAgent("agy", { providers: {} }, captured))).toBe(true)
    expect(isQuotaUnavailable(quotaForAgent("agy", undefined, captured))).toBe(true)
  })

  test("a file dated in the future is n/d, since it would never age", () => {
    expect(isQuotaUnavailable(quotaForAgent("agy", snapshot, captured - 60_000))).toBe(true)
  })

  test("labels and tooltip follow the interface language", () => {
    resetLocaleForTests("en")
    try {
      const english = readAgyQuota(file)
      const agy = quotaForAgent("agy", { providers: {}, agy: english }, captured + 60_000)
      if (!agy || isQuotaUnavailable(agy)) throw new Error("expected a reading")
      expect(agy.bindingKey).toBe("Gemini week")
      expect(agy.tooltip).toContain("Gemini week: 94% left")
      expect(agy.tooltip).toContain("Read from agy's status line")
      const claude = quotaForAgent(
        "claude-code",
        readQuotaAxiSnapshot({
          generatedAt: "2026-09-16T13:05:00Z",
          providers: [{ provider: "claude", windows: [{ id: "seven_day", kind: "weekly", percentRemaining: 57 }] }],
        }),
        captured,
      )
      if (!claude || isQuotaUnavailable(claude)) throw new Error("expected a reading")
      expect(claude.bindingKey).toBe("week")
      expect(claude.tooltip).toContain("Read from quota-axi at")
    } finally {
      resetLocaleForTests("it")
    }
  })

  test("a file from another provider, or not an object, is no reading", () => {
    expect(readAgyQuota({ ...file, provider: "claude" })).toBeUndefined()
    expect(readAgyQuota(null)).toBeUndefined()
  })

  test("an exhausted window is a limit", () => {
    const spent = readAgyQuota({
      ...file,
      data: { quota: { "gemini-5h": { remaining_fraction: 0, reset_time: "2026-09-16T18:03:04Z" } } },
    })
    const agy = quotaForAgent("agy", { providers: {}, agy: spent }, captured)
    if (!agy || isQuotaUnavailable(agy)) throw new Error("expected a reading")
    expect(agy.isLimit).toBe(true)
    expect(agy.providerName).toBe("Google")
  })
})

describe("Claude's quota from its status line", () => {
  // The shape llm-quota's bridge writes, reset times in epoch seconds.
  const line = (used5h: number, at: string) => ({
    version: 1,
    provider: "claude",
    capturedAt: at,
    data: {
      rateLimits: {
        five_hour: { used_percentage: used5h, resets_at: 1789593600 },
        seven_day: { used_percentage: 72, resets_at: 1789995600 },
      },
    },
  })
  const axiAt = Date.parse("2026-09-16T16:20:12.177Z")
  const axi = readQuotaAxiSnapshot({
    generatedAt: "2026-09-16T16:20:12.177Z",
    providers: [
      {
        provider: "claude",
        plan: "max",
        windows: [
          { id: "five_hour", kind: "session", percentRemaining: 100, resetsAt: "2026-09-16T21:19:59Z" },
          { id: "seven_day", kind: "weekly", percentRemaining: 31, resetsAt: "2026-09-21T12:59:59Z" },
        ],
      },
    ],
  })

  test("reads the windows, with reset times given in seconds", () => {
    const reading = readClaudeQuota(line(26, "2026-09-16T18:59:21.8409116Z"))
    expect(reading?.capturedAt).toBe(Date.parse("2026-09-16T18:59:21.8409116Z"))
    expect(reading?.quota.metrics.map((m) => `${m.label} ${m.remaining} ${m.resetAt}`)).toEqual([
      "5h 74 2026-09-16T21:20:00.000Z",
      "sett. 28 2026-09-21T13:00:00.000Z",
    ])
    expect(readClaudeQuota({ ...line(26, "2026-09-16T18:59:21Z"), provider: "antigravity" })).toBeUndefined()
  })

  test("the newer of the two sources is shown, with the plan quota-axi knows", () => {
    // The state on this PC at 18:59 UTC: quota-axi last ran at 16:20.
    const now = Date.parse("2026-09-16T19:00:00Z")
    const both = { ...axi, claude: readClaudeQuota(line(26, "2026-09-16T18:59:21Z")) }
    const shown = quotaForAgent("claude-code", both, now)
    if (!shown || isQuotaUnavailable(shown)) throw new Error("expected a reading")
    expect(shown.stale).toBe(false)
    expect(shown.providerName).toBe("Anthropic · Max")
    expect(shown.displayValue).toBe("28%")
    expect(shown.tooltip).toContain("statusLine di Claude Code")

    // A quota-axi run after the status line wins again.
    const later = { ...axi, generatedAt: Date.parse("2026-09-16T18:59:50Z"), claude: both.claude }
    const fromAxi = quotaForAgent("claude-code", later, now)
    if (!fromAxi || isQuotaUnavailable(fromAxi)) throw new Error("expected a reading")
    expect(fromAxi.tooltip).toContain("quota-axi")
  })

  test("the reading time carries the day only when it is not the day of `now`", () => {
    const read = new Date(2026, 8, 16, 16, 20).getTime()
    const view = (now: number) => {
      const shown = quotaForAgent(
        "claude-code",
        { providers: {}, axiMissing: true, claude: readClaudeQuota(line(26, new Date(read).toISOString())) },
        now,
      )
      if (!shown || isQuotaUnavailable(shown)) throw new Error("expected a reading")
      return shown.readAt ?? ""
    }
    expect(view(new Date(2026, 8, 16, 18, 0).getTime())).toBe("16:20")
    expect(view(new Date(2026, 8, 17, 9, 0).getTime())).toBe("16/09, 16:20")
  })

  test("the status line alone is enough, without quota-axi's report", () => {
    const now = Date.parse("2026-09-16T19:00:00Z")
    const shown = quotaForAgent(
      "claude-code",
      { providers: {}, axiMissing: true, claude: readClaudeQuota(line(26, "2026-09-16T18:59:21Z")) },
      now,
    )
    if (!shown || isQuotaUnavailable(shown)) throw new Error("expected a reading")
    expect(shown.providerName).toBe("Anthropic")
  })

  test("the bar no longer alternates with quota-axi's runs (the reported bug)", () => {
    // quota-axi ran at 16:20 and not again; Claude's status line kept writing.
    // Before: a reading until 16:50, then n/d until the next quota-axi run.
    const seen: string[] = []
    for (let minute = 0; minute <= 180; minute += 15) {
      const now = axiAt + minute * 60_000
      const status = new Date(now - 30_000).toISOString()
      const snapshot = { ...axi, claude: readClaudeQuota(line(26, status)) }
      const shown = quotaForAgent("claude-code", snapshot, now)
      seen.push(isQuotaUnavailable(shown) ? "n/d" : shown!.stale ? "old" : "ok")
    }
    expect(seen.every((state) => state === "ok")).toBe(true)

    // With no status line either, the last figure stays with its time: never n/d.
    const onlyAxi = [0, 29, 31, 120].map((minute) => {
      const shown = quotaForAgent("claude-code", axi, axiAt + minute * 60_000)
      return isQuotaUnavailable(shown) ? "n/d" : shown!.stale ? "old" : "ok"
    })
    expect(onlyAxi).toEqual(["ok", "ok", "old", "old"])
  })
})

describe("which agents count as Codex", () => {
  test("o1, o3 and o4 as model names do, as parts of other words they do not", () => {
    for (const agent of ["o3", "o3-mini", "openai/o1", "o4-mini-high"]) {
      expect(quotaForAgent(agent, undefined, 0)?.providerName).toBe("OpenAI")
    }
    for (const agent of ["pro1", "demo3", "video1", "photo3-bot"]) {
      expect(quotaForAgent(agent, undefined, 0)).toBeUndefined()
    }
  })
})
