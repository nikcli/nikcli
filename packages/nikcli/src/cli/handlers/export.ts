import { Option } from "effect"
import { Runtime } from "../framework/runtime"
import { passthrough } from "../framework/args"
import { Commands } from "../commands"
import { Session } from "@/session"
import { bootstrap } from "@/cli/bootstrap"
import { UI } from "@/cli/ui"
import { ExitCode } from "@/cli/exit-code"
import * as prompts from "@clack/prompts"
import { EOL } from "os"
import { Effect } from "effect"
import { runPromiseWithLayer, withCurrentInstance } from "@/effect"
import type { MessageV2 } from "@/session/message-v2"

export function runSession<A, E>(effect: Effect.Effect<A, E, Session.Service>) {
  return runPromiseWithLayer(Session.defaultLayer, withCurrentInstance(effect))
}

export default Runtime.handler(Commands.commands["export"], async (input) => {
  const args = {
    _: [],
    $0: "nikcli",
    "--": passthrough(),
    sessionID: Option.getOrUndefined(input["sessionID"]),
  }
  await bootstrap(process.cwd(), async () => {
    let sessionID = args.sessionID
    process.stderr.write(`Exporting session: ${sessionID ?? "latest"}`)

    if (!sessionID) {
      UI.empty()
      prompts.intro("Export session", {
        output: process.stderr,
      })

      const sessions = await runSession(
        Effect.gen(function* () {
          const session = yield* Session.Service
          const iterable = yield* session.list()
          return yield* Effect.promise(() => Array.fromAsync(iterable))
        }),
      )

      if (sessions.length === 0) {
        prompts.log.error("No sessions found", {
          output: process.stderr,
        })
        prompts.outro("Done", {
          output: process.stderr,
        })
        return
      }

      sessions.sort((a: Session.Info, b: Session.Info) => b.time.updated - a.time.updated)

      const selectedSession = await prompts.autocomplete({
        message: "Select session to export",
        maxItems: 10,
        options: sessions.map((session: Session.Info) => ({
          label: session.title,
          value: session.id,
          hint: `${new Date(session.time.updated).toLocaleString()} • ${session.id.slice(-8)}`,
        })),
        output: process.stderr,
      })

      if (prompts.isCancel(selectedSession)) {
        throw new UI.CancelledError()
      }

      // SAFETY: the `isCancel` guard above throws, and every option's
      // `value` is `session.id`, so only a session id reaches here.
      sessionID = selectedSession as string

      prompts.outro("Exporting session...", {
        output: process.stderr,
      })
    }

    try {
      const { sessionInfo, messages } = await runSession(
        Effect.gen(function* () {
          const session = yield* Session.Service
          const sessionInfo = yield* session.get(sessionID!)
          const messages = yield* session.messages({ sessionID: sessionID! })
          return { sessionInfo, messages }
        }),
      )

      const exportData = {
        info: sessionInfo,
        messages: messages.map((msg: MessageV2.WithParts) => ({
          info: msg.info,
          parts: msg.parts,
        })),
      }

      process.stdout.write(JSON.stringify(exportData, null, 2))
      process.stdout.write(EOL)
    } catch {
      throw ExitCode.fail(`Session not found: ${sessionID!}`)
    }
  })
})
