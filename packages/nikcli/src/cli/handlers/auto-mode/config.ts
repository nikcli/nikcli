import { EOL } from "os"
import { Runtime } from "../../framework/runtime"
import { Commands } from "../../commands"
import { bootstrap } from "@/cli/bootstrap"
import { SessionAutoMode } from "@/session/auto-mode"

export default Runtime.handler(Commands.commands["auto-mode"].commands["config"], async () => {
  await bootstrap(process.cwd(), async () => {
    process.stdout.write(JSON.stringify(await SessionAutoMode.rules(), null, 2) + EOL)
  })
})
