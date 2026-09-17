import { describe, expect, test } from "bun:test"
import { resolvePaneState, STATE_FULL, STATE_SHORT, type PaneState } from "./pane-state"
import { formatSessionQuota, type ProviderQuota } from "../session/quota"

describe("resolvePaneState (Proposal A 6-state resolution)", () => {
  test("resolves 'work' when status is working or provisioning", () => {
    expect(resolvePaneState({ status: "working" })).toBe("work")
    expect(resolvePaneState({ status: "provisioning" })).toBe("work")
  })

  test("resolves 'perm' when actions / interactive confirmation are pending", () => {
    expect(resolvePaneState({ status: "waiting", hasActions: true })).toBe("perm")
    expect(resolvePaneState({ status: "idle", hasActions: true })).toBe("perm")
  })

  test("resolves 'ask' when waiting on another session via ade-msg ask", () => {
    expect(resolvePaneState({ status: "waiting", activity: "ade-msg ask a «Fabio»" })).toBe("ask")
    expect(resolvePaneState({ status: "working", activity: "Attende risposta da Voice" })).toBe("ask")
  })

  test("resolves 'err' on process error or exit", () => {
    expect(resolvePaneState({ status: "error" })).toBe("err")
  })

  test("resolves 'limit' when quota is rate limited or exhausted", () => {
    const quotaView = {
      providerName: "Anthropic · Max",
      isLimit: true,
      remainingRatio: 0,
      bindingKey: "5h",
      displayValue: "0%",
      countdown: "1h 40m",
      level: "crit" as const,
      windows: [],
      tooltip: "",
    }
    expect(resolvePaneState({ status: "idle", quota: quotaView })).toBe("limit")
    expect(resolvePaneState({ status: "done", quota: quotaView })).toBe("limit")
  })

  test("permission and work rank before the provider's limit", () => {
    // The limit is the provider's; a prompt waiting for an answer and a turn
    // in progress are this session's, and they are what the user acts on.
    const quotaView = {
      providerName: "OpenAI · Free",
      isLimit: true,
      remainingRatio: 0,
      bindingKey: "720h",
      displayValue: "0%",
      level: "crit" as const,
      windows: [],
      tooltip: "",
    }
    expect(resolvePaneState({ status: "waiting", quota: quotaView, hasActions: true })).toBe("perm")
    expect(resolvePaneState({ status: "waiting", quota: quotaView })).toBe("perm")
    expect(resolvePaneState({ status: "working", quota: quotaView })).toBe("work")
    expect(resolvePaneState({ status: "error", quota: quotaView })).toBe("err")
  })

  test("a quota that is n/d never makes a session read as limited", () => {
    const missing = { unavailable: true as const, providerName: "Google", tooltip: "" }
    expect(resolvePaneState({ status: "idle", quota: missing })).toBe("idle")
  })

  test("resolves 'idle' when prompt is ready", () => {
    expect(resolvePaneState({ status: "idle" })).toBe("idle")
    expect(resolvePaneState({ status: "done" })).toBe("idle")
  })

  test("explicit state property takes precedence", () => {
    expect(resolvePaneState({ status: "idle", state: "work" })).toBe("work")
    expect(resolvePaneState({ status: "working", state: "limit" })).toBe("limit")
  })
})

describe("Proposal A state vocabulary", () => {
  const allStates: PaneState[] = ["work", "perm", "ask", "err", "limit", "idle"]

  test("all 6 canonical states have full and short Italian labels", () => {
    for (const st of allStates) {
      expect(STATE_FULL[st]).toBeDefined()
      expect(STATE_SHORT[st]).toBeDefined()
      expect(STATE_FULL[st].length).toBeGreaterThan(0)
      expect(STATE_SHORT[st].length).toBeGreaterThan(0)
    }
    expect(STATE_FULL.work).toBe("Al lavoro")
    expect(STATE_FULL.perm).toBe("In attesa di permesso")
    expect(STATE_FULL.ask).toBe("Attende un'altra sessione")
    expect(STATE_FULL.err).toBe("Bloccata")
    expect(STATE_FULL.limit).toBe("Limite raggiunto")
    expect(STATE_FULL.idle).toBe("Pronta")

    expect(STATE_SHORT.work).toBe("Al lavoro")
    expect(STATE_SHORT.perm).toBe("Permesso")
    expect(STATE_SHORT.ask).toBe("Attende")
    expect(STATE_SHORT.err).toBe("Bloccata")
    expect(STATE_SHORT.limit).toBe("Limite")
    expect(STATE_SHORT.idle).toBe("Pronta")
  })
})

describe("Quota Horizon formatting", () => {
  const now = 1_000_000

  test("the 5h window binds when it has less left than the week", () => {
    const quota: ProviderQuota = {
      id: "claude",
      name: "Anthropic · Max",
      status: "ok",
      metrics: [
        { label: "5h", remaining: 45, resetAt: new Date(now + 6_000_000).toISOString() },
        { label: "sett.", remaining: 71, resetAt: new Date(now + 172_800_000).toISOString() },
      ],
    }
    const view = formatSessionQuota(quota, now)
    expect(view.bindingKey).toBe("5h")
    expect(view.displayValue).toBe("45%")
    expect(view.countdown).toBe("1h 40m")
  })

  test("an exhausted window flags the limit and counts down to its reset", () => {
    const quota: ProviderQuota = {
      id: "claude",
      name: "Anthropic · Max",
      status: "rate_limited",
      metrics: [
        { label: "5h", remaining: 0, resetAt: new Date(now + 6_000_000).toISOString() },
        { label: "sett.", remaining: 44, resetAt: new Date(now + 172_800_000).toISOString() },
      ],
    }
    const view = formatSessionQuota(quota, now)
    expect(view.isLimit).toBe(true)
    expect(view.bindingKey).toBe("5h")
    expect(view.displayValue).toBe("0%")
    expect(view.level).toBe("crit")
    expect(view.countdown).toBe("1h 40m")
  })
})
