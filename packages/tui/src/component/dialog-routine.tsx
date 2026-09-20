import { createResource, createSignal, Match, Show, Switch } from "solid-js"
import { TextAttributes } from "@opentui/core"
import type { MobileRoutine, RoutineTrigger, RoutineTriggerApi, RoutineTriggerSchedule } from "@nikcli-ai/sdk/httpapi"
import { useDialog } from "@tui/ui/dialog"
import { DialogPrompt } from "@tui/ui/dialog-prompt"
import { DialogSelect, type DialogSelectOption } from "@tui/ui/dialog-select"
import { useSDK } from "@tui/context/sdk"
import { useSync } from "@tui/context/sync"
import { DialogModel } from "@tui/component/dialog-model"
import { useTheme } from "@tui/context/theme"
import { useToast } from "@tui/ui/toast"
import { useLocal } from "@tui/context/local"
import { Keybind } from "@tui/util/keybind"
import { Locale } from "@nikcli-ai/util/locale"
import { bunUtils } from "@nikcli-ai/util/bun-utils"
import { randomBytes } from "crypto"

type WizardStep = "starter" | "name" | "prompt" | "model" | "schedule" | "api" | "review"
type ScheduleChoice = "" | "@hourly" | "0 */6 * * *" | "@daily" | "@weekly" | "__custom__"
type ApiChoice = "none" | "generate" | "custom"
type RoutineModelChoice = { providerID: string; modelID: string } | undefined

/** Built-in routine starters, mirroring loop/mission templates. */
type RoutineTemplate = {
  id: string
  title: string
  description: string
  name: string
  prompt: string
  cron?: string
}

const ROUTINE_TEMPLATES: RoutineTemplate[] = [
  {
    id: "daily-review",
    title: "Daily code review",
    description: "Summarize the day's changes and flag risks",
    name: "Daily code review",
    prompt:
      "Review the changes committed to this repository in the last 24 hours. Summarize what changed and call out any bugs, regressions, or risky edits that need attention.",
    cron: "@daily",
  },
  {
    id: "dependency-audit",
    title: "Weekly dependency audit",
    description: "Check for outdated or vulnerable dependencies",
    name: "Dependency audit",
    prompt:
      "Audit the project's dependencies for outdated versions and known security advisories. Report findings and propose safe upgrade steps.",
    cron: "@weekly",
  },
  {
    id: "triage",
    title: "Issue triage",
    description: "API-triggered triage of an incoming report",
    name: "Issue triage",
    prompt:
      "Triage the incoming issue or alert provided in the run context. Reproduce if possible, identify the likely root cause, and suggest next steps.",
  },
  {
    id: "release-notes",
    title: "Release notes draft",
    description: "Draft release notes from recent commits",
    name: "Release notes",
    prompt:
      "Draft user-facing release notes summarizing the notable changes since the last release tag, grouped by feature, fix, and breaking change.",
  },
]
type RoutineAction =
  | "details"
  | "run"
  | "run-context"
  | "edit-name"
  | "edit-prompt"
  | "edit-model"
  | "edit-schedule"
  | "enable-api"
  | "rotate-api"
  | "disable-api"
  | "pause"
  | "delete"
  | "back"

const SUPPORTED_CRON_HELP = "Supported: 5-field cron, @hourly/@daily/@weekly/@monthly/@yearly, or */N minutes."

const SCHEDULE_OPTIONS: DialogSelectOption<ScheduleChoice>[] = [
  { title: "Manual only", value: "", description: "No automatic schedule" },
  { title: "Hourly", value: "@hourly", description: "Runs every hour" },
  { title: "Every 6 hours", value: "0 */6 * * *", description: "Runs four times per day" },
  { title: "Daily", value: "@daily", description: "Runs once per day" },
  { title: "Weekly", value: "@weekly", description: "Runs once per week" },
  { title: "Custom cron", value: "__custom__", description: SUPPORTED_CRON_HELP },
]

const API_OPTIONS: DialogSelectOption<ApiChoice>[] = [
  { title: "No API trigger", value: "none", description: "Manual or schedule only" },
  { title: "Generate token", value: "generate", description: "Create a secure token" },
  { title: "Custom token", value: "custom", description: "Use a token you provide" },
]

function generateApiToken() {
  return `nkr_${randomBytes(32).toString("hex")}`
}

function errorMessage(error: unknown) {
  if (error instanceof Error) return error.message
  if (typeof error === "string") return error
  return "Unexpected error"
}

function assertData<T>(result: { data?: T; error?: unknown }, fallback: string): T {
  if (result.error) throw new Error(errorMessage(result.error))
  if (!result.data) throw new Error(fallback)
  return result.data
}

function isSchedule(trigger: RoutineTrigger): trigger is RoutineTriggerSchedule {
  return trigger.type === "schedule"
}

function isApi(trigger: RoutineTrigger): trigger is RoutineTriggerApi {
  return trigger.type === "api"
}

function scheduleTrigger(routine: MobileRoutine) {
  return routine.triggers.find(isSchedule)
}

function apiTrigger(routine: MobileRoutine) {
  return routine.triggers.find(isApi)
}

function isValidCron(cron: string) {
  const trimmed = cron.trim()
  if (!trimmed) return false
  const expr = /^\*\/\d+$/.test(trimmed) ? `${trimmed} * * * *` : trimmed
  try {
    return bunUtils.cron.parse(expr) != null
  } catch {
    return false
  }
}

function cronDescription(cron: string) {
  if (cron === "@hourly") return "Every hour"
  if (cron === "@daily") return "Every day"
  if (cron === "@weekly") return "Every week"
  if (cron === "0 */6 * * *") return "Every 6 hours"
  return "Custom schedule"
}

function formatDate(ts?: number) {
  if (!ts) return "never"
  return new Date(ts).toLocaleString()
}

function formatRelativeTime(ts?: number) {
  if (!ts) return "never"
  const seconds = Math.max(1, Math.round((Date.now() - ts) / 1000))
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.round(hours / 24)}d ago`
}

function formatTriggers(routine: MobileRoutine) {
  const schedule = scheduleTrigger(routine)
  const api = apiTrigger(routine)
  const parts: string[] = []
  if (schedule?.enabled) parts.push(`schedule ${schedule.cron}`)
  if (api?.enabled) parts.push("api")
  if (!parts.length) return "manual"
  return parts.join(" + ")
}

function updateSchedule(triggers: RoutineTrigger[], cron: string): RoutineTrigger[] {
  const rest = triggers.filter((trigger) => !isSchedule(trigger))
  if (!cron) return rest
  return [...rest, { type: "schedule", cron, enabled: true }]
}

function updateApi(triggers: RoutineTrigger[], token: string | null): RoutineTrigger[] {
  const rest = triggers.filter((trigger) => !isApi(trigger))
  if (!token) return [...rest, { type: "api", token: generateApiToken(), enabled: false }]
  return [...rest, { type: "api", token, enabled: true }]
}

function apiCurl(token: string) {
  return `curl -X POST /mobile/routines/trigger/${token} -H "Authorization: Bearer ${token}" -H "Content-Type: application/json" -d '{"text":"optional run context"}'`
}

function DialogRoutineCreate(props: { onDone: () => void }) {
  const dialog = useDialog()
  const toast = useToast()
  const sdk = useSDK()
  const sync = useSync()
  const local = useLocal()
  const { theme } = useTheme()

  const [step, setStep] = createSignal<WizardStep>("starter")
  const [name, setName] = createSignal("")
  const [prompt, setPrompt] = createSignal("")
  const [model, setModel] = createSignal<RoutineModelChoice>(undefined)
  const [scheduleCron, setScheduleCron] = createSignal("")
  const [apiToken, setApiToken] = createSignal("")
  const [busy, setBusy] = createSignal(false)

  function cancelOrBack(previous: WizardStep) {
    return () => setStep(previous)
  }

  function handleName(value: string) {
    const trimmed = value.trim()
    if (!trimmed) {
      toast.show({ message: "Name is required", variant: "error" })
      return
    }
    setName(trimmed)
    setStep("prompt")
  }

  function handlePrompt(value: string) {
    const trimmed = value.trim()
    if (!trimmed) {
      toast.show({ message: "Prompt is required", variant: "error" })
      return
    }
    setPrompt(trimmed)
    setStep("model")
  }

  function applyTemplate(template: RoutineTemplate) {
    setName(template.name)
    setPrompt(template.prompt)
    setScheduleCron(template.cron ?? "")
    setStep("name")
  }

  const STARTER_OPTIONS: DialogSelectOption<string>[] = [
    { title: "Blank routine", value: "__blank__", description: "Start from scratch", category: "Start" },
    ...ROUTINE_TEMPLATES.map((t) => ({
      title: t.title,
      value: t.id,
      description: t.description,
      category: "Templates",
    })),
  ]

  function handleStarter(value: string) {
    if (value === "__blank__") {
      setStep("name")
      return
    }
    const template = ROUTINE_TEMPLATES.find((t) => t.id === value)
    if (template) applyTemplate(template)
    else setStep("name")
  }

  /** Model picker options sourced from the synced providers (mirrors loops). */
  const modelOptions = (): DialogSelectOption<string>[] => {
    const current = local.model.current()
    const options: DialogSelectOption<string>[] = [
      {
        title: "Use default model",
        value: "__default__",
        description: current ? `Currently ${current.providerID}/${current.modelID}` : "Inherit the session default",
        category: "Action",
      },
    ]
    for (const provider of sync.data.provider) {
      for (const [modelID, info] of Object.entries(provider.models)) {
        if (info.status === "deprecated") continue
        const chosen = model()
        const isCurrent = chosen?.providerID === provider.id && chosen?.modelID === modelID
        options.push({
          title: info.name ?? modelID,
          value: `${provider.id}/${modelID}`,
          description: isCurrent ? "(selected)" : undefined,
          category: provider.name,
        })
      }
    }
    return options
  }

  function handleModel(value: string) {
    if (value === "__default__") {
      setModel(undefined)
    } else {
      const slash = value.indexOf("/")
      setModel({ providerID: value.slice(0, slash), modelID: value.slice(slash + 1) })
    }
    setStep("schedule")
  }

  function setSchedule(value: string) {
    setScheduleCron(value)
    setStep("api")
  }

  function handleSchedule(value: ScheduleChoice) {
    if (value === "__custom__") {
      dialog.replace(() => (
        <DialogPrompt
          title="Custom schedule"
          description={() => <text style={{ fg: theme.foreground.muted }}>{SUPPORTED_CRON_HELP}</text>}
          placeholder="*/30 or 0 */2 * * *"
          value={scheduleCron()}
          onConfirm={(cron) => {
            const trimmed = cron.trim()
            if (!trimmed) {
              setSchedule("")
              return
            }
            if (!isValidCron(trimmed)) {
              toast.show({ message: SUPPORTED_CRON_HELP, variant: "error" })
              return
            }
            setSchedule(trimmed)
          }}
          onCancel={() => setStep("schedule")}
        />
      ))
      return
    }
    setSchedule(value)
  }

  function handleApi(value: ApiChoice) {
    if (value === "none") {
      setApiToken("")
      setStep("review")
      return
    }
    if (value === "generate") {
      setApiToken(generateApiToken())
      setStep("review")
      return
    }
    dialog.replace(() => (
      <DialogPrompt
        title="API token"
        description={() => (
          <text style={{ fg: theme.foreground.muted }}>Keep this token secret. It can trigger the routine.</text>
        )}
        placeholder="nkr_..."
        value={apiToken()}
        onConfirm={(token) => {
          const trimmed = token.trim()
          if (!trimmed) {
            toast.show({ message: "Token is required", variant: "error" })
            return
          }
          setApiToken(trimmed)
          setStep("review")
        }}
        onCancel={() => setStep("api")}
      />
    ))
  }

  function triggers(): RoutineTrigger[] {
    const result: RoutineTrigger[] = []
    if (scheduleCron()) result.push({ type: "schedule", cron: scheduleCron(), enabled: true })
    if (apiToken()) result.push({ type: "api", token: apiToken(), enabled: true })
    return result
  }

  async function submit() {
    if (busy()) return
    setBusy(true)
    try {
      const chosen = model()
      const result = await sdk.client.mobile.routine.create({
        name: name(),
        prompt: prompt(),
        triggers: triggers(),
        ...(chosen ? { model: chosen } : {}),
      })
      const routine = assertData<MobileRoutine>(result, "Failed to create routine")
      toast.show({ message: `Routine created: ${routine.name}`, variant: "success" })
      props.onDone()
      dialog.replace(() => <DialogRoutineActions routine={routine} onDone={props.onDone} />)
    } catch (error) {
      toast.show({ message: errorMessage(error), variant: "error" })
      setBusy(false)
    }
  }

  const reviewOptions = (): DialogSelectOption<string>[] => {
    const chosen = model()
    const fallback = local.model.current()
    const modelLabel = chosen
      ? `${chosen.providerID}/${chosen.modelID}`
      : fallback
        ? `default (${fallback.providerID}/${fallback.modelID})`
        : "default"
    return [
      { title: name(), value: "name", description: "Name", category: "Routine" },
      { title: Locale.truncate(prompt(), 70), value: "prompt", description: "Prompt", category: "Routine" },
      {
        title: modelLabel,
        value: "model",
        description: "Model used for this routine",
        category: "Routine",
      },
      {
        title: scheduleCron() ? scheduleCron() : "Manual only",
        value: "schedule",
        description: scheduleCron() ? cronDescription(scheduleCron()) : "No schedule trigger",
        category: "Triggers",
      },
      {
        title: apiToken() ? "API enabled" : "API disabled",
        value: "api",
        description: apiToken() ? "Token will be shown in details" : "No API trigger",
        category: "Triggers",
      },
      { title: "← Back", value: "back", description: "Edit trigger settings", category: "Actions" },
      {
        title: busy() ? "Creating..." : "Create routine",
        value: "create",
        description: "Save routine",
        category: "Actions",
      },
    ]
  }

  return (
    <Switch>
      <Match when={step() === "starter"}>
        <DialogSelect
          title="New routine: start from"
          options={STARTER_OPTIONS}
          onSelect={(option) => handleStarter(option.value)}
        />
      </Match>
      <Match when={step() === "name"}>
        <DialogPrompt
          title="New routine: name"
          placeholder="Daily code review"
          value={name()}
          busy={busy()}
          onConfirm={handleName}
          onCancel={() => setStep("starter")}
        />
      </Match>
      <Match when={step() === "prompt"}>
        <DialogPrompt
          title="New routine: prompt"
          description={() => (
            <text style={{ fg: theme.foreground.muted }}>
              Write self-contained instructions with a clear success condition.
            </text>
          )}
          placeholder="Review recent changes and summarize risks."
          value={prompt()}
          busy={busy()}
          onConfirm={handlePrompt}
          onCancel={cancelOrBack("name")}
        />
      </Match>
      <Match when={step() === "model"}>
        <DialogSelect
          title="New routine: model"
          options={modelOptions()}
          onSelect={(option) => handleModel(option.value)}
          keybind={[
            { title: "skip", keybind: Keybind.parse("escape")[0], onTrigger: () => handleModel("__default__") },
          ]}
        />
      </Match>
      <Match when={step() === "schedule"}>
        <DialogSelect
          title="Schedule trigger"
          options={SCHEDULE_OPTIONS}
          current={(scheduleCron() || "") as ScheduleChoice}
          onSelect={(option) => handleSchedule(option.value)}
          keybind={[{ title: "skip", keybind: Keybind.parse("escape")[0], onTrigger: () => handleSchedule("") }]}
        />
      </Match>
      <Match when={step() === "api"}>
        <DialogSelect
          title="API trigger"
          options={API_OPTIONS}
          current={(apiToken() ? "generate" : "none") as ApiChoice}
          onSelect={(option) => handleApi(option.value)}
          keybind={[{ title: "skip", keybind: Keybind.parse("escape")[0], onTrigger: () => handleApi("none") }]}
        />
      </Match>
      <Match when={step() === "review"}>
        <DialogSelect
          title="Review routine"
          options={reviewOptions()}
          onSelect={(option) => {
            switch (option.value) {
              case "name":
              case "prompt":
              case "model":
              case "schedule":
              case "api":
                setStep(option.value as WizardStep)
                break
              case "back":
                setStep("api")
                break
              case "create":
                void submit()
                break
            }
          }}
        />
      </Match>
    </Switch>
  )
}

function DialogRoutineActions(props: { routine: MobileRoutine; onDone: () => void }) {
  const dialog = useDialog()
  const toast = useToast()
  const sdk = useSDK()
  const { theme } = useTheme()
  const [busy, setBusy] = createSignal(false)

  async function refreshTo(routine: MobileRoutine) {
    props.onDone()
    dialog.replace(() => <DialogRoutineActions routine={routine} onDone={props.onDone} />)
  }

  async function update(input: {
    name?: string
    prompt?: string
    triggers?: RoutineTrigger[]
    paused?: boolean
    model?: { providerID: string; modelID: string }
  }) {
    setBusy(true)
    try {
      const result = await sdk.client.mobile.routine.update({
        id: props.routine.id,
        ...input,
      })
      const routine = assertData<MobileRoutine>(result, "Failed to update routine")
      toast.show({ message: "Routine updated", variant: "success" })
      await refreshTo(routine)
    } catch (error) {
      toast.show({ message: errorMessage(error), variant: "error" })
      setBusy(false)
    }
  }

  async function run(text?: string) {
    setBusy(true)
    try {
      const runContext = text?.trim()
      const result = await sdk.client.mobile.routine.run({
        id: props.routine.id,
        ...(runContext ? { text: runContext } : {}),
      })
      const session = assertData<{ id: string }>(result, "Run failed")
      toast.show({ message: `Session started: ${session.id}`, variant: "success" })
      props.onDone()
      dialog.clear()
    } catch (error) {
      toast.show({ message: errorMessage(error), variant: "error" })
      setBusy(false)
    }
  }

  function runWithContext() {
    dialog.replace(() => (
      <DialogPrompt
        title="Run context"
        description={() => <text style={{ fg: theme.foreground.muted }}>Optional context to pass to this run.</text>}
        placeholder="Alert body, release notes, or extra instructions"
        onConfirm={(value) => void run(value)}
        onCancel={() => void refreshTo(props.routine)}
      />
    ))
  }

  function viewDetails() {
    const schedule = scheduleTrigger(props.routine)
    const api = apiTrigger(props.routine)
    dialog.replace(() => (
      <DialogSelect
        title={`Routine details: ${props.routine.name}`}
        options={[
          { title: props.routine.id, value: "id", description: "ID", category: "Routine" },
          {
            title: props.routine.paused ? "Paused" : "Active",
            value: "status",
            description: "Status",
            category: "Routine",
          },
          { title: props.routine.directory, value: "directory", description: "Directory", category: "Routine" },
          { title: formatDate(props.routine.createdAt), value: "created", description: "Created", category: "Routine" },
          { title: formatDate(props.routine.updatedAt), value: "updated", description: "Updated", category: "Routine" },
          {
            title: props.routine.model ? `${props.routine.model.providerID}/${props.routine.model.modelID}` : "default",
            value: "model",
            description: "Model used",
            category: "Routine",
          },
          { title: formatDate(props.routine.lastRunAt), value: "last-run", description: "Last run", category: "Runs" },
          {
            title: props.routine.lastSessionID ?? "none",
            value: "last-session",
            description: "Last session",
            category: "Runs",
          },
          {
            title: schedule?.enabled ? schedule.cron : "manual only",
            value: "schedule",
            description: schedule?.enabled ? cronDescription(schedule.cron) : "Schedule trigger",
            category: "Triggers",
          },
          {
            title: api?.enabled ? api.token : "disabled",
            value: "api",
            description: api?.enabled ? "API token" : "API trigger",
            category: "Triggers",
          },
          {
            title: Locale.truncate(props.routine.prompt, 80),
            value: "prompt",
            description: "Prompt",
            category: "Prompt",
          },
          { title: "← Back", value: "back", description: "Return to actions", category: "Navigation" },
        ]}
        getOptionKey={(option) => option.value}
        onSelect={(option) => {
          if (option.value === "back") void refreshTo(props.routine)
        }}
      />
    ))
  }

  function editName() {
    dialog.replace(() => (
      <DialogPrompt
        title="Edit routine name"
        value={props.routine.name}
        onConfirm={(value) => {
          const name = value.trim()
          if (!name) {
            toast.show({ message: "Name is required", variant: "error" })
            return
          }
          void update({ name })
        }}
        onCancel={() => void refreshTo(props.routine)}
      />
    ))
  }

  function editPrompt() {
    dialog.replace(() => (
      <DialogPrompt
        title="Edit routine prompt"
        value={props.routine.prompt}
        onConfirm={(value) => {
          const prompt = value.trim()
          if (!prompt) {
            toast.show({ message: "Prompt is required", variant: "error" })
            return
          }
          void update({ prompt })
        }}
        onCancel={() => void refreshTo(props.routine)}
      />
    ))
  }

  function editSchedule() {
    dialog.replace(() => (
      <DialogSelect
        title="Schedule trigger"
        options={SCHEDULE_OPTIONS}
        current={(scheduleTrigger(props.routine)?.cron || "") as ScheduleChoice}
        onSelect={(option) => {
          if (option.value === "__custom__") {
            dialog.replace(() => (
              <DialogPrompt
                title="Custom schedule"
                description={() => <text style={{ fg: theme.foreground.muted }}>{SUPPORTED_CRON_HELP}</text>}
                placeholder="*/30 or 0 */2 * * *"
                value={scheduleTrigger(props.routine)?.cron}
                onConfirm={(value) => {
                  const cron = value.trim()
                  if (!cron) {
                    void update({ triggers: updateSchedule(props.routine.triggers, "") })
                    return
                  }
                  if (!isValidCron(cron)) {
                    toast.show({ message: SUPPORTED_CRON_HELP, variant: "error" })
                    return
                  }
                  void update({ triggers: updateSchedule(props.routine.triggers, cron) })
                }}
                onCancel={() => void refreshTo(props.routine)}
              />
            ))
            return
          }
          void update({ triggers: updateSchedule(props.routine.triggers, option.value) })
        }}
      />
    ))
  }

  function editApi(action: "enable" | "rotate" | "disable") {
    if (action === "disable") {
      void update({ triggers: updateApi(props.routine.triggers, null) })
      return
    }
    const token = generateApiToken()
    void update({ triggers: updateApi(props.routine.triggers, token) })
    toast.show({ message: `API token: ${token}`, variant: "success" })
  }

  async function togglePause() {
    setBusy(true)
    try {
      const result = props.routine.paused
        ? await sdk.client.mobile.routine.resume({ id: props.routine.id })
        : await sdk.client.mobile.routine.pause({ id: props.routine.id })
      const routine = assertData<MobileRoutine>(result, "Failed to change routine status")
      toast.show({ message: routine.paused ? "Routine paused" : "Routine resumed", variant: "success" })
      await refreshTo(routine)
    } catch (error) {
      toast.show({ message: errorMessage(error), variant: "error" })
      setBusy(false)
    }
  }

  async function deleteRoutine() {
    const { DialogConfirm } = await import("@tui/ui/dialog-confirm")
    const confirmed = await DialogConfirm.show(
      dialog,
      "Delete routine",
      `Delete "${props.routine.name}"? This cannot be undone.`,
    )
    if (!confirmed) {
      await refreshTo(props.routine)
      return
    }
    setBusy(true)
    try {
      const result = await sdk.client.mobile.routine.delete({ id: props.routine.id })
      if (result.error) throw new Error(errorMessage(result.error))
      toast.show({ message: "Routine deleted", variant: "success" })
      props.onDone()
      dialog.clear()
    } catch (error) {
      toast.show({ message: errorMessage(error), variant: "error" })
      setBusy(false)
    }
  }

  const schedule = () => scheduleTrigger(props.routine)
  const api = () => apiTrigger(props.routine)
  const actions = (): DialogSelectOption<RoutineAction>[] => [
    {
      title: "View details",
      value: "details",
      description: `${props.routine.paused ? "paused" : "active"} - ${formatTriggers(props.routine)}`,
      category: "Manage",
      onSelect: viewDetails,
    },
    {
      title: "Run now",
      value: "run",
      description: "Start a new session from this routine",
      category: "Run",
      onSelect: () => void run(),
    },
    {
      title: "Run with context",
      value: "run-context",
      description: "Add one-off text for an API-style run",
      category: "Run",
      onSelect: runWithContext,
    },
    {
      title: "Edit name",
      value: "edit-name",
      description: props.routine.name,
      category: "Edit",
      onSelect: editName,
    },
    {
      title: "Edit prompt",
      value: "edit-prompt",
      description: Locale.truncate(props.routine.prompt, 70),
      category: "Edit",
      onSelect: editPrompt,
    },
    {
      title: props.routine.model
        ? `Model: ${props.routine.model.providerID}/${props.routine.model.modelID}`
        : "Model: default",
      value: "edit-model",
      description: "Click to change the model",
      category: "Edit",
      onSelect: () => {
        dialog.replace(() => (
          <DialogModel
            onSelect={(modelValue: { providerID: string; modelID: string }) => {
              void update({ model: modelValue })
            }}
          />
        ))
      },
    },
    {
      title: schedule()?.enabled ? "Edit schedule" : "Add schedule",
      value: "edit-schedule",
      description: schedule()?.enabled
        ? `${schedule()?.cron} - ${cronDescription(schedule()?.cron ?? "")}`
        : "Manual only",
      category: "Triggers",
      onSelect: editSchedule,
    },
    {
      title: api()?.enabled ? "Rotate API token" : "Enable API trigger",
      value: api()?.enabled ? "rotate-api" : "enable-api",
      description: api()?.enabled ? apiCurl(api()?.token ?? "") : "Generate a trigger token",
      category: "Triggers",
      onSelect: () => editApi(api()?.enabled ? "rotate" : "enable"),
    },
    {
      title: api()?.enabled ? "Disable API trigger" : "API trigger disabled",
      value: "disable-api",
      description: api()?.enabled ? "Revoke API trigger access" : "No active API token",
      category: "Triggers",
      onSelect: () => editApi("disable"),
    },
    {
      title: props.routine.paused ? "Resume routine" : "Pause routine",
      value: "pause",
      description: props.routine.paused ? "Re-enable scheduled runs" : "Disable scheduled runs",
      category: "Danger",
      onSelect: () => void togglePause(),
    },
    {
      title: "Delete routine",
      value: "delete",
      description: "Remove this routine permanently",
      category: "Danger",
      onSelect: () => void deleteRoutine(),
    },
    {
      title: "← Back",
      value: "back",
      description: "Return to routine list",
      category: "Navigation",
      onSelect: () => props.onDone(),
    },
  ]

  return (
    <Show
      when={!busy()}
      fallback={
        <box paddingLeft={2} paddingRight={2} gap={1} paddingBottom={1}>
          <text attributes={TextAttributes.BOLD} style={{ fg: theme.foreground.default }}>
            Routine: {props.routine.name}
          </text>
          <text style={{ fg: theme.foreground.muted }}>Working...</text>
        </box>
      }
    >
      <DialogSelect
        title={`Routine: ${props.routine.name}`}
        options={actions()}
        getOptionKey={(option) => option.value}
        onSelect={(option) => {
          if (option.value === "back") props.onDone()
        }}
      />
    </Show>
  )
}

export function DialogRoutine() {
  const dialog = useDialog()
  const { theme } = useTheme()
  const sdk = useSDK()
  const [refreshKey, setRefreshKey] = createSignal(0)

  const [routines] = createResource(refreshKey, async () => {
    const result = await sdk.client.mobile.routine.list()
    if (result.error) throw result.error
    return (result.data ?? []) as MobileRoutine[]
  })

  function refresh() {
    setRefreshKey((key) => key + 1)
  }

  function openList() {
    refresh()
    dialog.replace(() => <DialogRoutine />)
  }

  const options = (): DialogSelectOption<string>[] => {
    const list = routines.latest ?? routines() ?? []
    const items = list.map(
      (routine): DialogSelectOption<string> => ({
        title: routine.name,
        value: routine.id,
        category: routine.paused ? "Paused" : "Active",
        description: `${formatTriggers(routine)} - last run ${formatRelativeTime(routine.lastRunAt)}`,
        footer: routine.lastSessionID ? "has run" : undefined,
        onSelect: () => dialog.replace(() => <DialogRoutineActions routine={routine} onDone={openList} />),
      }),
    )

    items.push({
      title: "New routine",
      value: "__new__",
      category: "Create",
      description: "Create a manual, scheduled, or API-triggered workflow",
      onSelect: () => dialog.replace(() => <DialogRoutineCreate onDone={refresh} />),
    })

    return items
  }

  return (
    <Show
      when={routines.state === "ready" || routines.state === "refreshing"}
      fallback={
        <box paddingLeft={2} paddingRight={2} gap={1} paddingBottom={1}>
          <text attributes={TextAttributes.BOLD} style={{ fg: theme.foreground.default }}>
            Routines
          </text>
          <text style={{ fg: theme.foreground.muted }}>
            {routines.error ? `Error: ${errorMessage(routines.error)}` : "Loading..."}
          </text>
        </box>
      }
    >
      <DialogSelect title="Routines" options={options()} getOptionKey={(option) => option.value} />
    </Show>
  )
}
