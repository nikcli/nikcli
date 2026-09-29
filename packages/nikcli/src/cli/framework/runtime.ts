import { Effect } from "effect"
import { Command } from "effect/unstable/cli"
import { GlobalFlags, normalizeArgv } from "../global-flags"
import { ExitCode } from "../exit-code"
import { UI } from "../ui"
import type { Spec } from "./spec"

/**
 * Binds handlers to a {@link Spec} tree, loading each one only when it runs.
 *
 * The handler map mirrors the shape of the command tree — a leaf is a loader, a
 * group is an object of loaders with an optional `$` for the group itself — so
 * a command without a handler is a type error rather than a command that
 * silently does nothing.
 *
 * Ported from opencode v2's `packages/cli/src/framework/runtime.ts`. nikcli's
 * handlers are plain async functions rather than Effects, so the runtime awaits
 * them instead of yielding; everything else is the same mechanism.
 */
export type Input<Value> =
  Value extends Spec.Node<infer _Name, infer Command, infer _Commands>
    ? Input<Command>
    : Value extends Command.Command<infer _Name, infer Input, infer _Context, infer _Error, infer _Requirements>
      ? Input
      : never

type RuntimeHandler = (input: any) => Promise<void> | void

type Loader<Node extends Spec.Any> = () => Promise<{
  default: (input: Input<Node>) => Promise<void> | void
}>

export type Handlers<Node extends Spec.Any> = keyof Node["commands"] extends never
  ? Loader<Node>
  : { readonly $?: Loader<Node> } & { readonly [Key in keyof Node["commands"]]: Handlers<Node["commands"][Key]> }

interface LazyHandler {
  readonly spec: Command.Command.Any
  readonly load: () => Promise<{ default: RuntimeHandler }>
}

type RuntimeHandlers =
  | (() => Promise<{ default: RuntimeHandler }>)
  | {
      readonly $?: () => Promise<{ default: RuntimeHandler }>
      readonly [key: string]: RuntimeHandlers | (() => Promise<{ default: RuntimeHandler }>) | undefined
    }

/**
 * Identity at runtime; it exists so a handler file can name the node it
 * implements and have its `input` typed from that node's parameters.
 */
export function handler<const Node extends Spec.Any>(_node: Node, run: (input: Input<Node>) => Promise<void> | void) {
  return run
}

export function handlers<const Root extends Spec.Any>(root: Root, handlers: Handlers<Root>): LazyHandler[] {
  const result: LazyHandler[] = []

  function add(node: Spec.Any, value: RuntimeHandlers | undefined) {
    if (value === undefined) return
    if (typeof value === "function") {
      const load = value as () => Promise<{ default: RuntimeHandler }>
      result.push({ spec: node.spec, load })
      for (const alias of node.aliases) result.push({ spec: alias.spec, load })
      return
    }
    if (value.$) {
      const load = value.$
      result.push({ spec: node.spec, load })
      for (const alias of node.aliases) result.push({ spec: alias.spec, load })
    }
    for (const [name, child] of Object.entries(node.commands)) add(child, value[name] as RuntimeHandlers)
  }

  add(root, handlers as RuntimeHandlers)
  return result
}

function provide(node: Spec.Any, handlers: ReadonlyArray<LazyHandler>): Command.Command.Any {
  const found = handlers.find((entry) => entry.spec === node.spec)
  const spec = found
    ? node.spec.pipe(
        Command.withHandler((input: unknown) =>
          Effect.promise(async () => {
            const module = await found.load()
            try {
              await module.default(input)
            } catch (error) {
              // A `CommandError` is the handler's own answer: print it once,
              // here, and let it unwind. `runMain` skips the cause dump (its
              // `errorReported` marker is false) and the teardown in
              // `main-effect.ts` reads the exit code off the error. Anything
              // else keeps today's path: a defect, logged by `runMain`, exit 1.
              if (error instanceof ExitCode.CommandError) UI.error(error.message)
              throw error
            }
          }),
        ),
      )
    : node.spec
  const children = Object.values(node.commands)
  if (children.length === 0) return spec as Command.Command.Any
  return spec.pipe(
    Command.withSubcommands([
      ...children.map((child) => provide(child, handlers)),
      ...children.flatMap((child) => child.aliases.map((alias) => provide(alias, handlers))),
    ]),
  ) as Command.Command.Any
}

/** The root, with every command bound and the global flags attached. */
function rootCommand(root: Spec.Any, handlers: ReadonlyArray<LazyHandler>) {
  return provide(root, handlers).pipe(Command.withGlobalFlags(GlobalFlags as never))
}

export function run(root: Spec.Any, handlers: ReadonlyArray<LazyHandler>, options: { readonly version: string }) {
  // `runWith` rather than `run` so the argv can be normalised first — see
  // `normalizeArgv` for the two yargs behaviours effect does not reproduce.
  return Command.runWith(
    rootCommand(root, handlers) as never,
    options,
  )(normalizeArgv(process.argv.slice(2), Object.keys(root.commands)))
}

/**
 * Same wiring, but parsing an argv passed in rather than read from stdio.
 *
 * This is what lets a test parse the same argv with both CLIs and compare the
 * results — the declaration-level parity harness cannot see a difference in how
 * a value is *parsed*, only in how it is declared.
 */
export function runWith(
  root: Spec.Any,
  handlers: ReadonlyArray<LazyHandler>,
  options: { readonly version: string; readonly renderErrors?: boolean },
) {
  return Command.runWith(rootCommand(root, handlers) as never, options)
}

export * as Runtime from "./runtime"
