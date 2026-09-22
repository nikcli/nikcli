import { Runtime } from "../../framework/runtime"
import { Commands } from "../../commands"
import * as prompts from "@clack/prompts"
import { Artifact } from "@/artifact"
import { UI } from "@/cli/ui"

export default Runtime.handler(Commands.commands["artifact"].commands["logout"], async (_input) => {
  UI.empty()
  prompts.intro("nikcli-ai.dev account")
  await Artifact.logout()
  prompts.log.info(
    "Artifacts have no separate login. Sign out from the CLI/TUI account screen to end the shared session.",
  )
  prompts.outro("Done")
})
