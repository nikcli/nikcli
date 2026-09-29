import { Runtime } from "../../framework/runtime"
import { passthrough } from "../../framework/args"
import { Commands } from "../../commands"
import { bootstrap } from "@/cli/bootstrap"
import { ExitCode } from "@/cli/exit-code"
import * as Manager from "@/mission/manager"
import * as Orchestrator from "@/mission/orchestrator"
import { progressOf } from "@/mission/schema"
import { formatDate, formatStatus, truncate } from "./shared"

export default Runtime.handler(Commands.commands["mission"].commands["get"], async (input) => {
  const args = {
    _: [],
    $0: "nikcli",
    "--": passthrough(),
    id: input["id"],
    format: input["format"],
  }
  await bootstrap(process.cwd(), async (instance) => {
    const mission = await Manager.get(instance.project.id, String(args.id))
    if (!mission) {
      throw ExitCode.fail(`Mission "${args.id}" not found`)
    }
    if (args.format === "json") {
      console.log(JSON.stringify({ ...mission, runtime: Orchestrator.getRuntime(mission.id) }, null, 2))
      return
    }
    const rt = Orchestrator.getRuntime(mission.id)
    const prog = progressOf(mission)
    console.log(`ID:        ${mission.id}`)
    console.log(`Name:      ${mission.name}`)
    console.log(`Status:    ${formatStatus(mission, rt)}`)
    console.log(`Created:   ${formatDate(mission.createdAt)}`)
    console.log(`Brief:     ${mission.brief}`)
    console.log(
      `Progress:  ${prog.doneFeatures}/${prog.totalFeatures} features · ${prog.doneMilestones}/${prog.totalMilestones} milestones`,
    )
    if (rt.currentMilestoneID)
      console.log(`Current:   milestone=${rt.currentMilestoneID} feature=${rt.currentFeatureID ?? "—"}`)
    if (mission.models && Object.keys(mission.models).length > 0) {
      console.log(`Models:    ${JSON.stringify(mission.models)}`)
    }
    console.log("")
    mission.milestones.forEach((m, _mi) => {
      const tick =
        m.status === "done"
          ? "✓"
          : m.status === "running"
            ? "▶"
            : m.status === "validating"
              ? "◐"
              : m.status === "blocked"
                ? "✗"
                : "·"
      console.log(`${tick} ${m.name} [${m.status}] (validation: ${m.validation})`)
      for (const f of m.features) {
        const ftick =
          f.status === "done"
            ? "✓"
            : f.status === "running"
              ? "▶"
              : f.status === "skipped"
                ? "–"
                : f.status === "error" || f.status === "blocked"
                  ? "✗"
                  : "·"
        const dep = f.dependsOn.length > 0 ? ` (after: ${f.dependsOn.join(", ")})` : ""
        const err = f.error ? ` — ${truncate(f.error, 40)}` : ""
        console.log(`    ${ftick} ${f.id} ${f.name} [${f.status}] agent=${f.agent}${dep}${err}`)
      }
    })
  })
})
