import { Flag, GlobalFlag } from "effect/unstable/cli"

/**
 * The flags every nikcli command accepts, declared once on the root.
 *
 * yargs carried these as root `.option()`s plus a `.middleware()` that turned
 * them into process state. They have to exist here before the effect CLI can be
 * the entrypoint: an undeclared `--auto` is a parse error, not an ignored flag,
 * so flipping the default without them would break every scripted invocation
 * that passes one.
 *
 * The *effects* of these flags live in `main-effect.ts`'s bootstrap rather than
 * in a handler, because they configure the process — logging, permission
 * defaults, the Island bridge — before any command runs.
 */
export const PrintLogs = GlobalFlag.setting("print-logs")({
  flag: Flag.boolean("print-logs").pipe(Flag.withDescription("print logs to stderr"), Flag.withDefault(false)),
})

export const Island = GlobalFlag.setting("island")({
  flag: Flag.boolean("island").pipe(
    Flag.withDescription("enable the nikcli Island macOS companion app"),
    Flag.withDefault(false),
  ),
})

export const Auto = GlobalFlag.setting("auto")({
  flag: Flag.boolean("auto").pipe(
    Flag.withDescription("approve permission prompts automatically (explicit denials still apply)"),
    Flag.withDefault(false),
  ),
})

/**
 * Two aliases rather than one flag: `--yolo` is what people type, and
 * `--dangerously-skip-permissions` is what a script should say so the intent is
 * obvious in CI logs and shell history.
 */
export const Yolo = GlobalFlag.setting("yolo")({
  flag: Flag.boolean("yolo").pipe(Flag.withDescription("alias for --auto"), Flag.withDefault(false)),
})

export const DangerouslySkipPermissions = GlobalFlag.setting("dangerously-skip-permissions")({
  flag: Flag.boolean("dangerously-skip-permissions").pipe(
    Flag.withDescription("alias for --auto"),
    Flag.withDefault(false),
  ),
})

/**
 * `--log-level` is **not** declared here: effect ships it as a built-in global
 * flag, and declaring a second one is a hard "Duplicate flag name" error at
 * startup. Its choices are lower-case (`debug`), where nikcli has always taken
 * `DEBUG` — so `normalizeLogLevel` below folds the argv value before the parser
 * sees it, and `main-effect.ts`'s bootstrap still reads the original spelling.
 */
/**
 * `--permission-mode auto` starts every session in auto mode: `ask` decisions go
 * to the auto mode classifier instead of a prompt. Not to be confused with
 * `--auto`, which approves every prompt with no review at all.
 */
export const PermissionMode = GlobalFlag.setting("permission-mode")({
  flag: Flag.choice("permission-mode", ["default", "auto"]).pipe(
    Flag.withDescription("permission mode for sessions: default (prompt) or auto (classifier review)"),
    Flag.optional,
  ),
})

export const GlobalFlags = [PrintLogs, Island, Auto, Yolo, DangerouslySkipPermissions, PermissionMode]

/**
 * Fix up an argv before the parser sees it.
 *
 * Two adjustments, both because yargs special-cased things effect does not:
 *
 * - `--log-level DEBUG` → `--log-level debug`, since effect's built-in flag
 *   declares lower-case choices and nikcli has always taken upper-case.
 * - A leading path (`nikcli ~/proj`) becomes `--project ~/proj`. yargs' default
 *   command could own a positional while subcommands still matched; in effect an
 *   optional positional on the root swallows the subcommand name as soon as a
 *   flag follows, so `nikcli heap --detailed` would run the TUI. Rewriting here
 *   keeps the spelling users type without giving the root a positional.
 */
export function normalizeArgv(argv: string[], subcommands: ReadonlyArray<string>): string[] {
  let out = [...argv]

  const level = out.indexOf("--log-level")
  if (level !== -1 && level + 1 < out.length && !out[level + 1]!.startsWith("-")) {
    out[level + 1] = out[level + 1]!.toLowerCase()
  }

  const first = out[0]
  if (first !== undefined && !first.startsWith("-") && !subcommands.includes(first)) {
    out = ["--project", first, ...out.slice(1)]
  }
  return out
}
