import { MessageV2 } from "@/session/message-v2"
import { parseGitHubRemote } from "@/util/repository"

/** Helpers shared by the `github` commands. */

export const GITHUB_APP_NAME = process.env.NIKCLI_GITHUB_APP_NAME || "nikcli"
export const API_BASE_URL = process.env.NIKCLI_API_URL || "https://api.nikcli-ai.dev"
export const WORKFLOW_FILE = ".github/workflows/nikcli.yml"

export { parseGitHubRemote }

export function extractResponseText(parts: MessageV2.Part[]): string | null {
  const textPart = parts.findLast((p) => p.type === "text")
  if (textPart) return textPart.text

  const reasoningPart = parts.findLast((p) => p.type === "reasoning")
  if (reasoningPart) return null

  const toolParts = parts.filter((p) => p.type === "tool" && p.state.status === "completed")
  if (toolParts.length > 0) return null

  const partTypes = parts.map((p) => p.type).join(", ") || "none"
  throw new Error(`Failed to parse response. Part types found: [${partTypes}]`)
}
