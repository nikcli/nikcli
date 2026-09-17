/**
 * What a pane is doing, as a stable value and as the words shown for it.
 *
 * `Pane.activity` used to hold the Italian sentence itself, and the code
 * compared against it (`!== "Disponibile"`). With the interface in two
 * languages (S41) the sentence cannot be the value: the logic would break the
 * moment it was translated. So ADE's own states are codes, and the label is
 * looked up when drawn.
 *
 * The field still carries free text too — an agent's report ("Editing
 * main.ts") lands in the same place — and that passes through untouched.
 * Italian sentences written by an earlier build, in a saved workspace or in a
 * pane still open, are read as the code they stood for.
 */
import { t, type MessageKey } from "../i18n"

export const ACTIVITY_CODES = [
  "ready",
  "running",
  "starting",
  "done",
  "resumed",
  "toResume",
  "restored",
  "killed",
  "permission",
  "startFailed",
  "sshConnecting",
  "connected",
  "connectFailed",
] as const

export type ActivityCode = (typeof ACTIVITY_CODES)[number]

/** Exit with a code other than 0: the one state that carries a value. `?` when the OS gave none. */
export function exitedActivity(code: number | string | null | undefined): string {
  return `exited:${code ?? "?"}`
}

const LABELS: Record<ActivityCode, MessageKey> = {
  ready: "activity.ready",
  running: "activity.running",
  starting: "activity.starting",
  done: "activity.done",
  resumed: "activity.resumed",
  toResume: "activity.toResume",
  restored: "activity.restored",
  killed: "activity.killed",
  permission: "activity.permission",
  startFailed: "activity.startFailed",
  sshConnecting: "activity.sshConnecting",
  connected: "activity.connected",
  connectFailed: "activity.connectFailed",
}

/** The sentences earlier builds stored, and what each one meant. */
const LEGACY: Record<string, ActivityCode> = {
  Disponibile: "ready",
  "In esecuzione": "running",
  Inizializzazione: "starting",
  Fatto: "done",
  "Sessione ripresa": "resumed",
  "Da riprendere": "toResume",
  Ripristinato: "restored",
  Ucciso: "killed",
  "In attesa di permesso": "permission",
  "Avvio fallito": "startFailed",
  "Connessione ssh": "sshConnecting",
  Connesso: "connected",
  "Connessione fallita": "connectFailed",
}

const EXITED = /^(?:exited:|Uscito con )(\S+)$/

function isCode(value: string): value is ActivityCode {
  return (ACTIVITY_CODES as readonly string[]).includes(value)
}

/**
 * The stable form of a stored activity: a code for ADE's own states, the
 * text unchanged for anything else. Safe to apply twice.
 */
export function normalizeActivity(value: string): string
export function normalizeActivity(value: string | undefined): string | undefined
export function normalizeActivity(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  if (isCode(value)) return value
  const legacy = LEGACY[value]
  if (legacy) return legacy
  const exited = EXITED.exec(value)
  return exited ? exitedActivity(exited[1]!) : value
}

/** Whether the pane is simply waiting for its next instruction. */
export function isReadyActivity(value: string | undefined): boolean {
  return value !== undefined && normalizeActivity(value) === "ready"
}

/** The words for an activity, in the current language. */
export function activityLabel(value: string): string
export function activityLabel(value: string | undefined): string | undefined
export function activityLabel(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const stable = normalizeActivity(value)
  if (isCode(stable)) return t(LABELS[stable])
  const exited = EXITED.exec(stable)
  if (exited) return t("activity.exited", exited[1]!)
  return stable
}
