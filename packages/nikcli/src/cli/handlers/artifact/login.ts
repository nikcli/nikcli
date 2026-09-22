import { Runtime } from "../../framework/runtime"
import { Commands } from "../../commands"
import * as prompts from "@clack/prompts"
import { Artifact } from "@/artifact"
import { UI } from "@/cli/ui"
import { log } from "./shared"

export default Runtime.handler(Commands.commands["artifact"].commands["login"], async (_input) => {
  UI.empty()
  prompts.intro("nikcli-ai.dev account")

  const spinner = prompts.spinner()
  spinner.start("Checking the active CLI user...")
  try {
    const { user } = await Artifact.login()
    spinner.stop("Account ready")
    prompts.log.success(`Using ${user.display_name || user.username} (${user.email})`)
    prompts.log.info(`Identity server: ${Artifact.authServerUrl()}`)
    prompts.log.info("The web app, Studio, mobile, and artifact publishing use this same CLI account.")
    prompts.outro("Done")
  } catch (error) {
    spinner.stop("No active CLI user", 1)
    log.error("artifact login failed", { error })
    prompts.log.warn(error instanceof Error ? error.message : "Unknown error")
    prompts.log.info(
      "Publishing still works without a login — artifacts are then reachable only via their ?key= capability link.",
    )
    prompts.outro("Done")
  }
})
