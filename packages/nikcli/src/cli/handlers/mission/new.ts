import { Option } from "effect"
import { Runtime } from "../../framework/runtime"
import { passthrough } from "../../framework/args"
import { Commands } from "../../commands"
import { bootstrap } from "@/cli/bootstrap"
import { UI } from "@/cli/ui"
import { ExitCode } from "@/cli/exit-code"
import * as Manager from "@/mission/manager"
import * as Orchestrator from "@/mission/orchestrator"
import { definitionFromGenerated, type MissionDefinition } from "@/mission/schema"
import { truncate, readBrief, tailUntilDone } from "./shared"

export default Runtime.handler(Commands.commands["mission"].commands["new"], async (input) => {
  const args = {
    _: [],
    $0: "nikcli",
    "--": passthrough(),
    name: Option.getOrUndefined(input["name"]),
    brief: Option.getOrUndefined(input["brief"]),
    file: Option.getOrUndefined(input["file"]),
    "from-description": Option.getOrUndefined(input["from-description"]),
    fromDescription: Option.getOrUndefined(input["from-description"]),
    model: Option.getOrUndefined(input["model"]),
    agent: Option.getOrUndefined(input["agent"]),
    "worker-model": Option.getOrUndefined(input["worker-model"]),
    workerModel: Option.getOrUndefined(input["worker-model"]),
    start: Option.getOrUndefined(input["start"]),
  }
  await bootstrap(process.cwd(), async (instance) => {
    let draft: MissionDefinition
    if (args.fromDescription) {
      UI.println(UI.Style.TEXT_INFO_BOLD + "▶" + UI.Style.TEXT_DIM, "Generating mission plan from description…")
      const { generateFromDescription } = await import("@/mission/generate")
      draft = await generateFromDescription(String(args.fromDescription), {
        ...(args.model ? { model: String(args.model) } : undefined),
        ...(args.agent ? { agent: String(args.agent) } : undefined),
      })
      // If the user passed a brief file too, prefer the user's brief.
      if (args.file || args.brief) {
        const userBrief = await readBrief(args.file, args.brief)
        draft = { ...draft, brief: userBrief.trim() }
      }
    } else {
      const brief = await readBrief(args.file, args.brief)
      if (!args.name) {
        throw ExitCode.fail(
          "Mission --name is required when creating from a brief (use --from-description for an LLM-authored name).",
          ExitCode.Usage,
        )
      }
      // A single-feature, single-milestone stub keeps the file-based path
      // usable without forcing the user through plan mode for trivial cases.
      draft = definitionFromGenerated({
        name: String(args.name),
        brief: brief.trim(),
        milestones: [
          {
            name: "Main",
            features: [
              {
                name: "Execute brief",
                agent: args.agent ?? "ralph",
                objective: brief.trim(),
              },
            ],
          },
        ],
      })
    }
    if (args.name) draft = { ...draft, name: String(args.name) }
    if (args.workerModel) {
      const models = {
        ...draft.models,
        worker: String(args.workerModel),
      }
      draft = { ...draft, models }
    }
    const saved = await Manager.upsert(instance.project.id, draft)
    console.log(`Created mission ${saved.id} (${saved.name})`)
    console.log(`Brief: ${truncate(saved.brief, 80)}`)
    console.log(
      `Milestones: ${saved.milestones.length} (${saved.milestones.reduce((n, m) => n + m.features.length, 0)} features)`,
    )
    if (args.start) {
      console.log("Starting orchestration…")
      void Orchestrator.start(saved.id)
      // Tail the runtime until it leaves the running state, then print a snapshot.
      await tailUntilDone(saved.id)
    } else {
      console.log(`Run it with: nikcli mission start ${saved.id}`)
    }
  })
})
