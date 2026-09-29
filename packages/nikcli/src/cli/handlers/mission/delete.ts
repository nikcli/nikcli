import { Option } from "effect"
import { Runtime } from "../../framework/runtime"
import { passthrough } from "../../framework/args"
import { Commands } from "../../commands"
import { bootstrap } from "@/cli/bootstrap"
import { ExitCode } from "@/cli/exit-code"
import * as Manager from "@/mission/manager"

export default Runtime.handler(Commands.commands["mission"].commands["delete"], async (input) => {
  const args = {
    _: [],
    $0: "nikcli",
    "--": passthrough(),
    id: input["id"],
    yes: Option.getOrUndefined(input["yes"]),
  }
  await bootstrap(process.cwd(), async (instance) => {
    if (!args.yes) {
      throw ExitCode.fail("Refusing to delete without --yes (mission deletion is destructive).", ExitCode.Usage)
    }
    const removed = await Manager.remove(instance.project.id, instance.directory, String(args.id))
    console.log(removed ? `Deleted mission ${args.id}` : `Mission ${args.id} not found`)
  })
})
