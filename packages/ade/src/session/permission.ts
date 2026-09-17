/**
 * Detection of permission requests from agent CLI processes.
 *
 * Agents running in subprocesses frequently pause and request user confirmation
 * before executing actions (running shell commands, modifying files, making
 * network calls).
 *
 * This module inspects the trailing output lines of an agent process to detect
 * when it is blocked waiting for interactive confirmation, extracts the target
 * action and acceptable responses, and tracks resolution when output resumes.
 *
 * Everything here is pure: strings in, structured data out.
 */

import { stripAnsi } from "./stream"

export interface PermissionRequest {
  /** Cosa l'agente vuole fare, in una riga, come l'ha scritto lui. */
  what: string
  /** Categoria, quando è deducibile: comando shell, scrittura file, rete. */
  kind: "shell" | "write" | "network" | "unknown"
  /** Il comando o il percorso in gioco, se la riga lo dice. */
  target?: string
  /** Risposte accettate, nell'ordine in cui vanno mostrate. */
  answers: PermissionAnswer[]
}

export interface PermissionAnswer {
  /** Etichetta per il bottone, in italiano. */
  label: string
  /**
   * The keystrokes that choose this answer — without the Enter that submits
   * them.
   *
   * The terminator is the caller's, added once by `asSubmittedLine`, because
   * whether an answer is submitted at all is a decision about the session and
   * not about the question. What must not happen again is what happened
   * before: this string written to stdin verbatim, so `y` sat unread in the
   * agent's input buffer while ADE cleared the request and reported the pane
   * as running.
   */
  send: string
  tone: "primary" | "secondary"
}

// ---------------------------------------------------------------------------
// Category and Target Extraction
// ---------------------------------------------------------------------------

const URL_RE = /https?:\/\/[^\s"'`<>)?]+/
const FILE_PATH_RE = /(?:[a-zA-Z]:[\\/]|(?:\.{1,2}[\\/])|\/|[a-zA-Z0-9_-]+[\\/])[a-zA-Z0-9_./\\-]+\.[a-zA-Z0-9]+/

function cleanTarget(target: string | undefined): string | undefined {
  if (!target) return undefined
  return target
    .replace(/\s*(?:\[|\()[yYnN](?:\s*\/\s*[yYnN](?:\s*\/\s*[aAcCdD])?)?(?:\]|\))\s*[:?]?\s*$/, "")
    .replace(/\s*\?\s*$/, "")
    .trim()
}

function extractKindAndTarget(
  text: string,
  contextLines: string[]
): { kind: "shell" | "write" | "network" | "unknown"; target?: string } {
  const combined = [...contextLines, text].join("\n")

  // 1. Network requests
  const urlMatch = combined.match(URL_RE)
  if (urlMatch && /\b(?:network|fetch|curl|http|https|connect|download|request|endpoint|rete)\b/i.test(combined)) {
    return { kind: "network", target: cleanTarget(urlMatch[0]) }
  }

  // 2. Shell commands ($ command or `command` with shell keywords)
  for (const line of [...contextLines, text].reverse()) {
    const dollarMatch = line.match(/^\s*\$\s+(.+)$/)
    if (dollarMatch) {
      return { kind: "shell", target: cleanTarget(dollarMatch[1]) }
    }
  }

  if (/\b(?:shell|command|exec|execut\w*|run|running|bash|terminal|process|comando)\b/i.test(combined)) {
    const backtickMatch = text.match(/`([^`]+)`/) || combined.match(/`([^`]+)`/)
    if (backtickMatch) {
      return { kind: "shell", target: cleanTarget(backtickMatch[1]) }
    }
    const cmdPrefixMatch = combined.match(
      /(?:run shell command|run command|execute command|run shell|command|run|execute|comando):\s*(.+)/i
    )
    if (cmdPrefixMatch) {
      return { kind: "shell", target: cleanTarget(cmdPrefixMatch[1]) }
    }
    return { kind: "shell" }
  }

  // 3. File write / modification
  const filePathMatch = text.match(FILE_PATH_RE) || combined.match(FILE_PATH_RE)
  if (
    filePathMatch &&
    /\b(?:write|create|modify|edit|overwrite|delete|save|file|apply|patch|disk|salva|scrittura|modifica)\b/i.test(
      combined
    )
  ) {
    return { kind: "write", target: cleanTarget(filePathMatch[0]) }
  }

  if (/\b(?:write|create|modify|edit|overwrite|delete|file|salva|scrittura|modifica)\b/i.test(combined)) {
    return { kind: "write" }
  }

  if (urlMatch) {
    return { kind: "network", target: cleanTarget(urlMatch[0]) }
  }

  return { kind: "unknown" }
}

// ---------------------------------------------------------------------------
// Italian Label Mapping
// ---------------------------------------------------------------------------

function mapChoiceLabelToItalian(rawText: string): string {
  const t = rawText.trim().toLowerCase()

  if (
    /^(?:yes,?\s+and\s+don't\s+ask\s+again|always\s+allow|allow\s+always|yes,?\s+always|allow\s+for\s+session|consenti\s+sempre)$/i.test(
      t
    )
  ) {
    return "Sì, e non chiedere più"
  }
  if (/^(?:allow\s+once|consenti\s+una\s+volta)$/i.test(t)) {
    return "Consenti una volta"
  }
  if (/^(?:yes|y|sì|si|allow|approve|proceed|confirm|concedi|consenti|accetta)$/i.test(t)) {
    return "Sì"
  }
  if (/^(?:no,?\s+and\s+cancel|no,?\s+e\s+annulla)$/i.test(t)) {
    return "No, e annulla"
  }
  if (/^(?:no|n|deny|reject|nega|rifiuta)$/i.test(t)) {
    return "No"
  }
  if (/^(?:cancel|annulla|abort)$/i.test(t)) {
    return "Annulla"
  }
  if (/^(?:skip|salta)$/i.test(t)) {
    return "Salta"
  }
  return rawText.trim()
}

// ---------------------------------------------------------------------------
// False Positive Detection
// ---------------------------------------------------------------------------

function isFalsePositive(lines: string[]): boolean {
  if (lines.length === 0) return true
  const lastLine = lines[lines.length - 1].trim()

  // Diff output lines
  if (
    lastLine.startsWith("+++") ||
    lastLine.startsWith("---") ||
    lastLine.startsWith("@@") ||
    lastLine.startsWith("diff --git") ||
    lastLine.startsWith("index ") ||
    /^[+-][^+-]/.test(lastLine) ||
    lastLine === "+" ||
    lastLine === "-"
  ) {
    return true
  }

  // Test runner output
  if (
    /^(?:PASS|FAIL|RUNS|TAP version|ok\s+\d+|not ok\s+\d+|✓|✕|●)\b/.test(lastLine) ||
    /\b(?:tests? passed|tests? failed|expect\(|toBe\(|toEqual\()\b/.test(lastLine) ||
    /^(?:Test Suites:|Tests:|Snapshots:|Time:)/.test(lastLine)
  ) {
    return true
  }

  // Thinking / Reasoning / Internal monologue
  if (/^(?:Thinking|Thought|Reasoning|Note|Reflecting):/i.test(lastLine)) {
    return true
  }

  // Rhetorical question followed by immediate explanation on the same line
  if (/\?\s+[A-Z][a-z]+/.test(lastLine) && !/\?\s*\[[yYnN]/.test(lastLine)) {
    return true
  }

  // Progress bars & spinners
  if (
    /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/.test(lastLine) ||
    /\[[=>#-]+\s*\]\s*\d+%/.test(lastLine) ||
    /\b\d+%\s+(?:ETA|\d+\s*(?:MB|KB|GB)\/s)/i.test(lastLine)
  ) {
    return true
  }

  // Stack traces
  if (/^\s+at\s+/.test(lastLine) && /\.\w+:\d+/.test(lastLine)) {
    return true
  }

  return false
}

// ---------------------------------------------------------------------------
// Pattern Schemas
// ---------------------------------------------------------------------------

export interface PermissionSchema {
  id: string
  name: string
  agentId?: string
  priority?: number
  match: (lines: string[]) => PermissionRequest | undefined
}

const NUMBERED_OPTION_RE = /^\s*(?:\[?(\d+)\]?[.)\s])\s*(.+)$/
const YN_PATTERN_RE = /(?:\[|\()([yYnN](?:\s*\/\s*[yYnN](?:\s*\/\s*[aAcCdD])?)?)(?:\]|\))\s*[:?]?\s*$/

export const PERMISSION_SCHEMAS: readonly PermissionSchema[] = [
  // 1. Numbered choices list (e.g. 1. Yes, 2. Yes and don't ask again, 3. No)
  {
    id: "numbered-choices",
    name: "Numbered Choices",
    priority: 100,
    match: (lines: string[]): PermissionRequest | undefined => {
      let endIndex = lines.length - 1

      // Skip trailing prompt input indicator if present (e.g. "Select an option [1-3]:" or "> ")
      const lastLine = lines[endIndex].trim()
      if (
        /^(?:Select(?:\s+an\s+option)?|Choice|Enter\s+number|Input|Opt|\>|\:)\s*(?:\[[\d\s,-]+\])?\s*[:?]?\s*$/i.test(
          lastLine
        )
      ) {
        endIndex--
      }

      if (endIndex < 1) return undefined

      // Collect numbered options backwards
      const options: { num: string; text: string }[] = []
      let i = endIndex
      while (i >= 0) {
        const line = lines[i]
        const m = line.match(NUMBERED_OPTION_RE)
        if (!m) break
        options.unshift({ num: m[1], text: m[2].trim() })
        i--
      }

      if (options.length < 2) return undefined

      // The line right before the first option is the question / header
      const questionIndex = i
      if (questionIndex < 0) return undefined

      const whatLine = lines[questionIndex].trim()
      // If the header looks like an action plan instead of a permission prompt, skip
      if (
        /^(?:steps?|plan|tasks?|summary|overview|instructions?|here\s+are\s+the\s+steps)\b/i.test(
          whatLine
        )
      ) {
        return undefined
      }

      // Check if options look like actionable choices
      const isChoiceList = options.every(opt => {
        const t = opt.text.toLowerCase()
        return (
          t.length <= 40 &&
          /^(?:yes|no|allow|deny|approve|reject|cancel|skip|proceed|always|once|sì|nega|rifiuta|annulla|salta|always allow|allow always)/i.test(
            t
          )
        )
      })

      if (!isChoiceList && !whatLine.includes("?")) {
        return undefined
      }

      const contextLines = lines.slice(Math.max(0, questionIndex - 4), questionIndex)
      const { kind, target } = extractKindAndTarget(whatLine, contextLines)

      const answers: PermissionAnswer[] = options.map((opt, idx) => {
        const label = mapChoiceLabelToItalian(opt.text)
        const t = opt.text.toLowerCase()
        const isNegative = /^(?:no|deny|reject|cancel|abort|nega|rifiuta|annulla)$/i.test(t)
        const tone: "primary" | "secondary" = idx === 0 && !isNegative ? "primary" : "secondary"
        return {
          label,
          send: opt.num,
          tone,
        }
      })

      return {
        what: whatLine,
        kind,
        target,
        answers,
      }
    },
  },

  // 2. Yes/No bracket prompt (e.g. [y/N], [Y/n], (y/n), [y/n/a])
  {
    id: "yn-prompt",
    name: "Yes/No Bracket Prompt",
    priority: 80,
    match: (lines: string[]): PermissionRequest | undefined => {
      let promptLineIndex = lines.length - 1
      let line = lines[promptLineIndex].trim()

      // Handle case where cursor prompt (">" or ":") is on the next line
      if ((line === ">" || line === ":" || line === "?") && lines.length > 1) {
        promptLineIndex--
        line = lines[promptLineIndex].trim()
      }

      const match = line.match(YN_PATTERN_RE)
      if (!match) return undefined

      const format = match[1].replace(/\s+/g, "")
      const contextLines = lines.slice(Math.max(0, promptLineIndex - 4), promptLineIndex)
      const { kind, target } = extractKindAndTarget(line, contextLines)

      const isNoDefault = format.includes("N") && !format.includes("Y")
      const hasAlways = /[aA]/.test(format)

      const answers: PermissionAnswer[] = [
        {
          label: "Sì",
          send: "y",
          tone: isNoDefault ? "secondary" : "primary",
        },
        {
          label: "No",
          send: "n",
          tone: isNoDefault ? "primary" : "secondary",
        },
      ]

      if (hasAlways) {
        answers.push({
          label: "Sempre",
          send: "a",
          tone: "secondary",
        })
      }

      return {
        what: line,
        kind,
        target,
        answers,
      }
    },
  },

  // 3. Simple question ending with ? and waiting prompt
  {
    id: "simple-question",
    name: "Question with Pending Prompt",
    priority: 60,
    match: (lines: string[]): PermissionRequest | undefined => {
      let questionIndex = lines.length - 1
      let lastLine = lines[questionIndex].trim()

      // Check if prompt cursor is at the end
      if ((lastLine === ">" || lastLine === ":" || lastLine === "?") && lines.length > 1) {
        questionIndex--
        lastLine = lines[questionIndex].trim()
      }

      if (!lastLine.endsWith("?")) return undefined

      const contextLines = lines.slice(Math.max(0, questionIndex - 4), questionIndex)
      const { kind, target } = extractKindAndTarget(lastLine, contextLines)

      // Must have detectable confirmation intent or command/file/network target
      const isPermissionIntent =
        /\b(?:allow|permit|execute|run|proceed|continue|apply|perform|confirm|authorize|conferma|consenti|esegui)\b/i.test(
          lastLine
        ) ||
        kind !== "unknown" ||
        contextLines.some(l => /^\s*\$/.test(l))

      if (!isPermissionIntent) return undefined

      return {
        what: lastLine,
        kind,
        target,
        answers: [
          {
            label: "Consenti",
            send: "y",
            tone: "primary",
          },
          {
            label: "Nega",
            send: "n",
            tone: "secondary",
          },
        ],
      }
    },
  },
]

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Guarda le ultime righe di output e dice se l'agente sta aspettando.
 * Nessuna euristica inventata: ogni schema riconosciuto deve corrispondere a
 * un formato che un agente reale emette davvero.
 */
export function detectPermission(lines: string[], agentId: string): PermissionRequest | undefined {
  if (!lines || lines.length === 0) return undefined

  // 1. Strip ANSI escape codes
  const cleanLines = lines.map(stripAnsi)

  // 2. Remove trailing blank lines to find the active prompt end
  let lastNonEmpty = cleanLines.length - 1
  while (lastNonEmpty >= 0 && cleanLines[lastNonEmpty].trim() === "") {
    lastNonEmpty--
  }
  if (lastNonEmpty < 0) return undefined

  const activeLines = cleanLines.slice(0, lastNonEmpty + 1)

  // 3. Reject known false-positive output patterns
  if (isFalsePositive(activeLines)) {
    return undefined
  }

  // 4. Sort schemas prioritizing those specifically defined for this agentId
  const sortedSchemas = [...PERMISSION_SCHEMAS].sort((a, b) => {
    const aAgent = a.agentId === agentId ? 1 : 0
    const bAgent = b.agentId === agentId ? 1 : 0
    if (aAgent !== bAgent) return bAgent - aAgent
    return (b.priority ?? 0) - (a.priority ?? 0)
  })

  // 5. Apply pattern schemas
  for (const schema of sortedSchemas) {
    const result = schema.match(activeLines)
    if (result) {
      return result
    }
  }

  return undefined
}

/**
 * Quando una richiesta smette di essere valida perché l'agente è andato avanti.
 *
 * The question is answered when it is no longer on screen — which is a
 * different test from "something new arrived", and the difference is the whole
 * point. Claude Code, codex and gemini all draw their menus with Ink or
 * ratatui, which means they repaint the entire frame several times a second
 * while they wait: option lines, hints, a spinner. Every one of those repaints
 * is new output. Treating new output as an answer meant the first repaint after
 * a question was detected cleared the request and set the pane back to "In
 * esecuzione", while the agent sat there still waiting for a keystroke.
 *
 * So the last lines are read again the way they were read the first time. If
 * the same question is still there, nothing has been answered.
 *
 * `recentLines` is the same trailing window `detectPermission` was given, not
 * just the one line that arrived: a frame is many lines, and one of them says
 * nothing about whether the prompt is gone.
 */
export function isResolved(
  request: PermissionRequest,
  recentLines: string[],
  agentId: string,
): boolean {
  if (!recentLines || recentLines.length === 0) return false

  // Strip ANSI and filter empty lines
  const stripped = recentLines.map(stripAnsi).map(l => l.trim()).filter(l => l.length > 0)
  if (stripped.length === 0) return false

  const reqWhatTrimmed = stripAnsi(request.what).trim()

  // Still being asked, by the same reading that found it: not resolved.
  const stillAsking = detectPermission(recentLines, agentId)
  if (stillAsking && stripAnsi(stillAsking.what).trim() === reqWhatTrimmed) {
    return false
  }

  // If the new lines only echo the prompt or question itself, it is not resolved
  const isOnlyPromptEcho = stripped.every(
    line => line === reqWhatTrimmed || line === ">" || line === ":" || line === "?"
  )
  if (isOnlyPromptEcho) {
    return false
  }

  return true
}
