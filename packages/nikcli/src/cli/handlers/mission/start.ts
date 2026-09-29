import { Option } from "effect"
import { Runtime } from "../../framework/runtime"
import { passthrough } from "../../framework/args"
import { Commands } from "../../commands"
import { bootstrap } from "@/cli/bootstrap"
import { ExitCode } from "@/cli/exit-code"
import * as Manager from "@/mission/manager"
import * as Orchestrator from "@/mission/orchestrator"
import { tailUntilDone } from "./shared"

export default Runtime.handler(Commands.commands["mission"].commands["start"], async (input) => {
  const args = {
    _: [],
    $0: "nikcli",
    "--": passthrough(),
    id: input["id"],
    tail: Option.getOrUndefined(input["tail"]),
  }
  await bootstrap(process.cwd(), async (instance) => {
    const mission = await Manager.get(instance.project.id, String(args.id))
    if (!mission) {
      throw ExitCode.fail(`Mission "${args.id}" not found`)
    }
    console.log(`Starting mission ${mission.id} (${mission.name})…`)
    void Orchestrator.start(mission.id)
    if (args.tail) await tailUntilDone(mission.id)
    else console.log(`Tail it with: nikcli mission get ${mission.id} (or rerun with --tail)`)
  })
})
