import { EOL } from "os"
import { Effect } from "effect"
import { BunRuntime, BunServices } from "@effect/platform-bun"
import { Log } from "@nikcli-ai/util/log"
import { initialize } from "@nikcli-ai/util/global"
import { FormatError } from "@nikcli-ai/util/cli-error"
import { IslandBridge } from "@nikcli-ai/util/island-bridge"
import { Commands } from "./commands"
import { Handlers } from "./handlers"
import { Runtime } from "./framework/runtime"
import { Diagnostics } from "./diagnostics"
import { UI } from "./ui"
import { Installation } from "@/installation"

/**
 * The nikcli entrypoint, on `effect/unstable/cli`.
 *
 * Every handler is a `() => import()`, the default command included — the one
 * structural thing yargs could not do, because it needs the default command's
 * module to build its parser, and that module is the TUI. Importing this
 * entrypoint costs 25K `Function` objects against `cli-main`'s 154K.
 *
 * `commands.ts` and `handlers.generated.ts` are generated from the yargs
 * declarations by `script/generate-cli.ts`, and held to them by
 * `test/cli/effect-cli-parity.test.ts` (declarations) and
 * `test/cli/effect-cli-parse-parity.test.ts` (parsed values).
 *
 * See `specs/cli-framework.md`.
 */

/**
 * What yargs did in a root `.middleware()`: configure the process before any
 * command runs.
 *
 * Read straight from `process.argv` rather than from parsed flags because it has
 * to happen *before* parsing — `Log.init` decides where logs go, and work done
 * during parsing would otherwise log somewhere else. The flags are still
 * declared in `global-flags.ts`; without that, passing one would be a parse
 * error rather than an ignored flag.
 */
async function bootstrap(): Promise<void> {
  const argv = process.argv.slice(2)
  const has = (...names: string[]) => names.some((name) => argv.includes(name))

  await initialize()
  // Armed after `initialize()` because the capture paths write into
  // `Global.Path.log`. See `cli/diagnostics.ts` for the two signals.
  Diagnostics.listen()

  process.env.NIKCLI_ISLAND = has("--island") ? "1" : "0"
  // Passed through the environment because the TUI runs the session in a worker
  // thread, which never sees this argv.
  if (has("--auto", "--yolo", "--dangerously-skip-permissions")) process.env.NIKCLI_AUTO_APPROVE = "1"
  const modeFlag = argv.find((arg) => arg === "--permission-mode" || arg.startsWith("--permission-mode="))
  const mode = modeFlag?.includes("=") ? modeFlag.split("=")[1] : modeFlag && argv[argv.indexOf(modeFlag) + 1]
  if (mode === "auto" || mode === "default") process.env.NIKCLI_PERMISSION_MODE = mode

  // `IslandBridge.start()` is called from inside `Bus.publish` — the one choke
  // point every session/permission/tool event flows through in any realm — so
  // the bridge self-activates without this entrypoint remembering to. Only the
  // cleanup half is wired per entrypoint, and it is safe here specifically
  // because this is the plain (non-worker) case: "this process" and "the OS
  // process" are the same thing.
  process.on("exit", IslandBridge.stop)

  const levelIndex = argv.indexOf("--log-level")
  const level = levelIndex === -1 ? undefined : argv[levelIndex + 1]
  await Log.init({
    print: has("--print-logs"),
    dev: Installation.isLocal(),
    level: (() => {
      if (level) return level as Log.Level
      if (Installation.isLocal()) return "DEBUG"
      return "INFO"
    })(),
  })

  process.env.AGENT = "1"
  process.env.NIKCLI = "1"

  Log.Default.info("nikcli", { version: Installation.VERSION, args: argv })
}

export async function runEffectCli(): Promise<void> {
  process.on("unhandledRejection", (error) => {
    Log.Default.error("rejection", { e: error instanceof Error ? error.message : error })
  })
  process.on("uncaughtException", (error) => {
    Log.Default.error("exception", { e: error instanceof Error ? error.message : error })
  })
  // Exit on terminal hangup (closing the terminal tab). Without this,
  // long-running commands like `serve` block on a never-resolving promise and
  // survive as orphaned processes.
  process.on("SIGHUP", () => process.exit())

  try {
    await bootstrap()
  } catch (error) {
    Log.Default.error("fatal", { error })
    const formatted = FormatError(error)
    if (formatted) UI.error(formatted)
    else UI.error("Unexpected error, check log file at " + Log.file() + " for more details" + EOL)
    process.exitCode = 1
    process.exit()
  }

  // `runMain`, not `runPromise`: it renders a parse error as CLI output and sets
  // the exit code. With `runPromise` a missing required argument surfaces as an
  // unhandled rejection and Bun prints a stack trace at the user.
  BunRuntime.runMain(
    Runtime.run(Commands, Handlers, { version: Installation.VERSION }).pipe(
      Effect.provide(BunServices.layer),
    ) as Effect.Effect<void, unknown, never>,
  )
}
