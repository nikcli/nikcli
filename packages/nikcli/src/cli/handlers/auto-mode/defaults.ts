import { Option } from "effect"
import { EOL } from "os"
import { Runtime } from "../../framework/runtime"
import { Commands } from "../../commands"
import { AutoMode } from "@/permission/auto"

export default Runtime.handler(Commands.commands["auto-mode"].commands["defaults"], async (input) => {
  const label = Option.getOrUndefined(input.label)
  const rules = label ? AutoMode.filterRules(AutoMode.DEFAULT_RULES, label) : AutoMode.DEFAULT_RULES
  process.stdout.write(JSON.stringify(rules, null, 2) + EOL)
})
