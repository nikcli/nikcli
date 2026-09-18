import { For, Show, createEffect, createMemo, createResource, createSignal, onCleanup } from "solid-js"
import { TextAttributes, type RGBA, type ScrollBoxRenderable } from "@opentui/core"
import { useKeyboard } from "@opentui/solid"
import open from "open"
import { useRoute, useRouteData } from "@tui/context/route"
import { useSDK } from "@tui/context/sdk"
import { useSync } from "@tui/context/sync"
import { useTheme } from "@tui/context/theme"
import { useKeybind } from "@tui/context/keybind"
import { useDialog } from "@tui/ui/dialog"
import { DialogConfirm } from "@tui/ui/dialog-confirm"
import { DialogPrompt } from "@tui/ui/dialog-prompt"
import { DialogSelect, type DialogSelectOption } from "@tui/ui/dialog-select"
import { FooterHint, FooterSep } from "@tui/ui/footer-hints"
import { useToast } from "@tui/ui/toast"
import { Clipboard } from "@tui/util/clipboard"
import { isPlainShortcut } from "@tui/util/keys"
import { createDebouncedSignal } from "@tui/util/signal"
import { moveSelection, reconcileSelection } from "@tui/ui/select-controller"
import { scrollChildIntoView, useScrollAcceleration } from "@tui/util/scroll"
import { run, runErrorMessage } from "@tui/routes/workspace/repo-status"
import { useKeyboardCapture, useWorkspaceShell } from "@tui/routes/workspace/shell"
import {
  formatAge,
  formatDuration,
  isRunning,
  loadCiState,
  loadJobs,
  runIcon,
  runTone,
  type RunTone,
  type Workflow,
  type WorkflowRun,
} from "./ci"

type Section = "runs" | "workflows"

const LIST_WIDTH = 54
/** Only while something is still running — a finished board polls nothing. */
const LIVE_POLL_MS = 15_000

function truncate(text: string, max: number) {
  if (max <= 1) return text.slice(0, Math.max(0, max))
  if (text.length <= max) return text
  return `${text.slice(0, max - 1)}…`
}

export function ActionsPanel() {
  const routeData = useRouteData("actions")
  const route = useRoute()
  const sync = useSync()
  const sdk = useSDK()
  const { theme } = useTheme()
  const dialog = useDialog()
  const toast = useToast()
  const keybind = useKeybind()
  const shell = useWorkspaceShell()
  const scrollAcceleration = useScrollAcceleration()

  const [section, setSection] = createSignal<Section>("runs")
  const [selected, setSelected] = createSignal(0)
  const [filterOpen, setFilterOpen] = createSignal(false)
  const [filterText, setFilterText] = createSignal("")
  /** Scope the run list to the checked-out branch, or show every branch. */
  const [branchScope, setBranchScope] = createSignal(true)
  const [now, setNow] = createSignal(Date.now())

  useKeyboardCapture(filterOpen)

  const directory = createMemo(() => sync.data.path.directory || sdk.directory || process.cwd())
  const branch = createMemo(() => shell?.status()?.branch ?? "")

  const query = createMemo(() => ({
    directory: directory(),
    branch: branchScope() && branch() && branch() !== "detached" ? branch() : undefined,
  }))

  const [state, { refetch }] = createResource(query, (input) => loadCiState(input.directory, { branch: input.branch }))

  const tone = (row: { status: string; conclusion: string }) => runTone(row)
  const toneColor = (value: RunTone): RGBA => {
    switch (value) {
      case "success":
        return theme.status.success.fg
      case "failure":
        return theme.status.error.fg
      case "running":
        return theme.accent.fg
      case "pending":
        return theme.status.warning.fg
      case "neutral":
        return theme.foreground.muted
    }
  }

  const runs = createMemo(() => {
    const filter = filterText().trim().toLowerCase()
    const list = state()?.runs ?? []
    if (!filter) return list
    return list.filter((row) =>
      [row.workflow, row.title, row.branch, row.event, row.conclusion, row.status, String(row.number)]
        .join(" ")
        .toLowerCase()
        .includes(filter),
    )
  })

  const workflows = createMemo(() => {
    const filter = filterText().trim().toLowerCase()
    const list = state()?.workflows ?? []
    if (!filter) return list
    return list.filter((row) => `${row.name} ${row.path} ${row.state}`.toLowerCase().includes(filter))
  })

  const items = createMemo<Array<WorkflowRun | Workflow>>(() => (section() === "runs" ? runs() : workflows()))
  const selectedRun = createMemo(() =>
    section() === "runs" ? (items()[selected()] as WorkflowRun | undefined) : undefined,
  )
  const selectedWorkflow = createMemo(() =>
    section() === "workflows" ? (items()[selected()] as Workflow | undefined) : undefined,
  )

  createEffect(() => {
    if (selected() < items().length) return
    setSelected(reconcileSelection(selected(), items().length))
  })

  /**
   * Jobs follow the cursor, but not keystroke by keystroke: `gh run view` is a
   * GitHub API call, and holding `j` down a 40-run list would fire one per row.
   * The debounce means only the run you actually stopped on is fetched.
   */
  const [jobsKey, setJobsKey] = createDebouncedSignal<{ directory: string; id: number } | undefined>(undefined, 300)
  createEffect(() => {
    const row = selectedRun()
    setJobsKey(row ? { directory: directory(), id: row.id } : undefined)
  })
  onCleanup(() => setJobsKey.clear())

  const [jobs] = createResource(jobsKey, (input) => loadJobs(input.directory, input.id))

  /**
   * A live board needs two clocks: one to re-read the API, and one to keep the
   * elapsed column moving between reads. Both stop as soon as every run is
   * finished, so an idle CI tab costs nothing.
   */
  const live = createMemo(() => (state()?.runs ?? []).some(isRunning))
  createEffect(() => {
    if (!live()) return
    const tick = setInterval(() => setNow(Date.now()), 1000)
    const poll = setInterval(() => void refetch(), LIVE_POLL_MS)
    onCleanup(() => {
      clearInterval(tick)
      clearInterval(poll)
    })
  })

  let listScroll: ScrollBoxRenderable | undefined
  const rowID = (index: number) => `ci-row-${index}`
  createEffect(() => {
    const index = selected()
    if (items().length === 0) return
    scrollChildIntoView(listScroll, rowID(index))
  })

  function selectDelta(delta: number) {
    const count = items().length
    if (count === 0) return
    setSelected((index) => moveSelection(index, { count, delta, policy: "wrap" }))
  }

  function toggleSection() {
    setSection((current) => (current === "runs" ? "workflows" : "runs"))
    setSelected(0)
  }

  function navigateBack() {
    if (routeData.sessionID) {
      route.navigate({
        type: "session",
        sessionID: routeData.sessionID,
        workspaceID: routeData.workspaceID ?? sync.session.get(routeData.sessionID)?.workspaceID,
      })
      return
    }
    route.navigate({ type: "home", workspaceID: routeData.workspaceID })
  }

  async function gh(label: string, args: string[]) {
    const result = await run("gh", args, directory(), { timeoutMs: 30_000 })
    if (result.exitCode !== 0) {
      toast.show({ variant: "error", message: `${label}: ${runErrorMessage(result)}` })
      return false
    }
    toast.show({ variant: "success", message: label })
    void refetch()
    return true
  }

  function actionOpen() {
    const url = selectedRun()?.url
    if (!url) {
      toast.show({ variant: "info", message: "No URL for this row" })
      return
    }
    open(url).catch(() => toast.show({ variant: "error", message: "Could not open the browser" }))
  }

  function actionCopyUrl() {
    const url = selectedRun()?.url
    if (!url) return
    Clipboard.copy(url)
      .then(() => toast.show({ variant: "info", message: "Copied run URL" }))
      .catch(toast.error)
  }

  function actionCancel() {
    const row = selectedRun()
    if (!row) return
    if (!isRunning(row)) {
      toast.show({ variant: "info", message: "Run already finished" })
      return
    }
    dialog.setSize("medium")
    dialog.replace(
      () => (
        <DialogConfirm
          title="Cancel run"
          message={`Cancel ${row.workflow} #${row.number}?`}
          onConfirm={() => {
            dialog.clear()
            void gh(`Cancelled #${row.number}`, ["run", "cancel", String(row.id)])
          }}
          onCancel={() => dialog.clear()}
        />
      ),
      () => {},
    )
  }

  function actionRerun(failedOnly: boolean) {
    const row = selectedRun()
    if (!row) return
    if (isRunning(row)) {
      toast.show({ variant: "info", message: "Run is still in progress" })
      return
    }
    const args = ["run", "rerun", String(row.id)]
    if (failedOnly) args.push("--failed")
    void gh(`Re-ran ${failedOnly ? "failed jobs of " : ""}#${row.number}`, args)
  }

  function actionDispatch() {
    const workflow = selectedWorkflow()
    if (!workflow) {
      toast.show({ variant: "info", message: "Select a workflow to dispatch" })
      return
    }
    dialog.setSize("medium")
    dialog.replace(
      () => (
        <DialogPrompt
          title={`Run ${workflow.name}`}
          placeholder={branch() || "main"}
          value={branch()}
          description={() => <text fg={theme.foreground.muted}>Ref to run the workflow on</text>}
          onConfirm={(ref) => {
            dialog.clear()
            const target = ref.trim() || branch()
            if (!target) return
            void gh(`Dispatched ${workflow.name}`, ["workflow", "run", workflow.path || workflow.name, "--ref", target])
          }}
          onCancel={() => dialog.clear()}
        />
      ),
      () => {},
    )
  }

  /** Jump the run list to one workflow — the common "why is this red" path. */
  function actionFilterByWorkflow() {
    const workflow = selectedWorkflow()
    if (!workflow) return
    setSection("runs")
    setFilterText(workflow.name)
    setSelected(0)
  }

  function actionLogs() {
    const row = selectedRun()
    if (!row) return
    const failed = (jobs() ?? []).filter((job) => runTone(job) === "failure")
    const options: DialogSelectOption<string>[] = (jobs() ?? []).map((job) => ({
      title: `${runIcon(runTone(job))} ${job.name}`,
      value: job.url || row.url,
      description: `${job.conclusion || job.status} · ${formatDuration(job.startedAt, job.completedAt, now())}`,
      category: runTone(job) === "failure" ? "Failed" : "Other",
    }))
    if (options.length === 0) {
      toast.show({ variant: "info", message: "No jobs for this run yet" })
      return
    }
    dialog.setSize("large")
    dialog.replace(
      () => (
        <DialogSelect
          title={`Jobs · ${row.workflow} #${row.number}${failed.length > 0 ? ` · ${failed.length} failed` : ""}`}
          placeholder="search jobs"
          options={options}
          onSelect={(option) => {
            dialog.clear()
            if (!option.value) return
            open(option.value).catch(() => toast.show({ variant: "error", message: "Could not open the browser" }))
          }}
        />
      ),
      () => {},
    )
  }

  useKeyboard((evt) => {
    if (evt.defaultPrevented || dialog.stack.length > 0 || keybind.leader) return

    if (filterOpen()) {
      if (evt.name === "escape") {
        evt.preventDefault()
        setFilterOpen(false)
        setFilterText("")
        return
      }
      if (evt.name === "return") {
        evt.preventDefault()
        setFilterOpen(false)
        return
      }
      if (evt.name === "backspace") {
        evt.preventDefault()
        setFilterText((text) => text.slice(0, -1))
        return
      }
      if (!evt.ctrl && !evt.meta && !evt.super && evt.name && evt.name.length === 1) {
        evt.preventDefault()
        setFilterText((text) => text + evt.name)
        return
      }
      return
    }

    if (evt.name === "escape") {
      evt.preventDefault()
      if (filterText()) {
        setFilterText("")
        return
      }
      navigateBack()
      return
    }
    if (isPlainShortcut(evt, "j", "down")) {
      evt.preventDefault()
      selectDelta(1)
      return
    }
    if (isPlainShortcut(evt, "k", "up")) {
      evt.preventDefault()
      selectDelta(-1)
      return
    }
    if (isPlainShortcut(evt, "g")) {
      evt.preventDefault()
      setSelected(0)
      return
    }
    if (isPlainShortcut(evt, "G")) {
      evt.preventDefault()
      setSelected(Math.max(0, items().length - 1))
      return
    }
    if (isPlainShortcut(evt, "[", "]")) {
      evt.preventDefault()
      toggleSection()
      return
    }
    if (isPlainShortcut(evt, "f", "/")) {
      evt.preventDefault()
      setFilterOpen(true)
      return
    }
    if (isPlainShortcut(evt, "r")) {
      evt.preventDefault()
      void refetch()
      return
    }
    if (isPlainShortcut(evt, "b")) {
      evt.preventDefault()
      setBranchScope((value) => !value)
      setSelected(0)
      return
    }
    if (isPlainShortcut(evt, "o")) {
      evt.preventDefault()
      actionOpen()
      return
    }
    if (isPlainShortcut(evt, "y")) {
      evt.preventDefault()
      actionCopyUrl()
      return
    }
    if (isPlainShortcut(evt, "x")) {
      evt.preventDefault()
      actionCancel()
      return
    }
    if (isPlainShortcut(evt, "R")) {
      evt.preventDefault()
      actionRerun(true)
      return
    }
    if (isPlainShortcut(evt, "A")) {
      evt.preventDefault()
      actionRerun(false)
      return
    }
    if (isPlainShortcut(evt, "d")) {
      evt.preventDefault()
      actionDispatch()
      return
    }
    if (isPlainShortcut(evt, "return")) {
      evt.preventDefault()
      if (section() === "workflows") actionFilterByWorkflow()
      else actionLogs()
      return
    }
  })

  const summary = createMemo(() => {
    const list = state()?.runs ?? []
    const failing = list.filter((row) => runTone(row) === "failure").length
    const running = list.filter((row) => isRunning(row)).length
    const passing = list.filter((row) => runTone(row) === "success").length
    return { failing, running, passing, total: list.length }
  })

  return (
    <box width="100%" height="100%" flexDirection="column" backgroundColor={theme.surface.base}>
      <box flexShrink={0} border={["bottom"]} borderColor={theme.border.subtle} backgroundColor={theme.surface.panel}>
        <box paddingLeft={2} paddingRight={2} paddingTop={1} paddingBottom={1} flexDirection="column">
          <box flexDirection="row" justifyContent="space-between" alignItems="center" width="100%" gap={1}>
            <box flexDirection="row" gap={0} alignItems="baseline" flexGrow={1} minWidth={0} overflow="hidden">
              <text fg={theme.foreground.muted} attributes={TextAttributes.DIM} wrapMode="none">
                Workflow
              </text>
              <text fg={theme.accent.fg} attributes={TextAttributes.BOLD} wrapMode="none">
                {" runs"}
              </text>
              <text fg={theme.foreground.muted} attributes={TextAttributes.DIM} wrapMode="none">
                {"  ·  "}
              </text>
              <text fg={theme.foreground.default} attributes={TextAttributes.DIM} wrapMode="none" minWidth={0}>
                {branchScope() && branch() ? branch() : "all branches"}
              </text>
            </box>
            <box
              paddingLeft={1}
              paddingRight={1}
              backgroundColor={theme.surface.offset}
              border={["top", "right", "bottom", "left"]}
              borderColor={theme.border.subtle}
              flexShrink={0}
            >
              <text
                fg={summary().failing > 0 ? theme.status.error.fg : live() ? theme.accent.fg : theme.status.success.fg}
                attributes={TextAttributes.BOLD}
                wrapMode="none"
              >
                {summary().failing > 0 ? "FAILING" : live() ? "RUNNING" : "CI"}
              </text>
            </box>
          </box>
          <box flexDirection="row" justifyContent="space-between" alignItems="center" width="100%" gap={1}>
            <text fg={theme.foreground.muted} attributes={TextAttributes.DIM} wrapMode="none">
              {state.loading ? "loading…" : (state()?.error ?? `${summary().total} runs`)}
            </text>
            <box flexDirection="row" gap={1} flexShrink={0} alignItems="center">
              <Show when={summary().running > 0}>
                <text fg={theme.accent.fg} wrapMode="none">{`● ${summary().running}`}</text>
              </Show>
              <Show when={summary().failing > 0}>
                <text fg={theme.status.error.fg} wrapMode="none">{`✗ ${summary().failing}`}</text>
              </Show>
              <Show when={summary().passing > 0}>
                <text fg={theme.status.success.fg} wrapMode="none">{`✓ ${summary().passing}`}</text>
              </Show>
            </box>
          </box>
          <Show when={filterOpen() || filterText()}>
            <text fg={theme.accent.fg} wrapMode="none">
              {`/${filterText()}${filterOpen() ? "_" : ""}`}
            </text>
          </Show>
        </box>
      </box>

      <box flexShrink={0} border={["bottom"]} borderColor={theme.border.subtle} flexDirection="row" paddingLeft={1}>
        <For
          each={[
            { id: "runs" as Section, label: "Runs", count: runs().length },
            { id: "workflows" as Section, label: "Workflows", count: workflows().length },
          ]}
        >
          {(tab) => (
            <box
              paddingLeft={2}
              paddingRight={2}
              onMouseDown={() => {
                setSection(tab.id)
                setSelected(0)
              }}
            >
              <text
                fg={section() === tab.id ? theme.accent.fg : theme.foreground.muted}
                attributes={section() === tab.id ? TextAttributes.BOLD : TextAttributes.DIM}
                wrapMode="none"
              >
                {tab.label}
              </text>
              <text fg={theme.foreground.muted} wrapMode="none">{` ${tab.count}`}</text>
            </box>
          )}
        </For>
      </box>

      <box flexDirection="row" flexGrow={1} minHeight={0}>
        <box
          width={LIST_WIDTH}
          minWidth={LIST_WIDTH}
          border={["right"]}
          borderColor={theme.border.subtle}
          flexDirection="column"
          minHeight={0}
        >
          <Show
            when={items().length > 0}
            fallback={
              <box flexGrow={1} alignItems="center" justifyContent="center" paddingLeft={2} paddingRight={2}>
                <text
                  fg={state()?.error ? theme.status.error.fg : theme.foreground.muted}
                  attributes={TextAttributes.DIM}
                  wrapMode="word"
                >
                  {state.loading
                    ? "Loading…"
                    : (state()?.error ??
                      (filterText()
                        ? "Nothing matches the filter"
                        : state()?.configured
                          ? "No runs yet"
                          : "No workflows in this repository"))}
                </text>
              </box>
            }
          >
            <scrollbox
              ref={(r: ScrollBoxRenderable) => (listScroll = r)}
              viewportCulling={true}
              scrollAcceleration={scrollAcceleration()}
              flexGrow={1}
              scrollbarOptions={{ visible: false }}
            >
              <For each={items()}>
                {(item, index) => {
                  const isSelected = () => selected() === index()
                  const asRun = () => (section() === "runs" ? (item as WorkflowRun) : undefined)
                  const asWorkflow = () => (section() === "workflows" ? (item as Workflow) : undefined)
                  return (
                    <box
                      id={rowID(index())}
                      width="100%"
                      height={1}
                      backgroundColor={isSelected() ? theme.surface.offset : undefined}
                      onMouseDown={() => setSelected(index())}
                    >
                      <box width={1} minWidth={1} backgroundColor={isSelected() ? theme.accent.fg : undefined} />
                      <box flexDirection="row" flexGrow={1} minWidth={0} overflow="hidden" paddingLeft={1} gap={1}>
                        <Show when={asRun()}>
                          {(row) => (
                            <>
                              <text fg={toneColor(tone(row()))} wrapMode="none" minWidth={1}>
                                {runIcon(tone(row()))}
                              </text>
                              <text
                                fg={theme.foreground.default}
                                attributes={isSelected() ? TextAttributes.BOLD : undefined}
                                wrapMode="none"
                                flexGrow={1}
                                minWidth={0}
                              >
                                {truncate(row().workflow || row().title, LIST_WIDTH - 22)}
                              </text>
                              <text fg={theme.foreground.muted} attributes={TextAttributes.DIM} wrapMode="none">
                                {truncate(row().branch, 12)}
                              </text>
                              <text fg={theme.foreground.subtle} attributes={TextAttributes.DIM} wrapMode="none">
                                {formatAge(row().updatedAt || row().createdAt, now())}
                              </text>
                            </>
                          )}
                        </Show>
                        <Show when={asWorkflow()}>
                          {(row) => (
                            <>
                              <text
                                fg={row().state === "active" ? theme.status.success.fg : theme.foreground.muted}
                                wrapMode="none"
                                minWidth={1}
                              >
                                {row().state === "active" ? "•" : "·"}
                              </text>
                              <text
                                fg={theme.foreground.default}
                                attributes={isSelected() ? TextAttributes.BOLD : undefined}
                                wrapMode="none"
                                flexGrow={1}
                                minWidth={0}
                              >
                                {truncate(row().name, LIST_WIDTH - 6)}
                              </text>
                            </>
                          )}
                        </Show>
                      </box>
                    </box>
                  )
                }}
              </For>
            </scrollbox>
          </Show>
        </box>

        <box flexGrow={1} minWidth={0} minHeight={0} flexDirection="column">
          <Show
            when={selectedRun()}
            fallback={
              <Show
                when={selectedWorkflow()}
                fallback={
                  <box flexGrow={1} alignItems="center" justifyContent="center">
                    <text fg={theme.foreground.muted} attributes={TextAttributes.DIM}>
                      Select a row
                    </text>
                  </box>
                }
              >
                {(workflow) => (
                  <box flexDirection="column" padding={2} gap={1}>
                    <text fg={theme.foreground.default} attributes={TextAttributes.BOLD} wrapMode="word">
                      {workflow().name}
                    </text>
                    <text fg={theme.foreground.muted} wrapMode="word">
                      {workflow().path}
                    </text>
                    <text fg={workflow().state === "active" ? theme.status.success.fg : theme.status.warning.fg}>
                      {workflow().state}
                    </text>
                    <text fg={theme.foreground.subtle} attributes={TextAttributes.DIM} wrapMode="word">
                      enter · show its runs d · run workflow
                    </text>
                  </box>
                )}
              </Show>
            }
          >
            {(row) => (
              <scrollbox
                viewportCulling={true}
                scrollAcceleration={scrollAcceleration()}
                flexGrow={1}
                scrollbarOptions={{ visible: false }}
              >
                <box flexDirection="column" paddingLeft={2} paddingRight={2} paddingTop={1} paddingBottom={1} gap={0}>
                  <box flexDirection="row" gap={1} alignItems="baseline">
                    <text fg={toneColor(tone(row()))} attributes={TextAttributes.BOLD} wrapMode="none">
                      {runIcon(tone(row()))}
                    </text>
                    <text fg={theme.foreground.default} attributes={TextAttributes.BOLD} wrapMode="word" minWidth={0}>
                      {row().title || row().workflow}
                    </text>
                  </box>
                  <box flexDirection="row" gap={1} alignItems="baseline" flexWrap="wrap">
                    <text fg={theme.foreground.muted} attributes={TextAttributes.DIM} wrapMode="none">
                      {`${row().workflow} #${row().number}${row().attempt > 1 ? ` · attempt ${row().attempt}` : ""}`}
                    </text>
                  </box>
                  <box flexDirection="row" gap={2} paddingTop={1} flexWrap="wrap">
                    <DetailField
                      label="status"
                      value={row().conclusion || row().status}
                      tone={toneColor(tone(row()))}
                    />
                    <DetailField label="branch" value={row().branch} />
                    <DetailField label="event" value={row().event} />
                    <DetailField
                      label="elapsed"
                      value={formatDuration(row().startedAt, isRunning(row()) ? "" : row().updatedAt, now())}
                    />
                    <DetailField label="age" value={formatAge(row().createdAt, now())} />
                  </box>

                  <box paddingTop={1} flexDirection="row" gap={1} alignItems="baseline">
                    <text fg={theme.foreground.muted} attributes={TextAttributes.DIM} wrapMode="none">
                      Jobs
                    </text>
                    <text fg={theme.foreground.subtle} attributes={TextAttributes.DIM} wrapMode="none">
                      {jobs.loading ? "loading…" : `${(jobs() ?? []).length}`}
                    </text>
                  </box>
                  <For each={jobs() ?? []}>
                    {(job) => {
                      const jobTone = () => runTone(job)
                      const failedSteps = () => job.steps.filter((step) => runTone(step) === "failure").slice(0, 4)
                      return (
                        <box flexDirection="column">
                          <box flexDirection="row" gap={1} alignItems="baseline">
                            <text fg={toneColor(jobTone())} wrapMode="none" minWidth={1}>
                              {runIcon(jobTone())}
                            </text>
                            <text fg={theme.foreground.default} wrapMode="none" flexGrow={1} minWidth={0}>
                              {job.name}
                            </text>
                            <text fg={theme.foreground.subtle} attributes={TextAttributes.DIM} wrapMode="none">
                              {formatDuration(job.startedAt, job.completedAt, now())}
                            </text>
                          </box>
                          <For each={failedSteps()}>
                            {(step) => (
                              <box flexDirection="row" gap={1} paddingLeft={2}>
                                <text fg={theme.status.error.fg} attributes={TextAttributes.DIM} wrapMode="none">
                                  ↳
                                </text>
                                <text fg={theme.status.error.fg} attributes={TextAttributes.DIM} wrapMode="word">
                                  {step.name}
                                </text>
                              </box>
                            )}
                          </For>
                        </box>
                      )
                    }}
                  </For>
                </box>
              </scrollbox>
            )}
          </Show>
        </box>
      </box>

      <box
        border={["top"]}
        borderColor={theme.border.subtle}
        backgroundColor={theme.surface.panel}
        width="100%"
        flexShrink={0}
      >
        <box
          flexDirection="row"
          justifyContent="space-between"
          alignItems="center"
          width="100%"
          paddingLeft={2}
          paddingRight={2}
          paddingTop={1}
          paddingBottom={1}
          flexWrap="wrap"
          gap={1}
        >
          <box flexDirection="row" gap={2} alignItems="center" flexWrap="wrap">
            <text fg={theme.foreground.default} attributes={TextAttributes.DIM} wrapMode="none">
              CI
            </text>
            <FooterSep />
            <FooterHint keys="j · k" label="move" />
            <FooterSep />
            <FooterHint keys="[ · ]" label="section" />
            <FooterSep />
            <FooterHint keys="enter" label={section() === "workflows" ? "runs" : "jobs"} />
            <FooterSep />
            <FooterHint keys="o" label="browser" />
            <FooterSep />
            <FooterHint keys="R · A" label="rerun" />
            <FooterSep />
            <FooterHint keys="x" label="cancel" />
            <FooterSep />
            <FooterHint keys="d" label="dispatch" />
            <FooterSep />
            <FooterHint keys="b" label={branchScope() ? "all branches" : "this branch"} />
            <FooterSep />
            <FooterHint keys="r" label="refresh" />
          </box>
          <box flexDirection="row" gap={2} alignItems="center" flexShrink={0}>
            <text fg={theme.foreground.muted} wrapMode="none">
              {`[${items().length === 0 ? 0 : selected() + 1}/${items().length}]`}
            </text>
            <Show when={live()}>
              <text fg={theme.accent.fg} wrapMode="none">
                live
              </text>
            </Show>
          </box>
        </box>
      </box>
    </box>
  )
}

function DetailField(props: { label: string; value: string; tone?: RGBA }) {
  const { theme } = useTheme()
  return (
    <box flexDirection="row" gap={1} alignItems="baseline">
      <text fg={theme.foreground.subtle} attributes={TextAttributes.DIM} wrapMode="none">
        {props.label}
      </text>
      <text fg={props.tone ?? theme.foreground.default} wrapMode="none">
        {props.value || "—"}
      </text>
    </box>
  )
}
