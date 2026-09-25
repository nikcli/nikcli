import path from "path"
import * as prompts from "@clack/prompts"
import { parse as parseJsonc } from "jsonc-parser"
import { Runtime } from "../../framework/runtime"
import { Commands } from "../../commands"
import { Global } from "@nikcli-ai/util/global"
import { UI } from "@/cli/ui"

/**
 * Remove `auto_mode` from the global config. Only the global file is touched:
 * it is the only place the classifier reads its rules from.
 */
export default Runtime.handler(Commands.commands["auto-mode"].commands["reset"], async (input) => {
  const filepath = path.join(Global.Path.config, "nikcli.json")
  const text = await Bun.file(filepath)
    .text()
    .catch(() => "")
  const config = (text.trim() ? parseJsonc(text, [], { allowTrailingComma: true }) : {}) as Record<string, unknown>
  const current = config["auto_mode"] as Record<string, unknown> | undefined
  if (!current || Object.keys(current).length === 0) {
    UI.println("No auto mode settings to reset: the built-in rules are already in effect.")
    return
  }

  const summary = Object.entries(current).map(([key, value]) =>
    Array.isArray(value)
      ? `  ${key}: ${value.length} entr${value.length === 1 ? "y" : "ies"}`
      : `  ${key}: ${JSON.stringify(value)}`,
  )
  UI.println(`This removes auto_mode from ${filepath}:\n${summary.join("\n")}`)

  if (!input.yes) {
    const confirmed = await prompts.confirm({
      message: "Reset auto mode configuration to defaults?",
      initialValue: false,
    })
    if (prompts.isCancel(confirmed) || !confirmed) {
      UI.println("Cancelled.")
      return
    }
  }

  delete config["auto_mode"]
  await Bun.write(filepath, JSON.stringify(config, null, 2))
  UI.println("Auto mode configuration reset to the built-in rules.")
})
