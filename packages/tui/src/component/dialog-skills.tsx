import { useDialog } from "@tui/ui/dialog"
import { DialogSelect, type DialogSelectOption } from "@tui/ui/dialog-select"
import { DialogPrompt } from "@tui/ui/dialog-prompt"
import { DialogConfirm } from "@tui/ui/dialog-confirm"
import { createMemo, createResource, createSignal, Match, onMount, Switch } from "solid-js"
import { useSDK } from "@tui/context/sdk"
import { useRoute } from "@tui/context/route"
import { skillCommandName } from "@nikcli-ai/util/skill-command"
import { Global } from "@nikcli-ai/util/global"
import { useToast } from "@tui/ui/toast"
import { Keybind } from "@tui/util/keybind"

function detectSource(location: string) {
  const normalized = location.replaceAll("\\", "/")
  const config = Global.Path.config.replaceAll("\\", "/")
  const home = Global.Path.home.replaceAll("\\", "/")

  if (normalized.includes("/.nikcli/skill/") || normalized.includes("/.nikcli/skills/")) {
    return { label: "Workspace", rank: 0 }
  }

  if (normalized.startsWith(`${config}/skills/`)) {
    return { label: "Global", rank: 1 }
  }

  if (normalized.startsWith(`${home}/.claude/`) || normalized.startsWith(`${home}/.agents/`)) {
    return { label: "External", rank: 2 }
  }

  if (normalized.includes("/.claude/") || normalized.includes("/.agents/")) {
    return { label: "Workspace", rank: 0 }
  }

  return { label: "Other", rank: 3 }
}

function shortenLocation(location: string) {
  const normalized = location.replaceAll("\\", "/")
  const home = Global.Path.home.replaceAll("\\", "/")
  return normalized.startsWith(`${home}/`) ? `~/${normalized.slice(home.length + 1)}` : normalized
}

function isDeletable(location: string): boolean {
  const normalized = location.replaceAll("\\", "/")
  const home = Global.Path.home.replaceAll("\\", "/")
  const config = Global.Path.config.replaceAll("\\", "/")
  if (normalized.startsWith(`${home}/.claude/`) || normalized.startsWith(`${home}/.agents/`)) return false
  if (normalized.startsWith(`${config}/skills/`)) return true
  if (normalized.includes("/.nikcli/skill/") || normalized.includes("/.nikcli/skills/")) return true
  return false
}

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*[a-zA-Z]|\x1b\][0-9;]*\x07/g, "")
}

interface SkillshResult {
  source: string
  name: string
  repo: string
  installs: string
  url: string
}

function parseSkillshOutput(raw: string): SkillshResult[] {
  const clean = stripAnsi(raw)
  const lines = clean.split("\n")
  const results: SkillshResult[] = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i].trim()
    const match = line.match(/^(\S+\/\S+)@(\S+)\s+(\d+(?:\.\d+)?[KkMm]?\s+installs?)/)
    if (match) {
      const repo = match[1]
      const name = match[2]
      const source = `${repo}@${name}`
      const installs = match[3].trim()
      let url = ""
      if (i + 1 < lines.length) {
        const urlLine = lines[i + 1].trim()
        const urlMatch = urlLine.match(/https?:\/\/skills\.sh\/\S+/)
        if (urlMatch) {
          url = urlMatch[0]
          i++
        }
      }
      results.push({ source, name, repo, installs, url })
    }
    i++
  }

  return results
}

function DialogSkillCreate() {
  const dialog = useDialog()
  const sdk = useSDK()
  const [busy, setBusy] = createSignal(false)
  const [step, setStep] = createSignal<"name" | "description" | "scope">("name")
  const [name, setName] = createSignal("")
  const [description, setDescription] = createSignal("")
  const toast = useToast()

  async function submit(value: string) {
    if (step() === "name") {
      const trimmed = value.trim()
      setName(trimmed)
      setStep("description")
      return
    }

    if (step() === "description") {
      const trimmed = value.trim()
      setDescription(trimmed)
      setStep("scope")
      return
    }

    if (step() === "scope") {
      const scope = value.trim().toLowerCase() === "global" ? ("global" as const) : ("workspace" as const)
      setBusy(true)
      try {
        await sdk.client.app.skill.create({
          name: name(),
          description: description(),
          scope,
        })
        toast.show({ message: `Skill "${name()}" created`, variant: "success" })
        dialog.replace(() => <DialogSkills />)
      } catch (err: any) {
        setBusy(false)
        setStep("name")
        toast.show({ message: `Failed: ${err.message}`, variant: "error" })
      }
    }
  }

  return (
    <Switch>
      <Match when={step() === "name"}>
        <DialogPrompt
          title="Create Skill - Name"
          placeholder="e.g. my-skill"
          value={name()}
          busy={busy()}
          busyText="Creating skill..."
          onConfirm={submit}
        />
      </Match>
      <Match when={step() === "description"}>
        <DialogPrompt
          title={`Create Skill - Description (${name()})`}
          placeholder="Short description of what this skill does"
          value={description()}
          busy={busy()}
          busyText="Creating skill..."
          onConfirm={submit}
        />
      </Match>
      <Match when={step() === "scope"}>
        <DialogPrompt
          title={`Create Skill - Scope (${name()})`}
          placeholder="workspace or global (default: workspace)"
          value="workspace"
          busy={busy()}
          busyText="Creating skill..."
          onConfirm={submit}
        />
      </Match>
    </Switch>
  )
}

function DialogSkillshResults(props: { results: SkillshResult[]; refetch: () => void }) {
  const dialog = useDialog()
  const toast = useToast()

  onMount(() => {
    dialog.setSize("xlarge")
  })

  const options = props.results.map((r) => ({
    title: r.name,
    description: `${r.repo} - ${r.installs}`,
    value: r.source,
    footer: r.url || undefined,
    category: r.repo,
  }))

  async function install(source: string) {
    const confirmed = await DialogConfirm.show(dialog, "Install Skill", `Install "${source}" from skills.sh?`)
    if (!confirmed) {
      dialog.replace(() => <DialogSkillshResults results={props.results} refetch={props.refetch} />)
      return
    }

    toast.show({ message: `Installing ${source}...`, variant: "info" })

    try {
      const proc = Bun.spawn({
        windowsHide: true,
        cmd: ["bun", "x", "skills", "add", source, "-g", "-y"],
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      })
      proc.stdin.end()

      const stderr = await new Response(proc.stderr).text()
      await proc.exited

      if (proc.exitCode !== 0) {
        toast.show({ message: `Install failed: ${stderr.trim().slice(0, 100)}`, variant: "error" })
        dialog.replace(() => <DialogSkillshResults results={props.results} refetch={props.refetch} />)
        return
      }

      toast.show({ message: `Installed "${source}"`, variant: "success" })
      props.refetch()
      dialog.replace(() => <DialogSkills />)
    } catch (err: any) {
      toast.show({ message: `Install failed: ${err.message}`, variant: "error" })
      dialog.replace(() => <DialogSkillshResults results={props.results} refetch={props.refetch} />)
    }
  }

  return (
    <DialogSelect
      title={`Search results (${props.results.length})`}
      placeholder="Select a skill to install"
      options={options}
      onSelect={(option) => {
        install(option.value)
      }}
    />
  )
}

export function DialogSkills() {
  const dialog = useDialog()
  const sdk = useSDK()
  const route = useRoute()
  const toast = useToast()
  const [filter, setFilter] = createSignal("")

  onMount(() => {
    dialog.setSize("xlarge")
  })

  const [skills, { refetch }] = createResource(async () => {
    const result = await sdk.client.app.skills()
    return result.data ?? []
  })

  const options = createMemo(() => {
    const query = filter().trim().toLowerCase()

    return (skills() ?? [])
      .map((skill) => {
        const source = detectSource(skill.location)
        const location = shortenLocation(skill.location)
        const deletable = isDeletable(skill.location)
        const metadata = [
          skill.category,
          skill.tags?.slice(0, 3).join(", "),
          skill.version ? `v${skill.version}` : undefined,
        ]
          .filter(Boolean)
          .join(" - ")
        const command = skillCommandName(skill.name)
        const search = [
          skill.name,
          skill.description,
          skill.category,
          ...(skill.tags ?? []),
          skill.version,
          source.label,
          command,
          skill.location,
          location,
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase()

        return {
          title: skill.name,
          description: metadata ? `${skill.description} - ${metadata}` : skill.description,
          value: command,
          footer: location,
          category: source.label,
          rank: source.rank,
          search,
          deletable,
          skillName: skill.name,
        }
      })
      .filter((skill) => !query || skill.search.includes(query))
      .sort((a, b) => a.rank - b.rank || a.title.localeCompare(b.title))
      .map(({ rank: _rank, search: _search, ...option }) => option)
  })

  const selected = createMemo(() => {
    const flat = options()
    return flat[0] as (typeof flat)[number] | undefined
  })

  async function handleDelete(option: DialogSelectOption & { deletable?: boolean; skillName?: string }) {
    if (!option.deletable || !option.skillName) {
      toast.show({ message: "Cannot delete this skill (external source)", variant: "warning" })
      return
    }
    const confirmed = await DialogConfirm.show(
      dialog,
      "Delete Skill",
      `Delete "${option.skillName}"? This cannot be undone.`,
    )
    if (!confirmed) {
      dialog.replace(() => <DialogSkills />)
      return
    }
    try {
      await sdk.client.app.skill.delete({ name: option.skillName })
      toast.show({ message: `Deleted "${option.skillName}"`, variant: "success" })
      refetch()
      dialog.replace(() => <DialogSkills />)
    } catch (err: any) {
      toast.show({ message: `Failed: ${err.message}`, variant: "error" })
      dialog.replace(() => <DialogSkills />)
    }
  }

  function openSkillshSearch() {
    dialog.replace(
      () => (
        <DialogPrompt
          title="Search skills.sh"
          placeholder="e.g. react, design, deploy..."
          onConfirm={async (query) => {
            if (!query.trim()) {
              dialog.replace(() => <DialogSkills />)
              return
            }

            toast.show({ message: `Searching "${query}"...`, variant: "info" })

            try {
              const proc = Bun.spawn({
                windowsHide: true,
                cmd: ["bun", "x", "skills", "find", query.trim()],
                stdin: "pipe",
                stdout: "pipe",
                stderr: "pipe",
              })
              proc.stdin.end()

              const output = await new Response(proc.stdout).text()
              await proc.exited

              const results = parseSkillshOutput(output)

              if (results.length === 0) {
                toast.show({ message: `No skills found for "${query}"`, variant: "info" })
                dialog.replace(() => <DialogSkills />)
                return
              }

              toast.show({ message: `Found ${results.length} skill(s)`, variant: "info" })
              dialog.replace(() => <DialogSkillshResults results={results} refetch={refetch} />)
            } catch (err: any) {
              toast.show({ message: `Search failed: ${err.message}`, variant: "error" })
              dialog.replace(() => <DialogSkills />)
            }
          }}
          onCancel={() => dialog.replace(() => <DialogSkills />)}
        />
      ),
      () => dialog.replace(() => <DialogSkills />),
    )
  }

  return (
    <DialogSelect
      title="Select skill"
      placeholder="Search skills, tags, source, or path"
      options={options()}
      skipFilter={true}
      onFilter={setFilter}
      onSelect={(option) => {
        if (route.data.type === "session") {
          route.navigate({
            type: "session",
            sessionID: route.data.sessionID,
            initialPrompt: { input: `/${option.value} `, parts: [] },
            workspaceID: route.data.workspaceID,
          })
        } else {
          route.navigate({
            type: "home",
            initialPrompt: { input: `/${option.value} `, parts: [] },
            workspaceID: route.data.workspaceID,
          })
        }
        dialog.clear()
      }}
      keybind={[
        {
          keybind: Keybind.parse("ctrl+n")[0],
          title: "New",
          onTrigger: () => {
            dialog.replace(() => <DialogSkillCreate />)
          },
        },
        {
          keybind: Keybind.parse("shift+i")[0],
          title: "Install",
          onTrigger: () => {
            openSkillshSearch()
          },
        },
        {
          keybind: Keybind.parse("ctrl+d")[0],
          title: "Delete",
          disabled: !selected()?.deletable,
          onTrigger: (option) => {
            handleDelete(option as any)
          },
        },
      ]}
    />
  )
}
