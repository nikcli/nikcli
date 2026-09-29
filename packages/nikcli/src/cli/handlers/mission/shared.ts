import path from "path"
import fs from "fs/promises"
import { ExitCode } from "@/cli/exit-code"
import { Log } from "@nikcli-ai/util/log"
import * as Orchestrator from "@/mission/orchestrator"
import { definitionFromGeneratedText, type MissionDefinition } from "@/mission/schema"

/** Helpers shared by the `mission` commands. */

/**
 * Missions — headless CLI command.
 *
 * Mirrors `cmd/goal.ts` + `cmd/routine.ts`:
 *   - `nikcli mission` opens the headless mission manager (list + create)
 *   - `nikcli mission new` creates a mission from a brief (-f file, --model, --agent)
 *   - `nikcli mission start <id>` orchestrates a mission
 *   - `nikcli mission pause/resume/cancel <id>` operate on the orchestrator
 *   - `nikcli mission get <id>` shows progress
 *
 * The actual work happens in `src/mission/orchestrator.ts`; this command is a
 * thin headless wrapper that boots the instance, drives a plan, then prints
 * the result.
 */

export const log = Log.create({ service: "mission-cmd" })

export function formatDate(ts: number) {
  return new Date(ts).toLocaleString()
}

export function formatStatus(def: MissionDefinition, rt: Orchestrator.Runtime): string {
  if (rt.status === "running") {
    const f = rt.currentFeatureID ? ` · feature ${rt.currentFeatureID}` : ""
    return `running${f} (${rt.doneFeatures}/${rt.totalFeatures})`
  }
  if (rt.status === "cancelling") return "cancelling"
  if (rt.status === "paused") return "paused"
  if (rt.status === "error") return `error${rt.lastError ? `: ${truncate(rt.lastError, 32)}` : ""}`
  return def.status
}

export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}

export async function readBrief(file: string | undefined, inline: string | undefined): Promise<string> {
  if (file) {
    const resolved = path.resolve(process.cwd(), file)
    return fs.readFile(resolved, "utf8")
  }
  if (inline && inline.trim()) return inline
  // Fallback to stdin if piped.
  if (!process.stdin.isTTY) {
    const text = await Bun.stdin.text()
    if (text.trim()) return text
  }
  throw ExitCode.fail(
    'Mission requires a brief. Pass --brief "..." or --file <path>, or pipe via stdin.',
    ExitCode.NoInput,
  )
}

export async function tailUntilDone(missionID: string, timeoutMs = 10 * 60_000): Promise<void> {
  const start = Date.now()
  let lastStatus: string | undefined
  for (;;) {
    const rt = Orchestrator.getRuntime(missionID)
    const status = `${rt.status} ${rt.doneFeatures}/${rt.totalFeatures}`
    if (status !== lastStatus) {
      process.stdout.write(`  ${status}\n`)
      lastStatus = status
    }
    if (rt.status === "idle" || rt.status === "error" || rt.status === "paused") return
    if (Date.now() - start > timeoutMs) {
      process.stdout.write(`  (still running after ${Math.round(timeoutMs / 1000)}s; tailing stopped)\n`)
      return
    }
    await new Promise((r) => setTimeout(r, 1000))
  }
}

// Touch the import so eslint/tsc don't flag the schema re-export as unused.
void definitionFromGeneratedText
void log
