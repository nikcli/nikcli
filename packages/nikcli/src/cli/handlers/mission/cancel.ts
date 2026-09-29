import { Runtime } from "../../framework/runtime"
import { passthrough } from "../../framework/args"
import { Commands } from "../../commands"
import { bootstrap } from "@/cli/bootstrap"
import { ExitCode } from "@/cli/exit-code"
import * as Manager from "@/mission/manager"
import * as Orchestrator from "@/mission/orchestrator"

export default Runtime.handler(Commands.commands["mission"].commands["cancel"], async (input) => {
  const args = {
    _: [],
    $0: "nikcli",
    "--": passthrough(),
    id: input["id"],
  }
  await bootstrap(process.cwd(), async (instance) => {
    const mission = await Manager.get(instance.project.id, String(args.id))
    if (!mission) {
      throw ExitCode.fail(`Mission "${args.id}" not found`)
    }
    await Orchestrator.cancel(mission.id)
    console.log(`Cancelled: ${mission.id} (${mission.name}) — edit & resume with: nikcli mission start ${mission.id}`)
  })
})
