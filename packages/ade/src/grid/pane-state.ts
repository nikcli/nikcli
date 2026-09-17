import type { SessionQuota } from "../session/quota"
import { t } from "../i18n"

/*
 * `provisioning` comes before `working`: the worktree checkout runs for seconds
 * before the process starts, and a card stuck on `waiting` there reads as
 * "needs an answer" — which this session is not asking for.
 */
export type PaneStatus = "idle" | "provisioning" | "working" | "waiting" | "done" | "error"

/** The 6 distinct canonical session states for Proposal A header. */
export type PaneState = "work" | "perm" | "ask" | "err" | "limit" | "idle"

/* Getters, so each read is in the language of that moment (S41). */
export const STATE_FULL: Readonly<Record<PaneState, string>> = {
  get work() {
    return t("paneState.work")
  },
  get perm() {
    return t("paneState.perm")
  },
  get ask() {
    return t("paneState.ask")
  },
  get err() {
    return t("paneState.err")
  },
  get limit() {
    return t("paneState.limit")
  },
  get idle() {
    return t("paneState.idle")
  },
}

export const STATE_SHORT: Readonly<Record<PaneState, string>> = {
  get work() {
    return t("paneState.work")
  },
  get perm() {
    return t("paneState.short.perm")
  },
  get ask() {
    return t("paneState.short.ask")
  },
  get err() {
    return t("paneState.err")
  },
  get limit() {
    return t("paneState.short.limit")
  },
  get idle() {
    return t("paneState.idle")
  },
}

/**
 * Maps incoming status, activity, quota, and pending actions into one of the 6 canonical states:
 * - work: active agent task (working, provisioning)
 * - perm: waiting for user permission or interactive prompt action
 * - ask: waiting on another session (e.g. ade-msg ask)
 * - err: agent process failed or exited with error
 * - limit: provider quota rate limited or exhausted
 * - idle: prompt ready, agent waiting for instruction
 *
 * Limit is checked after permission and work, not before. The quota is the
 * provider's, shared by every session on it; a permission prompt or a running
 * turn is this session's own, and it is what the user has to act on or wait
 * for. Ranking Limit first made every Codex pane read "Limite" while it was
 * asking to run a command.
 */
export function resolvePaneState(props: {
  status?: PaneStatus
  state?: PaneState
  activity?: string
  quota?: SessionQuota
  hasActions?: boolean
}): PaneState {
  if (props.state) return props.state
  if (props.status === "error") return "err"
  if (props.hasActions) return "perm"
  if (props.status === "waiting") {
    if (props.activity && /ask|attende/i.test(props.activity)) return "ask"
    return "perm"
  }
  if (props.status === "working" || props.status === "provisioning") {
    if (props.activity && /ade-msg\s+ask|attende/i.test(props.activity)) return "ask"
    return "work"
  }
  if (props.quota && !("unavailable" in props.quota) && props.quota.isLimit) return "limit"
  return "idle"
}
