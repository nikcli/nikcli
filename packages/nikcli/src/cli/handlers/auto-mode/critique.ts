import { EOL } from "os"
import { Effect } from "effect"
import { generateText } from "ai"
import { Runtime } from "../../framework/runtime"
import { Commands } from "../../commands"
import { bootstrap } from "@/cli/bootstrap"
import { UI } from "@/cli/ui"
import { runPromiseWithLayer, withCurrentInstance } from "@/effect"
import { Provider } from "@/provider/provider"
import { AutoMode } from "@/permission/auto"
import { SessionAutoMode } from "@/session/auto-mode"

const INSTRUCTION = `You review custom rules for nikcli's auto mode safety classifier. The classifier reads these rules as natural-language policy when it decides whether an autonomous coding agent may run an action.

Precedence: hard_deny blocks unconditionally; soft_deny blocks unless an allow exception or the user's explicit, specific intent clears it; allow rules are exceptions to soft_deny; environment entries define what is trusted.

For each custom rule, flag it if it is ambiguous, redundant with a built-in rule, contradicts another rule, is so broad it will cause false positives, or so broad an allow that it clears dangerous actions. Suggest a clearer wording where useful. Be concise. If a rule is fine, say so in one line.`

export default Runtime.handler(Commands.commands["auto-mode"].commands["critique"], async () => {
  await bootstrap(process.cwd(), async () => {
    const global = await SessionAutoMode.globalConfig()
    const configured = global.auto_mode ?? {}
    const custom = Object.fromEntries(
      (["environment", "allow", "soft_deny", "hard_deny"] as const)
        .map((key) => [key, (configured[key] ?? []).filter((entry) => entry !== AutoMode.DEFAULTS_TOKEN)] as const)
        .filter(([, entries]) => entries.length > 0),
    )
    if (Object.keys(custom).length === 0) {
      UI.println("You have no custom auto mode rules. Add them under auto_mode in your global nikcli.json.")
      return
    }

    const language = await runPromiseWithLayer(
      Provider.defaultLayer,
      withCurrentInstance(
        Effect.gen(function* () {
          const provider = yield* Provider.Service
          const configuredModel = global.auto_mode?.model ? Provider.parseModel(global.auto_mode.model) : undefined
          const ref = configuredModel ?? (yield* provider.defaultModel())
          const model = yield* provider.getModel(ref.providerID, ref.modelID)
          return yield* provider.getLanguage(model)
        }),
      ),
    )

    const result = await generateText({
      model: language,
      temperature: 0,
      system: INSTRUCTION,
      prompt: [
        "<built_in_rules>",
        JSON.stringify(AutoMode.DEFAULT_RULES, null, 2),
        "</built_in_rules>",
        "",
        "<custom_rules>",
        JSON.stringify(custom, null, 2),
        "</custom_rules>",
      ].join("\n"),
    })
    process.stdout.write(result.text.trim() + EOL)
  })
})
