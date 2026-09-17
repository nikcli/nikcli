/**
 * Where the register lives, and reading and appending it through the host.
 *
 * The register lives inside the project, `.ade/decisions.jsonl`, next to
 * ADE's other per-project files: the user chose that over one team folder
 * shared by several projects. The path stays configurable for a team that
 * wants the shared folder anyway.
 *
 * Appending goes through `appendTextFile`, a real append confined to the
 * project (`src-tauri/src/append.rs`): Master adds lines from a shell with
 * `>>` while ADE adds the user's answers, and a read-then-rewrite lost the
 * shell's line whenever it landed between the two. The register is read first
 * only to refuse an event the current state would reject. A host without the
 * append falls back to rewriting the file.
 */

import { parseDecisionLog, serializeDecisionEvent, type DecisionEvent, type ParsedLog } from "./log"
import { foldDecisions, type DecisionsState } from "./state"
import { t } from "../i18n"

export const DEFAULT_DECISIONS_PATH = ".ade/decisions.jsonl"

/** The register can grow for months; this is far beyond what a team writes. */
export const MAX_REGISTER_BYTES = 8 * 1024 * 1024

/**
 * The register's absolute path.
 *
 * `setting` may be absolute (a shared team folder) or relative to the project
 * root. Blank means the default. Separators follow the root's style, so the
 * path compares equal to the ones the sidebar and the editor use on Windows.
 */
export function decisionsPath(projectRoot: string, setting?: string): string {
  const chosen = setting?.trim() || DEFAULT_DECISIONS_PATH
  if (isAbsolute(chosen)) return chosen
  const separator = projectRoot.includes("\\") && !projectRoot.includes("/") ? "\\" : "/"
  const root = projectRoot.replace(/[\\/]+$/, "")
  return `${root}${separator}${chosen.replace(/^\.?[\\/]+/, "").replace(/[\\/]/g, separator)}`
}

function isAbsolute(path: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(path) || path.startsWith("/") || path.startsWith("\\\\")
}

/** The two host calls the store needs; `host/shell.ts` provides both in ADE. */
export interface DecisionsIo {
  readTextFile: (path: string, maxBytes?: number) => Promise<{ text: string; truncated: boolean }>
  writeTextFile: (path: string, contents: string) => Promise<string | null>
  appendTextFile?: (path: string, text: string) => Promise<string | null>
  exists?: (path: string) => Promise<boolean>
}

export interface LoadedRegister extends ParsedLog {
  readonly text: string
  readonly state: DecisionsState
}

/** Reads the register. A file that does not exist yet is an empty register. */
export async function loadDecisions(io: DecisionsIo, path: string, now: Date = new Date()): Promise<LoadedRegister> {
  const text = await readRegister(io, path)
  const parsed = parseDecisionLog(text)
  return { ...parsed, text, state: foldDecisions(parsed.events, now) }
}

async function readRegister(io: DecisionsIo, path: string): Promise<string> {
  if (io.exists && !(await io.exists(path))) return ""
  let read: { text: string; truncated: boolean }
  try {
    read = await io.readTextFile(path, MAX_REGISTER_BYTES)
  } catch (error) {
    // Without `exists`, a missing file is the one failure that means "empty".
    if (!io.exists && /not found|no such file|os error 2|impossibile trovare/i.test(String(error))) return ""
    throw error
  }
  if (read.truncated) throw new Error(t("decisions.log.tooLarge", MAX_REGISTER_BYTES / (1024 * 1024)))
  return read.text
}

/**
 * Appends one event, if the register as it is now accepts it.
 *
 * Resolves to the state after the append; rejects with the rule it broke, or
 * with the host's write error.
 */
export async function appendDecisionEvent(
  io: DecisionsIo,
  path: string,
  event: DecisionEvent,
  now: Date = new Date(),
): Promise<DecisionsState> {
  const line = serializeDecisionEvent(event)
  const text = await readRegister(io, path)
  const parsed = parseDecisionLog(text)
  const after = foldDecisions([...parsed.events, event], now)
  const refused = after.rejected.find((item) => item.event === event)
  if (refused) throw new Error(refused.reason)

  // A file whose writer died mid-line ends without a newline; start ours on a
  // fresh line so that damage stays confined to the broken line.
  const joiner = text.length > 0 && !text.endsWith("\n") ? "\n" : ""
  const failure = io.appendTextFile
    ? await io.appendTextFile(path, `${joiner}${line}`)
    : await io.writeTextFile(path, `${text}${joiner}${line}`)
  if (failure) throw new Error(failure)
  return after
}
