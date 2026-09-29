import { describe, expect, it } from "bun:test"
import { Exit, Runtime } from "effect"
import { CliError } from "effect/unstable/cli"
import { ExitCode } from "@/cli/exit-code"
import { Config } from "@/config/config"
import { UI } from "@/cli/ui"

/**
 * The exit-code contract (EOT-18, requirement 9), as `runMain`'s teardown sees
 * it: a finished main fiber's `Exit` in, the code the shell gets out.
 *
 * Each row below is a code a script can branch on, so each is pinned by the
 * failure that produces it rather than by the constant alone. The defect rows
 * matter as much as the failure rows: nikcli's handlers are plain async
 * functions run under `Effect.promise`, so a handler that throws a tagged
 * error reaches the teardown as a `Die`, not a `Fail`.
 */
describe("ExitCode.fromExit", () => {
  it("is 0 for success and 130 for an interruption", () => {
    expect(ExitCode.fromExit(Exit.succeed(undefined))).toBe(ExitCode.Success)
    expect(ExitCode.fromExit(Exit.interrupt())).toBe(ExitCode.Interrupted)
  })

  it("maps the parser's usage errors to 2, and its UserError to 1", () => {
    const missing = new CliError.MissingArgument({ argument: "url" })
    expect(ExitCode.fromExit(Exit.fail(missing))).toBe(ExitCode.Usage)
    expect(ExitCode.fromExit(Exit.fail(new CliError.ShowHelp({ commandPath: ["nikcli"], errors: [missing] })))).toBe(
      ExitCode.Usage,
    )
    expect(
      ExitCode.fromExit(Exit.fail(new CliError.UnknownSubcommand({ subcommand: "servee", suggestions: ["serve"] }))),
    ).toBe(ExitCode.Usage)
    // A handler's own failure, wrapped by the framework for display, is not a
    // usage error: the user typed the command correctly and it failed.
    expect(ExitCode.fromExit(Exit.fail(new CliError.UserError({ cause: new Error("nope") })))).toBe(ExitCode.Failure)
  })

  it("maps a configuration failure to 64, whether it failed or was thrown", () => {
    expect(ExitCode.fromExit(Exit.fail(new Config.JsonError({ path: "/p/nikcli.json" })))).toBe(ExitCode.Config)
    expect(ExitCode.fromExit(Exit.die(new Config.InvalidError({ path: "/p/nikcli.json" })))).toBe(ExitCode.Config)
    expect(
      ExitCode.fromExit(
        Exit.fail(new Config.ConfigDirectoryTypoError({ path: "/p", dir: ".nikcl", suggestion: ".nikcli" })),
      ),
    ).toBe(ExitCode.Config)
  })

  it("maps a remote config that did not answer to 69", () => {
    expect(ExitCode.fromExit(Exit.fail(new Config.RemoteFetchError({ url: "https://x", status: 503 })))).toBe(
      ExitCode.Unavailable,
    )
  })

  it("maps a cancelled prompt to 130, like an interruption", () => {
    expect(ExitCode.fromExit(Exit.fail(new UI.CancelledError()))).toBe(ExitCode.Interrupted)
    expect(ExitCode.fromExit(Exit.die(new UI.CancelledError()))).toBe(ExitCode.Interrupted)
  })

  it("honours effect's own exit-code marker over the tag table", () => {
    const marked = Object.assign(new Config.JsonError({ path: "/p" }), { [Runtime.errorExitCode]: 7 })
    expect(ExitCode.fromExit(Exit.fail(marked))).toBe(7)
  })

  it("leaves everything else at 1", () => {
    expect(ExitCode.fromExit(Exit.fail(new Error("plain")))).toBe(ExitCode.Failure)
    expect(ExitCode.fromExit(Exit.die("a string defect"))).toBe(ExitCode.Failure)
    expect(ExitCode.fromExit(Exit.fail({ _tag: "SomethingElse" }))).toBe(ExitCode.Failure)
    expect(ExitCode.fromExit(Exit.fail(null))).toBe(ExitCode.Failure)
  })

  it("keeps the contract's table", () => {
    // The numbers are the contract; a script that branches on them must not
    // find them moved. `NoInput` has no producer yet and is listed so the
    // reservation is visible.
    expect([
      ExitCode.Success,
      ExitCode.Failure,
      ExitCode.Usage,
      ExitCode.Config,
      ExitCode.NoInput,
      ExitCode.Unavailable,
      ExitCode.Interrupted,
    ]).toEqual([0, 1, 2, 64, 66, 69, 130])
  })
})
