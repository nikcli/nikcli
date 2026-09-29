import { Cause, Exit, Runtime, Schema } from "effect"
import { CliError } from "effect/unstable/cli"

/**
 * The exit-code contract of the CLI.
 *
 * EOT-18 (`specs/effect-tui/18-cli-command-architecture.md`, requirement 9)
 * documents the mapping and asks that it be typed and applied once, at the
 * dispatcher, rather than decided per command. `main-effect.ts` hands
 * {@link ExitCode.fromExit} to `runMain` as its teardown, so the code a shell
 * sees is the code this module computes from the main fiber's `Exit`.
 *
 * The codes are the `sysexits.h` conventions where one fits and the shell's
 * where it does not: `2` is what `getopt`-style parsers return for bad usage,
 * and `130` is `128 + SIGINT`, which is what a user interrupting a command
 * already sees from the shell.
 *
 * What changed for a handler: nothing it did not ask for. A handler that calls
 * `process.exit(1)` still exits 1, one that sets `process.exitCode` and returns
 * still exits with that, and one that throws something untagged still exits 1
 * with the cause logged by `runMain` as before. Only failures with a documented
 * meaning — a usage error the parser raised, a config file that did not parse,
 * a prompt the user cancelled — get their code.
 */
export namespace ExitCode {
  /** The command did what was asked. */
  export const Success = 0
  /** A failure with no more specific meaning; what every untagged error maps to. */
  export const Failure = 1
  /** Invalid usage: an unknown flag, a missing argument, an unknown subcommand. */
  export const Usage = 2
  /** The configuration could not be read: malformed JSON, a schema violation, a mistyped directory. */
  export const Config = 64
  /** Required input was absent (`EX_NOINPUT`). Reserved by the contract; no failure maps to it yet. */
  export const NoInput = 66
  /** A service the command depends on did not answer (`EX_UNAVAILABLE`). */
  export const Unavailable = 69
  /** The user interrupted the command, or cancelled the prompt it was waiting on. */
  export const Interrupted = 130

  /**
   * A failure a handler raises on purpose: the message the user should read
   * and the code a script should see.
   *
   * It replaces the `UI.error(message); process.exit(1)` pair. The throw
   * unwinds through `bootstrap`'s teardown and the command's finalizers, which
   * `process.exit` skipped; the dispatcher (`framework/runtime.ts`) prints the
   * message once; `fromExit` reads the code off effect's own marker. The
   * `errorReported` marker is false so `runMain` does not also dump the cause
   * — the message is the whole report, exactly as it was before.
   */
  export class CommandError extends Schema.TaggedError<CommandError>()("CliCommandError", {
    message: Schema.String,
    code: Schema.Number,
  }) {
    override readonly [Runtime.errorExitCode] = this.code
    override readonly [Runtime.errorReported] = false
  }

  /** `throw ExitCode.fail("what went wrong")`; the code defaults to 1. */
  export function fail(message: string, code: number = Failure): CommandError {
    return new CommandError({ message, code })
  }

  /**
   * The tagged domain failures with a documented code. Keyed by `_tag` so the
   * table needs no import of the classes and cannot pull a domain module into
   * the entrypoint's import graph.
   */
  const byTag: Record<string, number> = {
    ConfigJsonError: Config,
    ConfigInvalidError: Config,
    ConfigDirectoryTypoError: Config,
    ConfigRemoteFetch: Unavailable,
    UICancelledError: Interrupted,
  }

  /**
   * The code for one failure value.
   *
   * The parser's `ShowHelp` comes first: it is what `Command.runWith` raises
   * for an unknown flag, a missing argument or an unknown subcommand, and
   * effect stamps it with its own flat `1` (or `0` when it carries no errors),
   * which is exactly the number this contract replaces with `2`. Then an error
   * that carries effect's `Runtime.errorExitCode` marker keeps it, so a handler
   * that wants an explicit code uses the runtime's mechanism rather than a
   * second one. Then the rest of the parser's errors: every `CliError` is a
   * usage error except `UserError`, which is a handler's own failure wrapped
   * for display. Then the tagged domain failures above. Everything else is 1.
   */
  export function of(error: unknown): number {
    if (typeof error !== "object" || error === null) return Failure
    if (CliError.isCliError(error) && error._tag === "ShowHelp") return error.errors.length > 0 ? Usage : Success
    if (Runtime.errorExitCode in error) return Runtime.getErrorExitCode(error)
    if (CliError.isCliError(error)) return error._tag === "UserError" ? Failure : Usage
    if ("_tag" in error && typeof error._tag === "string") return byTag[error._tag] ?? Failure
    return Failure
  }

  /**
   * The code for a finished main fiber, in the shape `runMain` expects from a
   * teardown. Success is 0; a cause made only of interruptions is 130, as
   * effect's default teardown already says; anything else is {@link of} over
   * the squashed cause — the first failure if there is one, else the first
   * defect — so a handler that threw a tagged error, which `Effect.promise`
   * records as a defect, is mapped the same as one that failed with it.
   */
  export function fromExit(exit: Exit.Exit<unknown, unknown>): number {
    if (Exit.isSuccess(exit)) return Success
    if (Cause.hasInterruptsOnly(exit.cause)) return Interrupted
    return of(Cause.squash(exit.cause))
  }
}
