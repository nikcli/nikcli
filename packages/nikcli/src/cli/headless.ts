import { select } from "@clack/prompts"
import { Flag } from "@nikcli-ai/util/flag"
import { UI } from "@/cli/ui"

export type PermissionResponse = "once" | "always" | "reject"

/**
 * Headless posture for the non-TUI CLI.
 *
 * `NIKCLI_HEADLESS=1` always wins. Otherwise a non-TTY stdin is headless,
 * except `NIKCLI_TERMINAL=1` which is the managed-PTY signal used by mobile
 * (same exception as the TUI default command).
 */
export function isHeadless(input: { env?: NodeJS.ProcessEnv; stdinIsTTY?: boolean | undefined } = {}): boolean {
  const env = input.env ?? process.env
  const value = env.NIKCLI_HEADLESS?.toLowerCase()
  if (value === "true" || value === "1") return true
  if (env.NIKCLI_TERMINAL === "1") return false
  const stdinIsTTY = input.stdinIsTTY ?? process.stdin.isTTY
  return stdinIsTTY === false
}

/**
 * Permission prompt for `nikcli run` / `nikcli cli`.
 *
 * Fail-closed: headless never picks "yes". `--auto` (via `NIKCLI_AUTO_APPROVE`)
 * is the only way to approve without a TTY.
 */
export async function resolvePermissionPrompt(input: {
  permission: string
  patterns: string[]
  always: string[]
  headless?: boolean
  autoApprove?: boolean
}): Promise<PermissionResponse> {
  if (input.autoApprove ?? Flag.autoApprove()) return "once"
  if (input.headless ?? isHeadless()) {
    UI.error(
      `Permission required: ${input.permission} (${input.patterns.join(", ")}). ` +
        "Headless mode fails closed — pass --auto to approve, or run in a TTY.",
    )
    return "reject"
  }
  const result = await select({
    message: `Permission required: ${input.permission} (${input.patterns.join(", ")})`,
    options: [
      { value: "once", label: "Allow once" },
      {
        value: "always",
        label: "Always allow: " + input.always.join(", "),
      },
      { value: "reject", label: "Reject" },
    ],
    initialValue: "once",
  }).catch(() => "reject")
  return (result.toString().includes("cancel") ? "reject" : result) as PermissionResponse
}

export function isReplExit(line: string): boolean {
  const trimmed = line.trim().toLowerCase()
  return trimmed === "/exit" || trimmed === "/quit" || trimmed === "exit" || trimmed === "quit"
}

export function isReplHelp(line: string): boolean {
  return line.trim().toLowerCase() === "/help"
}
