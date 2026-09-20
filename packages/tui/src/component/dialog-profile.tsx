import { createMemo, createResource, createSignal } from "solid-js"
import type { NikcliClient, ProfileInfo } from "@nikcli-ai/sdk/httpapi"

/** The reply-length setting, as the contract spells it. */
type ProfileVerbosity = NonNullable<NonNullable<ProfileInfo["communication"]>["verbosity"]>
import { useProject } from "@tui/context/project"
import { useSDK } from "@tui/context/sdk"
import { UserApi } from "@tui/util/user-api"
import { useTheme } from "@tui/context/theme"
import { useDialog } from "@tui/ui/dialog"
import { useToast } from "@tui/ui/toast"
import { DialogAlert } from "@tui/ui/dialog-alert"
import { DialogConfirm } from "@tui/ui/dialog-confirm"
import { DialogPrompt } from "@tui/ui/dialog-prompt"
import { DialogSelect, type DialogSelectOption } from "@tui/ui/dialog-select"

/**
 * `/profile` — the interactive editor for the personalization block every agent
 * receives (see `src/profile/profile.ts`).
 *
 * The profile itself lives on the server — it is per-account state it already owns — so this
 * dialog reads and writes it over `/profile`. The prompt-block preview comes from
 * `/profile/preview` rather than being re-rendered here: it shows what the server actually
 * injects, and a second renderer would be one more thing to keep in step.
 *
 * The account e-mail is still read in-process; that dialog has not moved yet.
 */

type ProfileInput = Partial<Omit<ProfileInfo, "version" | "key" | "updatedAt">>

function loadProfile(client: NikcliClient) {
  return client.profile
    .get()
    .then((result) => result.data ?? undefined)
    .catch(() => undefined)
}

function patchProfile(client: NikcliClient, input: ProfileInput) {
  return client.profile.patch(input as Parameters<NikcliClient["profile"]["patch"]>[0]).then((result) => result.data)
}

function clearProfile(client: NikcliClient) {
  return client.profile.clear().then((result) => result.data?.deleted ?? false)
}

function loadHabits(client: NikcliClient, worktree: string) {
  if (!worktree) return Promise.resolve("")
  return client.profile
    .habits({ worktree })
    .then((result) => result.data?.content ?? "")
    .catch(() => "")
}

function clearHabits(client: NikcliClient, worktree: string) {
  return client.profile.clearHabits({ worktree }).then((result) => result.data?.deleted ?? false)
}

function loadPreview(client: NikcliClient, worktree: string) {
  return client.profile
    .preview({ worktree })
    .then((result) => result.data ?? { lines: [], habitsFile: "" })
    .catch(() => ({ lines: [] as readonly string[], habitsFile: "" }))
}

function activeEmail(sdk: UserApi.Sdk) {
  return UserApi.account(sdk)
    .then((info) => info?.email)
    .catch(() => undefined)
}

/** One-line preview of a field's current value in the field list. */
function preview(value: string | readonly string[] | undefined, empty: string) {
  if (Array.isArray(value)) return value.length ? value.join(", ") : empty
  const text = typeof value === "string" ? value.trim() : ""
  if (!text) return empty
  return text.length > 90 ? `${text.slice(0, 89)}…` : text
}

type TextField = "name" | "role" | "about" | "custom"
type ListField = "stack" | "expertise" | "learning" | "conventions"

const TEXT_FIELDS: Record<TextField, { title: string; placeholder: string; hint: string }> = {
  name: {
    title: "Name",
    placeholder: "How agents should address you",
    hint: "Used when an agent addresses you directly.",
  },
  role: {
    title: "Role",
    placeholder: "e.g. senior backend engineer",
    hint: "Sets how much background an agent assumes you have.",
  },
  about: {
    title: "About you",
    placeholder: "A sentence or two about how you work",
    hint: "The single most useful field — what you build and how you like to work.",
  },
  custom: {
    title: "Extra notes",
    placeholder: "Anything else agents should keep in mind",
    hint: "Appended verbatim to the block agents receive.",
  },
}

const LIST_FIELDS: Record<ListField, { title: string; placeholder: string; hint: string }> = {
  stack: { title: "Stack", placeholder: "e.g. bun", hint: "Languages, frameworks and runtimes you work in." },
  expertise: { title: "Knows well", placeholder: "e.g. distributed systems", hint: "Agents skip the basics here." },
  learning: { title: "Learning", placeholder: "e.g. rust", hint: "Agents explain more in these areas." },
  conventions: {
    title: "Conventions",
    placeholder: "e.g. always bun, never npm",
    hint: "Standing rules agents should follow in every session.",
  },
}

export function DialogProfile() {
  const dialog = useDialog()
  const toast = useToast()
  const { theme } = useTheme()

  const project = useProject()
  const sdk = useSDK()
  // The server resolves the same root the system prompt uses, and reports the file it read, so
  // the path the dialog shows is the path the agents read.
  const worktree = () => project.instance.path().worktree || project.instance.directory()

  const [profile, { refetch }] = createResource(() => loadProfile(sdk.client))
  const [email] = createResource(() => activeEmail(sdk))
  const [habits, { refetch: refetchHabits }] = createResource(worktree, (dir) => loadHabits(sdk.client, dir))
  const [promptBlock, { refetch: refetchPreview }] = createResource(worktree, (dir) => loadPreview(sdk.client, dir))

  const habitLines = () => {
    const count = (habits() ?? "").split("\n").filter((line) => line.trim().startsWith("-")).length
    return count === 1 ? "1 habit" : `${count} habits`
  }

  const reopen = () => dialog.replace(() => <DialogProfile />)

  async function apply(input: ProfileInput, message: string) {
    try {
      await patchProfile(sdk.client, input)
      toast.show({ message, variant: "success" })
      await refetch()
      await refetchPreview()
    } catch (error: any) {
      toast.show({ message: `Could not save: ${error?.message ?? error}`, variant: "error" })
    }
  }

  async function editText(field: TextField) {
    const meta = TEXT_FIELDS[field]
    const current = (profile()?.[field] as string | undefined) ?? ""
    const result = await DialogPrompt.show(dialog, meta.title, {
      placeholder: meta.placeholder,
      value: current,
      // An empty submit is swallowed by the prompt itself, so clearing a field
      // needs a value that means "nothing".
      description: () => (
        <text fg={theme.foreground.muted}>{`${meta.hint}${current ? " Enter - to clear." : ""}`}</text>
      ),
    })
    if (result !== null) {
      await apply({ [field]: result.trim() === "-" ? "" : result } as ProfileInput, `${meta.title} saved`)
    }
    reopen()
  }

  async function showPreview() {
    // Rendered by the server: this is the block it injects, not a second opinion about it.
    const rendered = [...(promptBlock()?.lines ?? [])]
    await DialogAlert.show(
      dialog,
      "What agents receive",
      rendered.length
        ? rendered.join("\n\n")
        : "Nothing yet — fill in at least one field and this block is added to every agent's system prompt.",
    )
    reopen()
  }

  async function showHabits() {
    const content = (habits() ?? "").trim()
    await DialogAlert.show(
      dialog,
      "Learned habits",
      content ||
        "Nothing learned yet. nikcli fills this in during a Brain pass, once it has enough recent sessions in this project to see a pattern.",
    )
    reopen()
  }

  async function forgetHabits() {
    const confirmed = await DialogConfirm.show(
      dialog,
      "Forget learned habits",
      `Delete ${promptBlock()?.habitsFile ?? worktree()}? Everything nikcli learned about how you work in this project is lost.`,
      "cancel",
    )
    if (confirmed) {
      await clearHabits(sdk.client, worktree()).catch(() => false)
      await refetchHabits()
      toast.show({ message: "Learned habits deleted", variant: "success" })
    }
    reopen()
  }

  async function reset() {
    const confirmed = await DialogConfirm.show(
      dialog,
      "Reset profile",
      "Delete your personalization? Agents go back to having no standing context about you.",
      "cancel",
    )
    if (confirmed) {
      await clearProfile(sdk.client).catch(() => false)
      toast.show({ message: "Profile reset", variant: "success" })
    }
    reopen()
  }

  const options = createMemo((): DialogSelectOption<string>[] => {
    const info = profile()
    const result: DialogSelectOption<string>[] = []

    for (const field of ["name", "role", "about"] as TextField[]) {
      result.push({
        title: TEXT_FIELDS[field].title,
        value: field,
        description: preview(info?.[field], "not set"),
        category: "About you",
        onSelect: () => void editText(field),
      })
    }

    for (const field of ["stack", "expertise", "learning"] as ListField[]) {
      result.push({
        title: LIST_FIELDS[field].title,
        value: field,
        description: preview(info?.[field], "not set"),
        category: "About you",
        onSelect: () => dialog.replace(() => <DialogProfileList field={field} />),
      })
    }

    result.push({
      title: "Preferred skills",
      value: "skills",
      description: preview(info?.skills, "none — agents pick skills on their own"),
      category: "Preferences",
      onSelect: () => dialog.replace(() => <DialogProfileSkills />),
    })
    result.push({
      title: "Preferred tools",
      value: "tools.preferred",
      description: preview(info?.tools?.preferred, "none — agents pick tools on their own"),
      category: "Preferences",
      onSelect: () => dialog.replace(() => <DialogProfileTools kind="preferred" />),
    })
    result.push({
      title: "Tools to avoid",
      value: "tools.avoid",
      description: preview(info?.tools?.avoid, "none"),
      category: "Preferences",
      onSelect: () => dialog.replace(() => <DialogProfileTools kind="avoid" />),
    })
    result.push({
      title: LIST_FIELDS.conventions.title,
      value: "conventions",
      description: preview(info?.conventions, "not set"),
      category: "Preferences",
      onSelect: () => dialog.replace(() => <DialogProfileList field="conventions" />),
    })

    result.push({
      title: "Answer length",
      value: "communication.verbosity",
      description: info?.communication?.verbosity ?? "not set — nikcli defaults apply",
      category: "Communication",
      onSelect: () => dialog.replace(() => <DialogProfileVerbosity />),
    })
    result.push({
      title: "Explain reasoning",
      value: "communication.explain",
      description:
        info?.communication?.explain === undefined
          ? "not set"
          : info.communication.explain
            ? "yes — say why behind non-obvious changes"
            : "no — skip explanations unless asked",
      category: "Communication",
      onSelect: () =>
        void apply(
          { communication: { ...info?.communication, explain: !(info?.communication?.explain ?? false) } },
          "Saved",
        ),
    })
    result.push({
      title: "Reply language",
      value: "communication.language",
      description: info?.communication?.language ?? "not set — follows your locale",
      category: "Communication",
      onSelect: async () => {
        const result = await DialogPrompt.show(dialog, "Reply language", {
          placeholder: "e.g. Italian",
          value: info?.communication?.language ?? "",
          description: () => (
            <text fg={theme.foreground.muted}>Prose only — code, identifiers and commands stay as they are.</text>
          ),
        })
        if (result !== null) await apply({ communication: { ...info?.communication, language: result } }, "Saved")
        reopen()
      },
    })
    result.push({
      title: TEXT_FIELDS.custom.title,
      value: "custom",
      description: preview(info?.custom, "not set"),
      category: "Communication",
      onSelect: () => void editText("custom"),
    })

    result.push({
      title: "Show learned habits to agents",
      value: "habits.enabled",
      description:
        info?.habits === false
          ? "off — agents only see what you filled in above"
          : `on — ${habitLines()} learned from past sessions in this project`,
      category: "Learned habits",
      onSelect: () => void apply({ habits: info?.habits === false }, "Saved"),
    })
    result.push({
      title: "Review learned habits",
      value: "habits.review",
      description: `${promptBlock()?.habitsFile ?? worktree()} — edit or delete anything wrong`,
      category: "Learned habits",
      onSelect: () => void showHabits(),
    })
    result.push({
      title: "Forget learned habits",
      value: "habits.forget",
      description: "Delete the file — nikcli starts learning again from here",
      category: "Learned habits",
      onSelect: () => void forgetHabits(),
    })

    result.push({
      title: "Preview what agents receive",
      value: "preview",
      description: "The exact block appended to every agent's system prompt",
      category: "Actions",
      onSelect: () => void showPreview(),
    })
    result.push({
      title: "Reset profile",
      value: "reset",
      description: "Delete all personalization for this account",
      category: "Actions",
      onSelect: () => void reset(),
    })

    return result
  })

  const title = createMemo(() => {
    const who = email()
    return who ? `Your nikcli profile — ${who}` : "Your nikcli profile — not signed in (saved locally)"
  })

  return <DialogSelect title={title()} placeholder="Search settings" options={options()} />
}

/** Add/remove editor for the plain string-list fields. */
function DialogProfileList(props: { field: ListField }) {
  const dialog = useDialog()
  const toast = useToast()
  const { theme } = useTheme()
  const meta = LIST_FIELDS[props.field]
  const sdk = useSDK()

  const [profile, { refetch }] = createResource(() => loadProfile(sdk.client))
  const values = createMemo(() => (profile()?.[props.field] as string[] | undefined) ?? [])

  async function write(next: string[]) {
    try {
      await patchProfile(sdk.client, { [props.field]: next } as ProfileInput)
      await refetch()
    } catch (error: any) {
      toast.show({ message: `Could not save: ${error?.message ?? error}`, variant: "error" })
    }
  }

  const options = createMemo((): DialogSelectOption<string>[] => [
    {
      title: "+ Add",
      value: "__add__",
      description: meta.hint,
      category: "Actions",
      onSelect: async () => {
        const result = await DialogPrompt.show(dialog, `Add to ${meta.title.toLowerCase()}`, {
          placeholder: meta.placeholder,
          description: () => <text fg={theme.foreground.muted}>{meta.hint}</text>,
        })
        if (result) await write([...values(), result.trim()])
        dialog.replace(() => <DialogProfileList field={props.field} />)
      },
    },
    {
      title: "← Back",
      value: "__back__",
      description: "Return to the profile",
      category: "Actions",
      onSelect: () => dialog.replace(() => <DialogProfile />),
    },
    ...values().map((value) => ({
      title: value,
      value,
      description: "select to remove",
      category: meta.title,
      onSelect: () => void write(values().filter((existing) => existing !== value)),
    })),
  ])

  return <DialogSelect title={meta.title} placeholder={meta.placeholder} options={options()} />
}

/**
 * Multi-select over a catalog the server owns. Selecting an entry toggles it and
 * keeps the list open — the profile is saved on "Done", so an accidental
 * mis-toggle costs nothing until then.
 */
function TogglePicker(props: {
  title: string
  hint: string
  catalog: () => { id: string; description?: string }[]
  loading: () => boolean
  initial: () => string[]
  onDone: (values: string[]) => Promise<void>
}) {
  const dialog = useDialog()
  const [selected, setSelected] = createSignal<string[]>(props.initial())
  // `initial` resolves asynchronously; adopt it once, without clobbering edits.
  let adopted = props.initial().length > 0
  const sync = createMemo(() => {
    const incoming = props.initial()
    if (!adopted && incoming.length > 0) {
      adopted = true
      setSelected(incoming)
    }
    return selected()
  })

  const toggle = (id: string) =>
    setSelected((current) => (current.includes(id) ? current.filter((x) => x !== id) : [...current, id]))

  const options = createMemo((): DialogSelectOption<string>[] => {
    const chosen = sync()
    const catalog = props.catalog()
    // Values the catalog no longer knows about (an uninstalled skill, an MCP
    // tool from another project) stay listed so they can still be removed.
    const extra = chosen.filter((id) => !catalog.some((entry) => entry.id === id))
    return [
      {
        title: `✓ Done — save ${chosen.length} selected`,
        value: "__done__",
        description: props.hint,
        category: "Actions",
        onSelect: async () => {
          await props.onDone(chosen)
          dialog.replace(() => <DialogProfile />)
        },
      },
      {
        title: "+ Add by name",
        value: "__manual__",
        description: "For anything not in the list",
        category: "Actions",
        onSelect: async () => {
          const result = await DialogPrompt.show(dialog, props.title, { placeholder: "name" })
          if (result) {
            const value = result.trim()
            await props.onDone(chosen.includes(value) ? chosen : [...chosen, value])
          }
          dialog.replace(() => <DialogProfile />)
        },
      },
      ...(props.loading()
        ? [
            {
              title: "Loading…",
              value: "__loading__",
              category: "Available",
              disabled: true,
            } satisfies DialogSelectOption<string>,
          ]
        : []),
      ...[...extra.map((id) => ({ id, description: "not currently installed" })), ...catalog].map((entry) => ({
        title: `${chosen.includes(entry.id) ? "✓" : " "} ${entry.id}`,
        value: entry.id,
        description: entry.description,
        searchText: entry.id,
        category: "Available",
        onSelect: () => toggle(entry.id),
      })),
    ]
  })

  return <DialogSelect title={props.title} placeholder="Search" options={options()} />
}

function DialogProfileSkills() {
  const sdk = useSDK()
  const toast = useToast()
  const [profile] = createResource(() => loadProfile(sdk.client))
  const [skills] = createResource(async () => {
    const result = await sdk.client.app.skills()
    return result.data ?? []
  })

  return (
    <TogglePicker
      title="Preferred skills"
      hint="Agents are told to reach for these first — they still load a skill only when it fits."
      loading={() => skills.loading}
      catalog={() => (skills() ?? []).map((skill) => ({ id: skill.name, description: skill.description }))}
      initial={() => profile()?.skills ?? []}
      onDone={async (values) => {
        await patchProfile(sdk.client, { skills: values }).catch((error: any) =>
          toast.show({ message: `Could not save: ${error?.message ?? error}`, variant: "error" }),
        )
      }}
    />
  )
}

function DialogProfileTools(props: { kind: "preferred" | "avoid" }) {
  const sdk = useSDK()
  const toast = useToast()
  const [profile] = createResource(() => loadProfile(sdk.client))
  const [tools] = createResource(async () => {
    const result = await sdk.client.tool.ids()
    return result.data ?? []
  })

  return (
    <TogglePicker
      title={props.kind === "preferred" ? "Preferred tools" : "Tools to avoid"}
      hint={
        props.kind === "preferred"
          ? "Agents reach for these first when several tools would work."
          : "Agents use something else unless there is no alternative."
      }
      loading={() => tools.loading}
      catalog={() => (tools() ?? []).map((id) => ({ id }))}
      initial={() => profile()?.tools?.[props.kind] ?? []}
      onDone={async (values) => {
        await patchProfile(sdk.client, { tools: { ...profile()?.tools, [props.kind]: values } }).catch((error: any) =>
          toast.show({ message: `Could not save: ${error?.message ?? error}`, variant: "error" }),
        )
      }}
    />
  )
}

function DialogProfileVerbosity() {
  const dialog = useDialog()
  const sdk = useSDK()
  const toast = useToast()
  const [profile] = createResource(() => loadProfile(sdk.client))

  const options = createMemo((): DialogSelectOption<ProfileVerbosity | "unset">[] => [
    {
      title: "Concise",
      value: "concise",
      description: "Short answers, no preamble",
      category: "Answer length",
    },
    {
      title: "Balanced",
      value: "balanced",
      description: "Moderate detail",
      category: "Answer length",
    },
    {
      title: "Detailed",
      value: "detailed",
      description: "Thorough answers with context",
      category: "Answer length",
    },
    {
      title: "Not set",
      value: "unset",
      description: "Fall back to nikcli defaults",
      category: "Answer length",
    },
  ])

  return (
    <DialogSelect
      title="Answer length"
      options={options()}
      current={profile()?.communication?.verbosity ?? "unset"}
      onSelect={async (option: DialogSelectOption<ProfileVerbosity | "unset">) => {
        await patchProfile(sdk.client, {
          communication: {
            ...profile()?.communication,
            verbosity: option.value === "unset" ? undefined : option.value,
          },
        }).catch((error: any) =>
          toast.show({ message: `Could not save: ${error?.message ?? error}`, variant: "error" }),
        )
        dialog.replace(() => <DialogProfile />)
      }}
    />
  )
}
