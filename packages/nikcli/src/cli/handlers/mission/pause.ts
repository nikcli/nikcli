import { Runtime } from "../../framework/runtime"
import { passthrough } from "../../framework/args"
import { Commands } from "../../commands"
import { bootstrap } from "@/cli/bootstrap"
import { ExitCode } from "@/cli/exit-code"
import * as Manager from "@/mission/manager"
import * as Orchestrator from "@/mission/orchestrator"

export default Runtime.handler(Commands.commands["mission"].commands["pause"], async (input) => {
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
    await Orchestrator.pause(mission.id)
    console.log(`Paused: ${mission.id} (${mission.name})`)
  })
})
