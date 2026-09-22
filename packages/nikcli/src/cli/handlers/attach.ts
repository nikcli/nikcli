import { Option } from "effect"
import { Runtime } from "../framework/runtime"
import { passthrough } from "../framework/args"
import { Commands } from "../commands"
import { service } from "./service/shared"

export default Runtime.handler(Commands.commands["attach"], async (input) => {
  const args = {
    _: [],
    $0: "nikcli",
    "--": passthrough(),
    url: input["url"],
    dir: Option.getOrUndefined(input["dir"]),
    session: Option.getOrUndefined(input["session"]),
  }
  if (args.dir) process.chdir(args.dir)
  // Lazy: ./app pulls in TuiPluginRuntime, whose OpenTUI runtime Bun plugin
  // must not install during CLI startup (startup-graph rule; it also breaks
  // require() of not-yet-cached CJS deps once installed).
  const { tui } = await import("@nikcli-ai/tui/app")
  const { localPluginHost } = await import("@/cli/cmd/tui/plugin/host-local")
  const { TuiConfig } = await import("@/config/tui")
  const connection = await (await service()).connection(args.url)
  await tui({
    url: args.url,
    fetch: connection.fetch,
    pluginHost: localPluginHost,
    tuiConfig: await TuiConfig.get().catch(() => undefined),
    args: { sessionID: args.session },
    directory: args.dir || connection.service ? process.cwd() : undefined,
  })
})
