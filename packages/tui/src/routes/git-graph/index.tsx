import { useScrollAcceleration } from "@tui/util/scroll"
import { For, Show, createEffect, createMemo, createResource, createSignal } from "solid-js"
import { TextAttributes, type ScrollBoxRenderable } from "@opentui/core"
import { useKeyboard, useTerminalDimensions } from "@opentui/solid"
import path from "path"
import { useRoute, useRouteData } from "@tui/context/route"
import { useSDK } from "@tui/context/sdk"
import { useSync } from "@tui/context/sync"
import { useTheme } from "@tui/context/theme"
import { Clipboard } from "@tui/util/clipboard"
import { useToast } from "@tui/ui/toast"
import { FooterHint, FooterSep } from "@tui/ui/footer-hints"
import { useDialog } from "@tui/ui/dialog"
import { useKeybind } from "@tui/context/keybind"
import { isPlainShortcut } from "@tui/util/keys"
import { useKeyboardCapture } from "@tui/routes/workspace/shell"
import open from "open"

const FIELD = "\x1f"
const LIMIT = 500
const GRAPH_WIDTH = 4
const HASH_WIDTH = 12
const REF_WIDTH = 18
const DATE_WIDTH = 12
const SCORE_WIDTH = 7

type CommitRow = {
  graph: string
  hash: string
  fullHash: string
  author: string
  relativeDate: string
  date: string
  subject: string
  refs: string
}

type CommitDetails = {
  directory: string
  hash: string
  body: string[]
  files: string[]
  additions: number
  deletions: number
}

type GitHubLabel = {
  name: string
  color?: string
}

type GitHubCheck = {
  name: string
  state: string
}

type GitHubDetails = {
  directory: string
  repo: string
  number: number
  title: string
  body: string
  author: string
  state: string
  url: string
  updatedAt: string
  headRefName: string
  baseRefName: string
  labels: GitHubLabel[]
  checks: GitHubCheck[]
}

type GraphState =
  | { status: "ok"; rows: CommitRow[]; branch: string; directory: string }
  | { status: "empty"; rows: CommitRow[]; branch: string; directory: string }
  | { status: "error"; message: string; directory: string }

function trimError(error: unknown) {
  if (error instanceof Error && error.message) return error.message.split("\n")[0] ?? error.message
  return String(error)
}

function truncate(text: string, max: number) {
  if (max <= 1) return text.slice(0, Math.max(0, max))
  if (text.length <= max) return text
  return `${text.slice(0, max - 1)}…`
}

function shortDir(dir: string) {
  try {
    return path.basename(dir) || dir
  } catch {
    return dir
  }
}

function colorForGraph(text: string, theme: ReturnType<typeof useTheme>["theme"]) {
  if (text.includes("*")) return theme.accent.fg
  if (text.includes("/")) return theme.status.warning.fg
  if (text.includes("\\")) return theme.status.success.fg
  if (text.includes("|")) return theme.status.info.fg
  return theme.foreground.muted
}

function cleanRef(ref: string) {
  return ref
    .replace(/^HEAD -> /, "")
    .replace(/^origin\//, "")
    .replace(/^tag: /, "")
}

function splitRefs(refs: string) {
  return refs
    .split(",")
    .map((ref) => cleanRef(ref.trim()))
    .filter(Boolean)
}

function prNumber(row: CommitRow | undefined) {
  if (!row) return undefined
  const refMatch = row.refs.match(/pull\/(\d+)\b/)
  const mergeMatch = row.subject.match(/^Merge pull request #(\d+)\b/)
  const value = refMatch?.[1] ?? mergeMatch?.[1]
  return value ? Number(value) : undefined
}

function bodyBullets(text: string) {
  return text
    .split("\n")
    .map((line) => line.trim().replace(/^[-*]\s+/, ""))
    .filter(Boolean)
}

function isTextInputKey(evt: { ctrl?: boolean; meta?: boolean; super?: boolean; name?: string }) {
  return !evt.ctrl && !evt.meta && !evt.super && evt.name && evt.name.length === 1
}

function initials(author: string) {
  const parts = author.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return "--"
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
  return `${parts[0][0]}${parts[1][0]}`.toUpperCase()
}

function scoreColor(value: string, theme: ReturnType<typeof useTheme>["theme"]) {
  if (value === "PR") return theme.accent.fg
  if (value === "—") return theme.foreground.muted
  const [done, total] = value.split("/").map(Number)
  if (!done || !total) return theme.foreground.muted
  const ratio = done / total
  if (ratio >= 0.9) return theme.status.success.fg
  if (ratio >= 0.7) return theme.status.warning.fg
  return theme.status.error.fg
}

async function runProcess(
  binary: string,
  args: string[],
  directory: string,
  options: { allowFailure?: boolean; timeoutMs?: number } = {},
) {
  const resolved = binary === "git" ? (Bun.which("git") ?? "git") : Bun.which(binary)
  if (!resolved) throw new Error(`${binary} not found`)
  const proc = Bun.spawn([resolved, ...args], {
    windowsHide: true,
    cwd: directory,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      GH_PROMPT_DISABLED: "1",
      GIT_TERMINAL_PROMPT: "0",
    },
  })
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    proc.kill()
  }, options.timeoutMs ?? 15_000)
  const [stdout, stderr, exitCode] = await Promise.all([
    Bun.readableStreamToText(proc.stdout),
    Bun.readableStreamToText(proc.stderr),
    proc.exited,
  ]).finally(() => clearTimeout(timer))
  if (timedOut) throw new Error(`${binary} ${args[0]} timed out`)
  if (exitCode !== 0 && !options.allowFailure) {
    throw new Error(stderr.trim() || `${binary} ${args[0]} failed with exit ${exitCode}`)
  }
  return stdout
}

async function runGit(args: string[], directory: string, options?: { allowFailure?: boolean; timeoutMs?: number }) {
  return runProcess("git", args, directory, options)
}

async function runCommand(
  binary: string,
  args: string[],
  directory: string,
  options?: { allowFailure?: boolean; timeoutMs?: number },
) {
  return runProcess(binary, args, directory, options)
}

function remoteSlug(remote: string) {
  const trimmed = remote.trim().replace(/\.git$/, "")
  const ssh = trimmed.match(/github\.com[:/]([^/]+\/[^/]+)$/)
  if (ssh) return ssh[1]
  try {
    const url = new URL(trimmed)
    if (!url.hostname.includes("github.com")) return undefined
    return url.pathname.replace(/^\//, "")
  } catch {
    return undefined
  }
}

function stringValue(input: unknown) {
  return typeof input === "string" ? input : ""
}

function numberValue(input: unknown) {
  return typeof input === "number" ? input : 0
}

function recordValue(input: unknown) {
  return input && typeof input === "object" ? (input as Record<string, unknown>) : {}
}

function parseJSON(input: string): unknown {
  try {
    return JSON.parse(input)
  } catch {
    return undefined
  }
}

function isSuccessState(state: string) {
  return ["SUCCESS", "PASSING", "COMPLETED", "success", "passing", "completed"].includes(state)
}

async function loadGitHubDetails(
  input: { directory: string; number?: number } | undefined,
): Promise<GitHubDetails | undefined> {
  if (!input?.number) return undefined
  const remote = await runGit(["remote", "get-url", "origin"], input.directory).catch(() => "")
  const repo = remoteSlug(remote)
  if (!repo) return undefined
  const [viewStdout, checksStdout] = await Promise.all([
    runCommand(
      "gh",
      [
        "pr",
        "view",
        String(input.number),
        "--repo",
        repo,
        "--json",
        "number,title,body,author,state,url,updatedAt,headRefName,baseRefName,labels",
      ],
      input.directory,
      { timeoutMs: 20_000 },
    ).catch(() => ""),
    runCommand("gh", ["pr", "checks", String(input.number), "--repo", repo, "--json", "name,state"], input.directory, {
      allowFailure: true,
      timeoutMs: 20_000,
    }).catch(() => "[]"),
  ])
  if (!viewStdout) return undefined
  const view = recordValue(parseJSON(viewStdout))
  const author = recordValue(view.author)
  const labelsRaw = Array.isArray(view.labels) ? view.labels : []
  const parsedChecks = parseJSON(checksStdout || "[]")
  const checksRaw = Array.isArray(parsedChecks) ? parsedChecks : []
  return {
    directory: input.directory,
    repo,
    number: numberValue(view.number),
    title: stringValue(view.title),
    body: stringValue(view.body),
    author: stringValue(author.login) || stringValue(author.name),
    state: stringValue(view.state),
    url: stringValue(view.url),
    updatedAt: stringValue(view.updatedAt),
    headRefName: stringValue(view.headRefName),
    baseRefName: stringValue(view.baseRefName),
    labels: labelsRaw.map((item) => {
      const label = recordValue(item)
      return { name: stringValue(label.name), color: stringValue(label.color) || undefined }
    }),
    checks: checksRaw.map((item: unknown) => {
      const check = recordValue(item)
      return { name: stringValue(check.name), state: stringValue(check.state) }
    }),
  }
}

async function loadGraph(directory: string): Promise<GraphState> {
  try {
    const [stdout, branchStdout] = await Promise.all([
      runGit(
        [
          "log",
          "--graph",
          "--decorate=short",
          "--date=short",
          `--max-count=${LIMIT}`,
          "--all",
          `--pretty=format:%x1f%h%x1f%H%x1f%an%x1f%ar%x1f%ad%x1f%s%x1f%D`,
        ],
        directory,
      ),
      runGit(["branch", "--show-current"], directory).catch(() => ""),
    ])
    const rows = stdout
      .split("\n")
      .map((line) => {
        const marker = line.indexOf(FIELD)
        if (marker < 0) return undefined
        const graph = line.slice(0, marker).trimEnd()
        const parts = line.slice(marker + 1).split(FIELD)
        const [hash = "", fullHash = "", author = "", relativeDate = "", date = "", subject = "", refs = ""] = parts
        if (!hash) return undefined
        return { graph, hash, fullHash, author, relativeDate, date, subject, refs }
      })
      .filter((row): row is CommitRow => Boolean(row))
    const branch = branchStdout.trim() || "detached"
    return rows.length > 0 ? { status: "ok", rows, branch, directory } : { status: "empty", rows, branch, directory }
  } catch (error) {
    return { status: "error", message: trimError(error), directory }
  }
}

async function loadDetails(input: { directory: string; hash: string } | undefined): Promise<CommitDetails | undefined> {
  if (!input?.hash) return undefined
  const stdout = await runGit(
    ["show", "--no-ext-diff", "--format=%B", "--stat", "--stat-count=8", "--stat-width=96", input.hash],
    input.directory,
  ).catch(() => "")
  const lines = stdout.split("\n")
  const firstStat = lines.findIndex((line) => line.includes(" | "))
  const bodyEnd = firstStat < 0 ? lines.length : firstStat
  const files = lines.filter((line) => line.includes(" | ")).map((line) => line.trim())
  const summary = lines.find((line) => /files? changed/.test(line)) ?? ""
  const additions = Number(summary.match(/(\d+) insertions?/)?.[1] ?? 0)
  const deletions = Number(summary.match(/(\d+) deletions?/)?.[1] ?? 0)
  const body = lines
    .slice(1, bodyEnd)
    .map((line) => line.trim())
    .filter(Boolean)
  return { directory: input.directory, hash: input.hash, body, files, additions, deletions }
}

export function GitGraph() {
  const routeData = useRouteData("git-graph")
  const route = useRoute()
  const scrollAcceleration = useScrollAcceleration()
  const sdk = useSDK()
  const sync = useSync()
  const toast = useToast()
  const dialog = useDialog()
  const keybind = useKeybind()
  const dimensions = useTerminalDimensions()
  const { theme } = useTheme()
  const [selected, setSelected] = createSignal(0)
  const [filterOpen, setFilterOpen] = createSignal(false)
  const [filterText, setFilterText] = createSignal("")

  // While the filter box has the keyboard, the shell must not read `1`-`5`.
  useKeyboardCapture(filterOpen)
  const [commitsOpen, setCommitsOpen] = createSignal(true)
  const [listScroll, setListScroll] = createSignal<ScrollBoxRenderable>()
  const directory = createMemo(() => sync.data.path.directory || sdk.directory || process.cwd())
  const [graph, { refetch }] = createResource(directory, loadGraph)

  const rows = createMemo(() => {
    const data = graph()
    if (!data || data.status === "error" || data.directory !== directory()) return []
    const filter = filterText().trim().toLowerCase()
    if (!filter) return data.rows
    return data.rows.filter(
      (row) =>
        row.hash.toLowerCase().includes(filter) ||
        row.fullHash.toLowerCase().includes(filter) ||
        row.subject.toLowerCase().includes(filter) ||
        row.author.toLowerCase().includes(filter) ||
        row.refs.toLowerCase().includes(filter),
    )
  })
  const selectedRow = createMemo(() => rows()[selected()])
  const detailsInput = createMemo(() => {
    const row = selectedRow()
    return row ? { directory: directory(), hash: row.fullHash } : undefined
  })
  const [details] = createResource(detailsInput, loadDetails)
  const selectedPrNumber = createMemo(() => prNumber(selectedRow()))
  const githubInput = createMemo(() => ({ directory: directory(), number: selectedPrNumber() }))
  const [github] = createResource(githubInput, loadGitHubDetails)
  const currentDetails = createMemo(() => {
    const row = selectedRow()
    const value = details()
    return row && value?.hash === row.fullHash && value.directory === directory() ? value : undefined
  })
  const currentGitHub = createMemo(() => {
    const number = selectedPrNumber()
    const value = github()
    return number && value?.number === number && value.directory === directory() ? value : undefined
  })
  const splitView = createMemo(() => dimensions().width >= 118)
  const leftWidth = createMemo(() =>
    splitView() ? Math.max(58, Math.floor(dimensions().width * 0.56)) : dimensions().width,
  )
  const subjectWidth = createMemo(() =>
    Math.max(18, leftWidth() - GRAPH_WIDTH - HASH_WIDTH - REF_WIDTH - DATE_WIDTH - SCORE_WIDTH - 10),
  )
  const branchLabel = createMemo(() => {
    const data = graph()
    return data && data.status !== "error" && data.directory === directory() ? data.branch : undefined
  })
  const totalRows = createMemo(() => {
    const data = graph()
    return data && data.status !== "error" && data.directory === directory() ? data.rows.length : 0
  })
  const errorMessage = createMemo(() => {
    const data = graph()
    return data?.status === "error" ? data.message : undefined
  })
  const hasPrRows = createMemo(() => rows().some((row) => prNumber(row)))
  const selectedRefs = createMemo(() => splitRefs(selectedRow()?.refs ?? ""))
  const checkSummary = createMemo(() => {
    const checks = currentGitHub()?.checks ?? []
    if (checks.length === 0) return undefined
    const passed = checks.filter((check) => isSuccessState(check.state)).length
    return `${passed}/${checks.length}`
  })
  const displayScore = createMemo(() => checkSummary() ?? (currentGitHub() ? "0/0" : "—"))
  const testLines = createMemo(() => {
    const source = currentGitHub()?.body ? bodyBullets(currentGitHub()!.body) : (currentDetails()?.body ?? [])
    return source.filter((line) => /\b(bun|npm|pnpm|yarn|git)\b/.test(line)).slice(0, 6)
  })

  createEffect(() => {
    if (selected() < rows().length) return
    setSelected(Math.max(0, rows().length - 1))
  })

  function selectIndex(index: number) {
    const list = rows()
    if (list.length === 0) return
    const next = (index + list.length) % list.length
    setSelected(next)
    listScroll()?.scrollTo(Math.max(0, next - 2))
  }

  function selectDelta(delta: number) {
    const list = rows()
    if (list.length === 0) return
    selectIndex(selected() + delta)
  }

  function close() {
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

  function copyHash() {
    const row = selectedRow()
    if (!row) return
    Clipboard.copy(row.fullHash || row.hash)
      .then(() => toast.show({ message: `Copied ${row.hash}`, variant: "info" }))
      .catch(toast.error)
  }

  function showHash() {
    const row = selectedRow()
    if (!row) return
    toast.show({ message: row.fullHash, variant: "info", duration: 4000 })
  }

  function openSelected() {
    const url = currentGitHub()?.url
    if (!url) {
      toast.show({ message: "No GitHub PR URL for this commit", variant: "info", duration: 3000 })
      return
    }
    open(url).catch(toast.error)
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
      if (evt.name === "space" || evt.name === " ") {
        evt.preventDefault()
        setFilterText((text) => `${text} `)
        return
      }
      if (isTextInputKey(evt)) {
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
      close()
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
      selectIndex(0)
      return
    }
    if (isPlainShortcut(evt, "G")) {
      evt.preventDefault()
      selectIndex(Math.max(0, rows().length - 1))
      return
    }
    if (isPlainShortcut(evt, "/", "f")) {
      evt.preventDefault()
      setFilterOpen(true)
      return
    }
    if (isPlainShortcut(evt, "r")) {
      evt.preventDefault()
      void refetch()
      return
    }
    if (isPlainShortcut(evt, "x")) {
      evt.preventDefault()
      setCommitsOpen((open) => !open)
      return
    }
    if (isPlainShortcut(evt, "y")) {
      evt.preventDefault()
      copyHash()
      return
    }
    if (evt.name === "return") {
      evt.preventDefault()
      showHash()
      return
    }
    if (isPlainShortcut(evt, "o")) {
      evt.preventDefault()
      openSelected()
    }
  })

  return (
    <box width="100%" height="100%" flexDirection="column" backgroundColor={theme.surface.base}>
      <box flexShrink={0} border={["bottom"]} borderColor={theme.border.subtle} backgroundColor={theme.surface.base}>
        <box paddingLeft={2} paddingRight={2} paddingTop={1} paddingBottom={1} flexDirection="column" gap={0}>
          <box flexDirection="row" justifyContent="space-between" alignItems="center" width="100%" gap={1}>
            <box flexDirection="row" gap={0} flexGrow={1} minWidth={0} overflow="hidden">
              <text fg={theme.foreground.muted} attributes={TextAttributes.BOLD} wrapMode="none">
                GHUI
              </text>
              <text fg={theme.foreground.muted} attributes={TextAttributes.DIM} wrapMode="none">
                {"  "}
              </text>
              <text fg={theme.foreground.default} attributes={TextAttributes.BOLD} wrapMode="none">
                {shortDir(directory())}
              </text>
              <text fg={theme.foreground.muted} attributes={TextAttributes.DIM} wrapMode="none">
                {branchLabel() ? `  ${branchLabel()}` : ""}
              </text>
            </box>
            <box flexDirection="row" gap={1} flexShrink={0}>
              <text fg={theme.foreground.muted} attributes={TextAttributes.DIM} wrapMode="none">
                updated
              </text>
              <text fg={theme.foreground.muted} attributes={TextAttributes.BOLD} wrapMode="none">
                {currentGitHub()?.updatedAt
                  ? currentGitHub()!.updatedAt.slice(0, 10)
                  : (selectedRow()?.relativeDate ?? "--")}
              </text>
            </box>
          </box>
          <Show when={filterOpen() || filterText()}>
            <text fg={theme.accent.fg} wrapMode="none">
              {`/${filterText()}${filterOpen() ? "_" : ""}`}
            </text>
          </Show>
        </box>
      </box>

      <box flexDirection="row" flexGrow={1} minHeight={0}>
        <box width={splitView() ? leftWidth() : "100%"} flexDirection="column" minHeight={0}>
          <box
            paddingLeft={2}
            paddingRight={1}
            paddingTop={1}
            paddingBottom={0}
            flexDirection="row"
            justifyContent="space-between"
          >
            <text fg={theme.status.warning.fg} attributes={TextAttributes.BOLD} wrapMode="none">
              {hasPrRows() ? "PULL REQUESTS" : "COMMITS"}
            </text>
            <text fg={theme.foreground.muted} attributes={TextAttributes.DIM} wrapMode="none">
              {`${rows().length}/${totalRows()}`}
            </text>
          </box>
          <box
            flexDirection="row"
            gap={1}
            paddingLeft={2}
            paddingRight={1}
            backgroundColor={commitsOpen() ? undefined : theme.surface.offset}
            onMouseDown={() => setCommitsOpen((open) => !open)}
          >
            <text fg={theme.accent.fg} attributes={TextAttributes.BOLD} wrapMode="none">
              {commitsOpen() ? "▾" : "▸"}
            </text>
            <text fg={theme.accent.fg} attributes={TextAttributes.BOLD} wrapMode="none">
              {`${shortDir(directory())}/${branchLabel() ?? "commits"}`}
            </text>
          </box>
          <Show
            when={commitsOpen() && !graph.loading && graph()?.status !== "error" && rows().length > 0}
            fallback={
              <box flexGrow={1} justifyContent="center" alignItems="center" flexDirection="column" gap={1}>
                <text
                  fg={errorMessage() ? theme.status.error.fg : theme.foreground.muted}
                  attributes={TextAttributes.DIM}
                  wrapMode="word"
                >
                  {graph.loading
                    ? "Loading git graph..."
                    : errorMessage()
                      ? errorMessage()
                      : !commitsOpen()
                        ? "Section collapsed"
                        : filterText()
                          ? `No commits match /${filterText()}`
                          : "No commits found"}
                </text>
              </box>
            }
          >
            <scrollbox
              viewportCulling={true}
              scrollAcceleration={scrollAcceleration()}
              ref={setListScroll}
              flexGrow={1}
              backgroundColor={theme.surface.base}
              paddingLeft={1}
              paddingRight={1}
              paddingBottom={1}
              scrollbarOptions={{ visible: false }}
            >
              <For each={rows()}>
                {(row, index) => {
                  const isSelected = () => selected() === index()
                  const refs = () => splitRefs(row.refs)
                  const number = () => prNumber(row)
                  const rowScore = () => (isSelected() ? displayScore() : number() ? "PR" : "—")
                  const rowSubjectWidth = () => subjectWidth() + (refs().length > 0 ? 0 : REF_WIDTH)
                  return (
                    <box
                      flexDirection="row"
                      width="100%"
                      height={1}
                      backgroundColor={isSelected() ? theme.surface.offset : theme.surface.base}
                      onMouseDown={() => setSelected(index())}
                    >
                      <box width={1} minWidth={1} backgroundColor={isSelected() ? theme.accent.fg : undefined} />
                      <box width={GRAPH_WIDTH} minWidth={GRAPH_WIDTH} flexShrink={0} overflow="hidden">
                        <text fg={colorForGraph(row.graph, theme)} wrapMode="none">
                          {row.graph.includes("*") ? "•" : row.graph.includes("|") ? "│" : "·"}
                        </text>
                      </box>
                      <box width={HASH_WIDTH} minWidth={HASH_WIDTH} flexShrink={0} overflow="hidden">
                        <text fg={theme.status.warning.fg} wrapMode="none">
                          {truncate(number() ? `#${number()}` : row.hash, HASH_WIDTH - 1)}
                        </text>
                      </box>
                      <box flexDirection="row" gap={1} flexGrow={1} minWidth={0} overflow="hidden">
                        <Show when={refs().length > 0}>
                          <box width={REF_WIDTH} minWidth={REF_WIDTH} flexShrink={0} overflow="hidden">
                            <text fg={theme.accent.fg} attributes={TextAttributes.BOLD} wrapMode="none">
                              {truncate(refs()[0], REF_WIDTH - 1)}
                            </text>
                          </box>
                        </Show>
                        <text
                          fg={theme.foreground.default}
                          attributes={isSelected() ? TextAttributes.BOLD : undefined}
                          wrapMode="none"
                          maxWidth={rowSubjectWidth()}
                        >
                          {truncate(row.subject, rowSubjectWidth())}
                        </text>
                      </box>
                      <box width={SCORE_WIDTH} minWidth={SCORE_WIDTH} flexShrink={0} overflow="hidden">
                        <text fg={scoreColor(rowScore(), theme)} attributes={TextAttributes.BOLD} wrapMode="none">
                          {truncate(rowScore(), SCORE_WIDTH - 1)}
                        </text>
                      </box>
                      <box width={DATE_WIDTH} minWidth={DATE_WIDTH} flexShrink={0} overflow="hidden">
                        <text fg={theme.foreground.muted} attributes={TextAttributes.DIM} wrapMode="none">
                          {truncate(row.relativeDate, DATE_WIDTH - 1)}
                        </text>
                      </box>
                    </box>
                  )
                }}
              </For>
            </scrollbox>
          </Show>
        </box>

        <Show when={splitView()}>
          <box border={["left"]} borderColor={theme.border.subtle} flexGrow={1} minWidth={0} flexDirection="column">
            <Show
              when={selectedRow()}
              fallback={
                <box flexGrow={1} alignItems="center" justifyContent="center">
                  <text fg={theme.foreground.muted} attributes={TextAttributes.DIM} wrapMode="word">
                    Select a commit
                  </text>
                </box>
              }
            >
              {(row) => (
                <scrollbox
                  scrollAcceleration={scrollAcceleration()}
                  flexGrow={1}
                  paddingLeft={2}
                  paddingRight={2}
                  paddingTop={1}
                  paddingBottom={1}
                  scrollbarOptions={{ visible: false }}
                >
                  <box flexDirection="column" gap={1}>
                    <box
                      border={["bottom"]}
                      borderColor={theme.border.subtle}
                      paddingBottom={1}
                      flexDirection="column"
                      gap={0}
                    >
                      <box flexDirection="row" justifyContent="space-between" gap={2}>
                        <box flexDirection="row" gap={1} minWidth={0} flexGrow={1}>
                          <text fg={theme.status.warning.fg} wrapMode="none">
                            {currentGitHub()?.number ? `#${currentGitHub()!.number}` : row().hash}
                          </text>
                          <text fg={theme.foreground.muted} attributes={TextAttributes.DIM} wrapMode="none">
                            {currentGitHub()?.author ?? initials(row().author)}
                          </text>
                        </box>
                        <text fg={scoreColor(displayScore(), theme)} attributes={TextAttributes.BOLD} wrapMode="none">
                          {displayScore()}
                        </text>
                      </box>
                      <text fg={theme.foreground.default} attributes={TextAttributes.BOLD} wrapMode="word">
                        {currentGitHub()?.title || row().subject}
                      </text>
                      <box flexDirection="row" gap={1} flexWrap="wrap">
                        <For each={(currentGitHub()?.labels.map((label) => label.name) ?? selectedRefs()).slice(0, 4)}>
                          {(label, index) => (
                            <box
                              paddingLeft={1}
                              paddingRight={1}
                              backgroundColor={index() === 0 ? theme.surface.offset : theme.accent.fg}
                            >
                              <text fg={index() === 0 ? theme.foreground.default : theme.surface.base} wrapMode="none">
                                {label}
                              </text>
                            </box>
                          )}
                        </For>
                      </box>
                    </box>

                    <Show when={(currentGitHub()?.checks.length ?? 0) > 0}>
                      <box
                        border={["bottom"]}
                        borderColor={theme.border.subtle}
                        paddingBottom={1}
                        flexDirection="column"
                        gap={0}
                      >
                        <text fg={theme.status.warning.fg} attributes={TextAttributes.BOLD} wrapMode="none">
                          Checks
                        </text>
                        <For each={currentGitHub()?.checks.slice(0, 6) ?? []}>
                          {(check) => {
                            const ok = () => isSuccessState(check.state)
                            return (
                              <box flexDirection="row" gap={1}>
                                <text
                                  fg={ok() ? theme.status.success.fg : theme.status.warning.fg}
                                  attributes={TextAttributes.BOLD}
                                  wrapMode="none"
                                >
                                  {ok() ? "✓" : "•"}
                                </text>
                                <text fg={theme.foreground.default} wrapMode="none">
                                  {truncate(check.name, Math.max(20, dimensions().width - leftWidth() - 12))}
                                </text>
                              </box>
                            )
                          }}
                        </For>
                      </box>
                    </Show>
                    <Show when={selectedPrNumber() && github.loading}>
                      <box border={["bottom"]} borderColor={theme.border.subtle} paddingBottom={1}>
                        <text fg={theme.foreground.muted} attributes={TextAttributes.DIM} wrapMode="word">
                          Loading GitHub PR metadata...
                        </text>
                      </box>
                    </Show>

                    <box
                      border={["bottom"]}
                      borderColor={theme.border.subtle}
                      paddingBottom={1}
                      flexDirection="column"
                      gap={0}
                    >
                      <text fg={theme.status.warning.fg} attributes={TextAttributes.BOLD} wrapMode="none">
                        Details
                      </text>
                      <text fg={theme.foreground.default} wrapMode="none">
                        {`Author  ${currentGitHub()?.author ?? row().author}`}
                      </text>
                      <text fg={theme.foreground.muted} attributes={TextAttributes.DIM} wrapMode="none">
                        {`Date    ${row().date} (${row().relativeDate})`}
                      </text>
                      <Show when={currentGitHub()}>
                        {(pr) => (
                          <>
                            <text fg={theme.foreground.muted} attributes={TextAttributes.DIM} wrapMode="none">
                              {`Branch  ${pr().headRefName} -> ${pr().baseRefName}`}
                            </text>
                            <text fg={theme.foreground.muted} attributes={TextAttributes.DIM} wrapMode="none">
                              {`State   ${pr().state}`}
                            </text>
                          </>
                        )}
                      </Show>
                      <text fg={theme.foreground.muted} attributes={TextAttributes.DIM} wrapMode="none">
                        {`Hash    ${row().fullHash}`}
                      </text>
                    </box>

                    <box
                      border={["bottom"]}
                      borderColor={theme.border.subtle}
                      paddingBottom={1}
                      flexDirection="column"
                      gap={0}
                    >
                      <text fg={theme.status.warning.fg} attributes={TextAttributes.BOLD} wrapMode="none">
                        Summary
                      </text>
                      <Show
                        when={
                          (currentGitHub()?.body
                            ? bodyBullets(currentGitHub()!.body).length
                            : (currentDetails()?.body.length ?? 0)) > 0
                        }
                        fallback={
                          <text fg={theme.foreground.muted} attributes={TextAttributes.DIM} wrapMode="word">
                            No extended commit body.
                          </text>
                        }
                      >
                        <For
                          each={(currentGitHub()?.body
                            ? bodyBullets(currentGitHub()!.body)
                            : (currentDetails()?.body ?? [])
                          ).slice(0, 8)}
                        >
                          {(line) => (
                            <text fg={theme.foreground.default} wrapMode="word">
                              {`- ${line}`}
                            </text>
                          )}
                        </For>
                      </Show>
                    </box>

                    <box flexDirection="column" gap={0}>
                      <box flexDirection="row" justifyContent="space-between">
                        <text fg={theme.status.warning.fg} attributes={TextAttributes.BOLD} wrapMode="none">
                          Files
                        </text>
                        <box flexDirection="row" gap={1}>
                          <text fg={theme.status.success.fg} wrapMode="none">
                            {`+${currentDetails()?.additions ?? 0}`}
                          </text>
                          <text fg={theme.status.error.fg} wrapMode="none">
                            {`-${currentDetails()?.deletions ?? 0}`}
                          </text>
                        </box>
                      </box>
                      <For each={currentDetails()?.files.slice(0, 8) ?? []}>
                        {(file) => (
                          <text fg={theme.foreground.muted} attributes={TextAttributes.DIM} wrapMode="none">
                            {truncate(file, Math.max(30, dimensions().width - leftWidth() - 6))}
                          </text>
                        )}
                      </For>
                      <Show when={!currentDetails() && !details.loading}>
                        <text fg={theme.foreground.muted} attributes={TextAttributes.DIM} wrapMode="word">
                          Stats unavailable.
                        </text>
                      </Show>
                    </box>

                    <Show when={testLines().length > 0}>
                      <box flexDirection="column" gap={0}>
                        <text fg={theme.status.warning.fg} attributes={TextAttributes.BOLD} wrapMode="none">
                          Test
                        </text>
                        <For each={testLines()}>
                          {(line) => (
                            <text fg={theme.foreground.default} wrapMode="word">
                              {`- ${line}`}
                            </text>
                          )}
                        </For>
                      </box>
                    </Show>
                  </box>
                </scrollbox>
              )}
            </Show>
          </box>
        </Show>
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
          paddingLeft={2}
          paddingRight={2}
          paddingTop={1}
          paddingBottom={1}
          flexWrap="wrap"
          gap={1}
        >
          <box flexDirection="row" gap={2} flexWrap="wrap">
            <text fg={theme.foreground.default} attributes={TextAttributes.DIM} wrapMode="none">
              Graph
            </text>
            <FooterSep />
            <FooterHint keys="j · k" label="move" />
            <FooterSep />
            <FooterHint keys="/ · f" label="search" />
            <FooterSep />
            <FooterHint keys="enter" label="show hash" />
            <FooterSep />
            <FooterHint keys="o" label="open PR" />
            <FooterSep />
            <FooterHint keys="y" label="copy hash" />
            <FooterSep />
            <FooterHint keys="x" label={commitsOpen() ? "collapse" : "expand"} />
            <FooterSep />
            <FooterHint keys="r" label="refresh" />
            <FooterSep />
            <FooterHint keys="g/G" label="top/end" />
          </box>
          <box flexDirection="row" gap={2}>
            <text fg={theme.foreground.muted} wrapMode="none">
              {`[${Math.min(selected() + 1, Math.max(1, rows().length))}/${Math.max(1, rows().length)}]`}
            </text>
            <FooterHint keys="esc" label={filterOpen() || filterText() ? "clear" : "back"} />
          </box>
        </box>
      </box>
    </box>
  )
}
