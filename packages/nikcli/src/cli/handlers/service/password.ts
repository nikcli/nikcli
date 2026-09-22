import { Option } from "effect"
import { Runtime } from "../../framework/runtime"
import { Commands } from "../../commands"
import { UI } from "@/cli/ui"
import { service } from "./shared"

export default Runtime.handler(Commands.commands["service"].commands["password"], async (input) => {
  const value = Option.getOrUndefined(input["value"])
  const BackgroundService = await service()
  if (value === undefined) {
    UI.println(await BackgroundService.password())
    return
  }
  // Write first, stop second — the reverse of opencode's order, on purpose. A
  // client starting between a stop and the write would spawn a service on the
  // old password while every client reads the new one, and nothing would
  // correct that until the next restart. This way the next start can only
  // read the new file.
  const next = await BackgroundService.password(value)
  await BackgroundService.stop()
  UI.println(next)
})
