/**
 * The API keys the user keeps in ADE: what the page knows about them, and
 * which of them a session gets when it starts.
 *
 * The values are never here. They live in the system keychain and only Rust
 * reads them (`src-tauri/src/secrets.rs`); this side handles names, the
 * variable each becomes, the agents allowed to receive it, and a masked tail
 * for recognising one key from another.
 *
 * Plain `.ts`, so the rules are tested under `bun test`.
 */

import type { PanelOutcome, PanelRequest } from "../panels/protocol"
import { locale, t, translate, type Locale } from "../i18n"

export interface KeyInfo {
  readonly name: string
  readonly env: string
  /** Agent ids that receive it at launch; empty means none. */
  readonly agents: readonly string[]
  readonly createdMs: number
  /** `••••••••abcd`; undefined when the keychain lost the value. */
  readonly masked?: string
}

export interface KeyDraft {
  readonly name: string
  readonly env: string
  readonly agents: readonly string[]
  /** Undefined when editing and the value stays as it is. */
  readonly value?: string
}

/** Mirrors `check_name` in `secrets.rs`, so the form can say so before saving. */
export function nameProblem(name: string): string | undefined {
  const trimmed = name.trim()
  if (!trimmed) return t("keys.problem.noName")
  if (trimmed.length > 64 || !/^[A-Za-z0-9][A-Za-z0-9 ._-]*$/.test(trimmed)) return t("keys.problem.nameChars")
  return undefined
}

const RESERVED_ENV = new Set([
  "PATH",
  "PATHEXT",
  "TERM",
  "COLORTERM",
  "HOME",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "SYSTEMROOT",
  "SYSTEMDRIVE",
  "WINDIR",
  "COMSPEC",
  "TEMP",
  "TMP",
  "SHELL",
  "PWD",
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "DYLD_INSERT_LIBRARIES",
  "NODE_OPTIONS",
])

/**
 * Mirrors `check_env` in `secrets.rs`. In the interface language, except
 * where an agent reads it (`@ade keys ask`), which passes Italian.
 */
export function envProblem(
  env: string,
  others: readonly KeyInfo[] = [],
  name = "",
  language: Locale = locale(),
): string | undefined {
  const trimmed = env.trim()
  if (!trimmed) return translate(language, "keys.problem.noEnv")
  if (!/^[A-Z_][A-Z0-9_]{0,63}$/.test(trimmed)) return translate(language, "keys.problem.envChars")
  if (RESERVED_ENV.has(trimmed) || trimmed.startsWith("ADE_"))
    return translate(language, "keys.problem.reserved", trimmed)
  if (others.some((key) => key.env === trimmed && key.name !== name.trim()))
    return translate(language, "keys.problem.taken", trimmed)
  return undefined
}

/** Mirrors `check_value` in `secrets.rs`. */
export function valueProblem(value: string): string | undefined {
  if (!value.trim()) return t("keys.problem.noValue")
  if (value.length > 4096) return t("keys.problem.tooLong")
  if (/[\0\r\n]/.test(value)) return t("keys.problem.newline")
  return undefined
}

/** `OpenAI key` → `OPENAI_API_KEY`: a starting point the user can change. */
export function suggestEnv(name: string): string {
  const base = name
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/^(\d)/, "_$1")
  if (!base) return ""
  if (/(_KEY|_TOKEN|_SECRET)$/.test(base)) return base
  return `${base.replace(/_API$/, "")}_API_KEY`
}

/** The names of the keys `agentId` gets at launch. */
export function keysForAgent(keys: readonly KeyInfo[], agentId: string): string[] {
  return keys.filter((key) => key.masked !== undefined && key.agents.includes(agentId)).map((key) => key.name)
}

/**
 * Variables that change how an agent is billed or signed in, not just what it
 * can reach. Claude Code with `ANTHROPIC_API_KEY` in its environment uses the
 * key instead of the subscription; codex with `OPENAI_API_KEY` likewise.
 */
const BILLING_SWITCH: Record<
  string,
  { agent: string; label: string; account: "keys.billing.claude" | "keys.billing.chatgpt" }
> = {
  ANTHROPIC_API_KEY: { agent: "claude-code", label: "Claude Code", account: "keys.billing.claude" },
  OPENAI_API_KEY: { agent: "codex", label: "Codex", account: "keys.billing.chatgpt" },
}

/** The warning to show next to an agent that would switch to paid API use. */
export function billingWarning(env: string, agentId: string): string | undefined {
  const rule = BILLING_SWITCH[env.trim()]
  if (!rule || rule.agent !== agentId) return undefined
  return t("keys.billing", rule.label, t(rule.account))
}

/* What an agent can ask for with `@ade keys …`. */

export const KEYS_VERBS = [
  { name: "list", usage: "list", summary: "elenca le chiavi salvate: nome, variabile e agenti, mai il valore" },
  {
    name: "ask",
    usage: "ask <NOME_VARIABILE> [motivo]",
    summary: "chiede all'utente di salvare una chiave; arriva alla sessione al prossimo avvio",
  },
] as const

export interface KeysController {
  list(): Promise<readonly KeyInfo[]>
  /** Opens the request dialog; resolves once it is on screen. */
  ask(env: string, reason: string): void
}

export async function runKeysCommand(controller: KeysController, request: PanelRequest): Promise<PanelOutcome> {
  if (request.verb === "list") {
    const keys = await controller.list()
    if (keys.length === 0) return { ok: true, detail: "nessuna chiave salvata" }
    return {
      ok: true,
      detail: keys
        .map((key) => `${key.name} → ${key.env} (${key.agents.length > 0 ? key.agents.join(", ") : "a nessun agente"})`)
        .join("; "),
    }
  }
  if (request.verb === "ask") {
    const [env = "", ...rest] = request.args
    const problem = envProblem(env, [], "", "it")
    if (problem) return { ok: false, reason: `variabile: ${problem}` }
    const keys = await controller.list()
    const existing = keys.find((key) => key.env === env)
    controller.ask(env, rest.join(" ").trim())
    return {
      ok: true,
      detail: existing
        ? `${env} esiste già come «${existing.name}»: chiesto all'utente di darla a questo agente; vale dal prossimo avvio della sessione`
        : `chiesto all'utente di salvare ${env}; vale dal prossimo avvio della sessione, il valore non passa da qui`,
    }
  }
  return { ok: false, reason: `verbo sconosciuto: ${request.verb}` }
}

/** "3 giorni fa", "oggi": when a key was added. */
export function addedLabel(createdMs: number, now: number): string {
  if (!createdMs) return ""
  const days = Math.floor((now - createdMs) / 86_400_000)
  if (days <= 0) return t("keys.added.today")
  if (days === 1) return t("keys.added.yesterday")
  return t("keys.added.days", days)
}
