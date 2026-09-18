import { moveSelection, reconcileSelection } from "@tui/ui/select-controller"
import { scrollChildIntoView, useScrollAcceleration } from "@tui/util/scroll"
import { For, Show, createEffect, createMemo, createResource, createSignal } from "solid-js"
import { TextAttributes, type ScrollBoxRenderable } from "@opentui/core"
import { useKeyboard } from "@opentui/solid"
import path from "node:path"
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
import { useKeyboardCapture, useWorkspaceShell } from "@tui/routes/workspace/shell"
import { DialogConfirm } from "@tui/ui/dialog-confirm"
import { DialogPrompt } from "@tui/ui/dialog-prompt"
import { DialogSelect, type DialogSelectOption } from "@tui/ui/dialog-select"
import open from "open"

const FIELD = "\x1f"
const LIMIT = 200

type Section = "branches" | "commits" | "prs" | "issues"

type Branch = {
  name: string
  current: boolean
  tracking?: string
}

type CommitRow = {
  graph: string
  hash: string
  fullHash: string
  author: string
  relativeDate: string
  date: string
  subject: string
  refs: string
  prNumber?: number
}

type PR = {
  number: number
  title: string
  author: string
  state: string
  head: string
  base: string
  url: string
  draft: boolean
  additions: number
  deletions: number
  checksPassed: boolean
}

type Issue = {
  number: number
  title: string
  author: string
  state: string
  labels: string[]
  assignees: string[]
  url: string
}

type GitHubState = {
  repo: string
  currentBranch: string
  branches: Branch[]
  commits: CommitRow[]
  prs: PR[]
  issues: Issue[]
  error?: string
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
    env: { ...process.env, GH_PROMPT_DISABLED: "1", GIT_TERMINAL_PROMPT: "0" },
  })
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    proc.kill()
  }, options.timeoutMs ?? 20_000)
  const [stdout, stderr, exitCode] = await Promise.all([
    Bun.readableStreamToText(proc.stdout),
    Bun.readableStreamToText(proc.stderr),
    proc.exited,
  ]).finally(() => clearTimeout(timer))
  if (timedOut) throw new Error(`${binary} timed out`)
  if (exitCode !== 0 && !options.allowFailure) throw new Error(stderr.trim() || `failed`)
  return stdout
}

function parseJSON(input: string) {
  try {
    return JSON.parse(input)
  } catch {
    return undefined
  }
}

function repoSlug(remote: string) {
  const trimmed = remote.replace(/\.git$/, "")
  const ssh = trimmed.match(/github\.com[:/](.+?\/.+?)$/)
  if (ssh) return ssh[1]
  try {
    const u = new URL(trimmed)
    if (u.hostname.includes("github.com")) return u.pathname.replace(/^\//, "")
  } catch {}
  return undefined
}

function prNumber(row: CommitRow) {
  const refMatch = row.refs.match(/pull\/(\d+)/)
  const mergeMatch = row.subject.match(/^Merge pull request #(\d+)/)
  return refMatch?.[1] ?? mergeMatch?.[1]
}

function initials(author: string) {
  const parts = author.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return "--"
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
  return `${parts[0][0]}${parts[1][0]}`.toUpperCase()
}

function shortDir(dir: string) {
  try {
    return path.basename(dir) || dir
  } catch {
    return dir
  }
}

function truncate(text: string, max: number) {
  if (max <= 1) return text.slice(0, Math.max(0, max))
  if (text.length <= max) return text
  return `${text.slice(0, max - 1)}…`
}

async function loadGitHubState(directory: string): Promise<GitHubState> {
  const remote = await runProcess("git", ["remote", "get-url", "origin"], directory).catch(() => "")
  const repo = repoSlug(remote) ?? shortDir(directory)
  const currentBranch = await runProcess("git", ["branch", "--show-current"], directory)
    .catch(() => "")
    .then((s) => s.trim() || "detached")

  const branchLines = await runProcess("git", ["branch", "-a", `--format=%(refname:short)|%(HEAD)`], directory).catch(
    () => "",
  )
  const branches: Branch[] = branchLines
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [name, current] = line.split("|")
      return { name: name.trim(), current: current.trim() === "*" }
    })
    .sort((a, b) => (a.current ? -1 : b.current ? 1 : a.name.localeCompare(b.name)))

  const logStdout = await runProcess(
    "git",
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
  ).catch(() => "")

  const commits: CommitRow[] = logStdout
    .split("\n")
    .map((line) => {
      const marker = line.indexOf(FIELD)
      if (marker < 0) return undefined
      const graph = line.slice(0, marker).trimEnd()
      const parts = line.slice(marker + 1).split(FIELD)
      const [hash = "", fullHash = "", author = "", relativeDate = "", date = "", subject = "", refs = ""] = parts
      if (!hash) return undefined
      const num = prNumber({ graph, hash, fullHash, author, relativeDate, date, subject, refs })
      const commit: CommitRow = {
        graph,
        hash,
        fullHash,
        author,
        relativeDate,
        date,
        subject,
        refs,
        prNumber: num ? Number(num) : undefined,
      }
      return commit
    })
    .filter((r): r is CommitRow => Boolean(r))

  const ghPRs: PR[] = []
  const ghIssues: Issue[] = []

  if (repo) {
    const prData = parseJSON(
      await runProcess(
        "gh",
        [
          "pr",
          "list",
          "--state=all",
          "--limit=50",
          "--json=number,title,author,state,headRefName,baseRefName,url,draft,additions,deletions",
        ],
        directory,
        { allowFailure: true },
      ).catch(() => ""),
    )
    if (Array.isArray(prData)) {
      for (const pr of prData.slice(0, 30)) {
        const checks = parseJSON(
          await runProcess("gh", ["pr", "checks", String(pr.number), "--json=name,state", "--limit=5"], directory, {
            allowFailure: true,
          }).catch(() => ""),
        )
        const allPassed =
          Array.isArray(checks) &&
          checks.length > 0 &&
          checks.every((c: Record<string, unknown>) => ["SUCCESS", "PASSING"].includes(c.state as string))
        ghPRs.push({
          number: pr.number,
          title: String(pr.title ?? ""),
          author: String((pr.author as Record<string, unknown>)?.login ?? pr.author ?? ""),
          state: String(pr.state ?? ""),
          head: String(pr.headRefName ?? ""),
          base: String(pr.baseRefName ?? ""),
          url: String(pr.url ?? ""),
          draft: Boolean(pr.draft),
          additions: Number(pr.additions ?? 0),
          deletions: Number(pr.deletions ?? 0),
          checksPassed: allPassed,
        })
      }
    }

    const issueData = parseJSON(
      await runProcess(
        "gh",
        ["issue", "list", "--state=all", "--limit=50", "--json=number,title,author,state,labels,assignees,url"],
        directory,
        { allowFailure: true },
      ).catch(() => ""),
    )
    if (Array.isArray(issueData)) {
      for (const issue of issueData.slice(0, 30)) {
        ghIssues.push({
          number: issue.number,
          title: String(issue.title ?? ""),
          author: String((issue.author as Record<string, unknown>)?.login ?? issue.author ?? ""),
          state: String(issue.state ?? ""),
          labels: Array.isArray(issue.labels)
            ? issue.labels.map((l: Record<string, unknown>) => String(l.name ?? "")).filter(Boolean)
            : [],
          assignees: Array.isArray(issue.assignees)
            ? issue.assignees.map((a: Record<string, unknown>) => String(a.login ?? a ?? "")).filter(Boolean)
            : [],
          url: String(issue.url ?? ""),
        })
      }
    }
  }

  return { repo, currentBranch, branches, commits, prs: ghPRs, issues: ghIssues }
}

export function GitHubPanel() {
  const routeData = useRouteData("github")
  const route = useRoute()
  const scrollAcceleration = useScrollAcceleration()
  const sync = useSync()
  const sdk = useSDK()
  const toast = useToast()
  const dialog = useDialog()
  const keybind = useKeybind()
  const shell = useWorkspaceShell()
  const { theme } = useTheme()

  const [section, setSection] = createSignal<Section>("commits")
  const [selected, setSelected] = createSignal(0)
  const [filterOpen, setFilterOpen] = createSignal(false)
  const [filterText, setFilterText] = createSignal("")

  // While the filter box has the keyboard, the shell must not read `1`-`5`.
  useKeyboardCapture(filterOpen)

  const directory = createMemo(() => sync.data.path.directory || sdk.directory || process.cwd())
  const [state, { refetch }] = createResource(directory, loadGitHubState)

  const SIDE_WIDTH = 48

  const sectionItems = createMemo(() => [
    { id: "branches" as Section, label: "Branches", count: state()?.branches.length ?? 0 },
    { id: "commits" as Section, label: "Commits", count: state()?.commits.length ?? 0 },
    { id: "prs" as Section, label: "PRs", count: state()?.prs.length ?? 0 },
    { id: "issues" as Section, label: "Issues", count: state()?.issues.length ?? 0 },
  ])

  // Helper filter functions (defined before visibleItems memo)
  function filterBranches(list: Branch[], filter: string): Branch[] {
    if (!filter) return list
    return list.filter((b) => b.name.toLowerCase().includes(filter))
  }
  function filterCommits(list: CommitRow[], filter: string): CommitRow[] {
    if (!filter) return list
    return list.filter(
      (c) =>
        c.hash.includes(filter) ||
        c.subject.toLowerCase().includes(filter) ||
        c.author.toLowerCase().includes(filter) ||
        c.refs.toLowerCase().includes(filter),
    )
  }
  function filterPRs(list: PR[], filter: string): PR[] {
    if (!filter) return list
    return list.filter(
      (p) =>
        String(p.number).includes(filter) ||
        p.title.toLowerCase().includes(filter) ||
        p.author.toLowerCase().includes(filter),
    )
  }
  function filterIssues(list: Issue[], filter: string): Issue[] {
    if (!filter) return list
    return list.filter(
      (i) =>
        String(i.number).includes(filter) ||
        i.title.toLowerCase().includes(filter) ||
        i.author.toLowerCase().includes(filter),
    )
  }

  const visibleItems = createMemo(() => {
    const s = state()
    if (!s) return [] as any[]
    const filter = filterText().trim().toLowerCase()
    if (section() === "branches") return filterBranches(s.branches, filter) as any[]
    if (section() === "commits") return filterCommits(s.commits, filter) as any[]
    if (section() === "prs") return filterPRs(s.prs, filter) as any[]
    if (section() === "issues") return filterIssues(s.issues, filter) as any[]
    return [] as any[]
  })

  const selectedItem = createMemo(() => visibleItems()[selected()] as any)

  createEffect(() => {
    if (selected() < visibleItems().length) return
    setSelected(reconcileSelection(selected(), visibleItems().length))
  })

  function selectDelta(delta: number) {
    const list = visibleItems()
    if (list.length === 0) return
    setSelected((i) => moveSelection(i, { count: list.length, delta, policy: "wrap" }))
  }

  /**
   * Keep the cursor on screen.
   *
   * The list moves on j/k, g/G and a section switch, and nothing ever scrolled
   * to it: past the fold the selection simply vanished and the only way back
   * was the mouse wheel. `scrollChildIntoView` is a no-op when the id is not in
   * the tree, so this stays quiet while the list is empty or still loading.
   */
  let listScroll: ScrollBoxRenderable | undefined
  const rowID = (index: number) => `github-row-${index}`
  createEffect(() => {
    const index = selected()
    if (visibleItems().length === 0) return
    scrollChildIntoView(listScroll, rowID(index))
  })

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

  function actionCreateBranch() {
    dialog.setSize("medium")
    dialog.replace(
      () => (
        <DialogPrompt
          title="Create branch"
          placeholder="feature/my-branch"
          description={() => <text fg={theme.foreground.muted}>Branch from: {state()?.currentBranch ?? "HEAD"}</text>}
          onConfirm={(name) => {
            dialog.clear()
            if (!name.trim()) return
            runProcess("git", ["checkout", "-b", name.trim()], directory())
              .then(() => {
                toast.show({ message: `Created branch: ${name.trim()}`, variant: "success" })
                void refetch()
              })
              .catch((e: unknown) => {
                toast.show({ message: String(e), variant: "error" })
              })
          }}
          onCancel={() => dialog.clear()}
        />
      ),
      () => {},
    )
  }

  function actionSwitchBranch() {
    const branches = state()?.branches ?? []
    const options: DialogSelectOption<string>[] = branches.map((b) => ({
      title: b.name + (b.current ? " (current)" : ""),
      value: b.name,
      description: b.tracking,
      bg: b.current ? theme.surface.offset : undefined,
    }))
    dialog.setSize("large")
    dialog.replace(
      () => (
        <DialogSelect
          title="Switch branch"
          placeholder="search branches"
          options={options}
          onSelect={(opt) => {
            dialog.clear()
            if (opt.value === state()?.currentBranch) return
            runProcess("git", ["checkout", opt.value], directory())
              .then(() => {
                toast.show({ message: `Switched to ${opt.value}`, variant: "success" })
                void refetch()
              })
              .catch((e: unknown) => toast.show({ message: String(e), variant: "error" }))
          }}
        />
      ),
      () => {},
    )
  }

  function actionDeleteBranch() {
    const branches = state()?.branches ?? []
    const deletable = branches.filter((b) => !b.current)
    const options: DialogSelectOption<string>[] = deletable.map((b) => ({
      title: b.name,
      value: b.name,
    }))
    dialog.setSize("large")
    dialog.replace(
      () => (
        <DialogSelect
          title="Delete branch"
          placeholder="select branch to delete"
          options={options}
          onSelect={(opt) => {
            dialog.clear()
            dialog.setSize("medium")
            dialog.replace(
              () => (
                <DialogConfirm
                  title="Delete branch"
                  message={`Delete local branch "${opt.value}"?`}
                  onConfirm={() => {
                    dialog.clear()
                    runProcess("git", ["branch", "-d", opt.value], directory())
                      .then(() => {
                        toast.show({ message: `Deleted ${opt.value}`, variant: "success" })
                        void refetch()
                      })
                      .catch((e: unknown) => toast.show({ message: String(e), variant: "error" }))
                  }}
                  onCancel={() => dialog.clear()}
                />
              ),
              () => {},
            )
          }}
        />
      ),
      () => {},
    )
  }

  function actionCreateCommit() {
    // Committing lives in the workspace repository menu, next to stage, stash
    // and push — `c` on the commit list opens it rather than dead-ending.
    if (shell) {
      shell.openActions()
      return
    }
    toast.show({ message: "Open the workspace panel to commit", variant: "info", duration: 3000 })
  }

  function actionCreatePR() {
    dialog.setSize("large")
    dialog.replace(
      () => (
        <DialogPrompt
          title="Create PR"
          placeholder="PR title"
          description={() => (
            <text fg={theme.foreground.muted}>
              From: {state()?.currentBranch ?? "HEAD"} — gh pr create opens in browser
            </text>
          )}
          onConfirm={(title) => {
            dialog.clear()
            if (!title.trim()) return
            runProcess("gh", ["pr", "create", "--title", title.trim(), "--body", ""], directory())
              .then((out) => {
                const url = out.trim()
                if (url) open(url).catch(() => {})
                toast.show({ message: `PR created${url ? `: ${url}` : ""}`, variant: "success" })
                void refetch()
              })
              .catch((e: unknown) => toast.show({ message: String(e), variant: "error" }))
          }}
          onCancel={() => dialog.clear()}
        />
      ),
      () => {},
    )
  }

  function actionMergePR() {
    const pr = selectedItem() as PR | undefined
    if (!pr || section() !== "prs") return
    dialog.setSize("medium")
    dialog.replace(
      () => (
        <DialogConfirm
          title="Merge PR"
          message={`Merge #${pr.number} "${pr.title}"?`}
          onConfirm={() => {
            dialog.clear()
            runProcess("gh", ["pr", "merge", String(pr.number), "--squash", "--delete-branch"], directory())
              .then(() => {
                toast.show({ message: `Merged #${pr.number}`, variant: "success" })
                void refetch()
              })
              .catch((e: unknown) => toast.show({ message: String(e), variant: "error" }))
          }}
          onCancel={() => dialog.clear()}
        />
      ),
      () => {},
    )
  }

  function actionClosePR() {
    const pr = selectedItem() as PR | undefined
    if (!pr || section() !== "prs") return
    dialog.setSize("medium")
    dialog.replace(
      () => (
        <DialogConfirm
          title="Close PR"
          message={`Close #${pr.number} "${pr.title}"?`}
          onConfirm={() => {
            dialog.clear()
            runProcess("gh", ["pr", "close", String(pr.number)], directory())
              .then(() => {
                toast.show({ message: `Closed #${pr.number}`, variant: "success" })
                void refetch()
              })
              .catch((e: unknown) => toast.show({ message: String(e), variant: "error" }))
          }}
          onCancel={() => dialog.clear()}
        />
      ),
      () => {},
    )
  }

  function actionCreateIssue() {
    dialog.setSize("large")
    dialog.replace(
      () => (
        <DialogPrompt
          title="Create issue"
          placeholder="Issue title"
          description={() => <text fg={theme.foreground.muted}>Opens in browser via gh</text>}
          onConfirm={(title) => {
            dialog.clear()
            if (!title.trim()) return
            runProcess("gh", ["issue", "create", "--title", title.trim(), "--body", ""], directory())
              .then((out) => {
                const url = out.trim()
                if (url) open(url).catch(() => {})
                toast.show({ message: `Issue created${url ? `: ${url}` : ""}`, variant: "success" })
                void refetch()
              })
              .catch((e: unknown) => toast.show({ message: String(e), variant: "error" }))
          }}
          onCancel={() => dialog.clear()}
        />
      ),
      () => {},
    )
  }

  function actionCloseIssue() {
    const issue = selectedItem() as Issue | undefined
    if (!issue || section() !== "issues") return
    dialog.setSize("medium")
    dialog.replace(
      () => (
        <DialogConfirm
          title="Close issue"
          message={`Close #${issue.number} "${issue.title}"?`}
          onConfirm={() => {
            dialog.clear()
            runProcess("gh", ["issue", "close", String(issue.number)], directory())
              .then(() => {
                toast.show({ message: `Closed #${issue.number}`, variant: "success" })
                void refetch()
              })
              .catch((e: unknown) => toast.show({ message: String(e), variant: "error" }))
          }}
          onCancel={() => dialog.clear()}
        />
      ),
      () => {},
    )
  }

  function actionOpenInBrowser() {
    const item = selectedItem()
    if (!item) return
    let url = ""
    if (section() === "prs") url = (item as PR).url
    else if (section() === "issues") url = (item as Issue).url
    else if (section() === "commits") {
      const commit = item as CommitRow
      const repo = state()?.repo
      if (repo && commit?.fullHash) url = `https://github.com/${repo}/commit/${commit.fullHash}`
    }
    if (url) open(url).catch(() => toast.show({ message: "Could not open URL", variant: "error" }))
    else toast.show({ message: "No URL available", variant: "info" })
  }

  function actionCopyHash() {
    const item = selectedItem()
    if (section() === "commits" && item) {
      Clipboard.copy((item as CommitRow).fullHash)
        .then(() => toast.show({ message: "Copied hash", variant: "info" }))
        .catch(toast.error)
    }
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
        setFilterText((t) => t.slice(0, -1))
        return
      }
      if (!evt.ctrl && !evt.meta && !evt.super && evt.name && evt.name.length === 1) {
        evt.preventDefault()
        setFilterText((t) => t + evt.name)
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
      setSelected(Math.max(0, visibleItems().length - 1))
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
    if (isPlainShortcut(evt, "c")) {
      evt.preventDefault()
      if (section() === "branches") actionCreateBranch()
      else if (section() === "prs") actionCreatePR()
      else if (section() === "issues") actionCreateIssue()
      else actionCreateCommit()
      return
    }
    if (isPlainShortcut(evt, "o")) {
      evt.preventDefault()
      actionOpenInBrowser()
      return
    }
    if (isPlainShortcut(evt, "y")) {
      evt.preventDefault()
      actionCopyHash()
      return
    }
    if (isPlainShortcut(evt, "l")) {
      evt.preventDefault()
      if (section() === "branches") actionSwitchBranch()
      return
    }
    if (isPlainShortcut(evt, "d")) {
      evt.preventDefault()
      if (section() === "branches") actionDeleteBranch()
      return
    }
    if (isPlainShortcut(evt, "m")) {
      evt.preventDefault()
      if (section() === "prs") actionMergePR()
      return
    }
    if (isPlainShortcut(evt, "x")) {
      evt.preventDefault()
      if (section() === "prs") actionClosePR()
      else if (section() === "issues") actionCloseIssue()
      return
    }
    // `tab` belongs to the workspace shell, which cycles the outer panels — the
    // sections move on `[` / `]` so both levels stay reachable from the keyboard.
    if (isPlainShortcut(evt, "[", "]")) {
      evt.preventDefault()
      const tabs = sectionItems()
      const idx = tabs.findIndex((t) => t.id === section())
      const next = evt.name === "]" ? (idx + 1) % tabs.length : (idx - 1 + tabs.length) % tabs.length
      setSection(tabs[next].id)
      setSelected(0)
      return
    }
  })

  const badge = () => {
    switch (section()) {
      case "branches":
        return "BRANCH"
      case "commits":
        return "COMMIT"
      case "prs":
        return "PULLS"
      case "issues":
        return "ISSUE"
    }
  }
  const badgeFg = () => {
    switch (section()) {
      case "branches":
        return theme.status.warning.fg
      case "commits":
        return theme.accent.fg
      case "prs":
        return theme.status.info.fg
      case "issues":
        return theme.status.success.fg
      default:
        return theme.foreground.muted
    }
  }

  return (
    <box width="100%" height="100%" flexDirection="column" backgroundColor={theme.surface.base}>
      {/* Header */}
      <box flexShrink={0} border={["bottom"]} borderColor={theme.border.subtle} backgroundColor={theme.surface.panel}>
        <box paddingLeft={2} paddingRight={2} paddingTop={1} paddingBottom={1} flexDirection="column" gap={0}>
          <box flexDirection="row" justifyContent="space-between" alignItems="center" width="100%" gap={1}>
            <box
              flexDirection="row"
              gap={0}
              alignItems="baseline"
              flexGrow={1}
              flexShrink={1}
              minWidth={0}
              overflow="hidden"
            >
              <text fg={theme.foreground.muted} attributes={TextAttributes.DIM} wrapMode="none">
                Git
              </text>
              <text fg={theme.accent.fg} attributes={TextAttributes.BOLD} wrapMode="none">
                {"Hub"}
              </text>
              <text fg={theme.foreground.muted} attributes={TextAttributes.DIM} wrapMode="none">
                {"  ·  "}
              </text>
              <text
                fg={theme.foreground.default}
                attributes={TextAttributes.DIM}
                wrapMode="word"
                flexGrow={1}
                minWidth={0}
              >
                {state()?.repo ?? shortDir(directory())}
              </text>
            </box>
            <box
              paddingLeft={1}
              paddingRight={1}
              paddingTop={0}
              paddingBottom={0}
              backgroundColor={theme.surface.offset}
              border={["top", "right", "bottom", "left"]}
              borderColor={theme.border.subtle}
              flexShrink={0}
            >
              <text fg={badgeFg()} attributes={TextAttributes.BOLD} wrapMode="none">
                {badge()}
              </text>
            </box>
          </box>
          <box
            flexDirection="row"
            justifyContent="space-between"
            alignItems="center"
            width="100%"
            paddingTop={0}
            gap={1}
          >
            <text fg={theme.foreground.muted} attributes={TextAttributes.DIM} wrapMode="none">
              {state()?.currentBranch ?? "—"}
            </text>
            <box flexDirection="row" gap={1} flexShrink={0} alignItems="center">
              <text fg={theme.foreground.muted} attributes={TextAttributes.DIM} wrapMode="none">
                {state()
                  ? `${state()!.branches.length} br · ${state()!.prs.length} pr · ${state()!.issues.length} issue`
                  : ""}
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

      {/* Tab bar */}
      <box
        flexShrink={0}
        border={["bottom"]}
        borderColor={theme.border.subtle}
        flexDirection="row"
        paddingLeft={1}
        paddingRight={1}
      >
        <For each={sectionItems()}>
          {(tab) => (
            <box
              paddingLeft={2}
              paddingRight={2}
              paddingTop={0}
              paddingBottom={0}
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
              <text fg={theme.foreground.muted} wrapMode="none">
                {` ${tab.count}`}
              </text>
            </box>
          )}
        </For>
      </box>

      {/* Content */}
      <box flexDirection="row" flexGrow={1} minHeight={0}>
        {/* Left panel */}
        <box
          width={SIDE_WIDTH}
          minWidth={SIDE_WIDTH}
          border={["right"]}
          borderColor={theme.border.subtle}
          flexDirection="column"
          minHeight={0}
        >
          <Show
            when={!state.loading && state() && visibleItems().length > 0}
            fallback={
              <box flexGrow={1} alignItems="center" justifyContent="center" paddingLeft={1} paddingRight={1}>
                <text
                  fg={state()?.error ? theme.status.error.fg : theme.foreground.muted}
                  attributes={TextAttributes.DIM}
                  wrapMode="word"
                >
                  {state.loading
                    ? "Loading..."
                    : (state()?.error ?? filterText())
                      ? `No ${section()} match`
                      : `No ${section()}`}
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
              <For each={visibleItems()}>
                {(item: any, index) => {
                  const isSelected = () => selected() === index()
                  return (
                    <box
                      id={rowID(index())}
                      width="100%"
                      height={1}
                      backgroundColor={isSelected() ? theme.surface.offset : undefined}
                      onMouseDown={() => setSelected(index())}
                    >
                      <box width={1} minWidth={1} backgroundColor={isSelected() ? theme.accent.fg : undefined} />
                      <box flexGrow={1} minWidth={0} overflow="hidden" paddingLeft={1} paddingRight={0}>
                        <Show when={section() === "branches"}>
                          <box flexDirection="row" gap={1}>
                            <text fg={isSelected() ? theme.accent.fg : theme.foreground.muted} wrapMode="none">
                              {item.current ? "●" : "○"}
                            </text>
                            <text
                              fg={theme.foreground.default}
                              attributes={isSelected() ? TextAttributes.BOLD : undefined}
                              wrapMode="none"
                              maxWidth={SIDE_WIDTH - 5}
                            >
                              {truncate(item.name, SIDE_WIDTH - 5)}
                            </text>
                          </box>
                        </Show>
                        <Show when={section() === "commits"}>
                          <box flexDirection="row" gap={0}>
                            <text
                              fg={item.graph?.includes("*") ? theme.accent.fg : theme.foreground.muted}
                              wrapMode="none"
                              minWidth={3}
                            >
                              {item.graph?.includes("*") ? "•" : "·"}
                            </text>
                            <text fg={theme.status.warning.fg} wrapMode="none" minWidth={7}>
                              {item.prNumber ? `#${item.prNumber}` : truncate(item.hash, 7)}
                            </text>
                            <text
                              fg={theme.foreground.default}
                              attributes={isSelected() ? TextAttributes.BOLD : undefined}
                              wrapMode="none"
                              maxWidth={SIDE_WIDTH - 13}
                            >
                              {truncate(item.subject, SIDE_WIDTH - 13)}
                            </text>
                          </box>
                          <text fg={theme.foreground.muted} attributes={TextAttributes.DIM} wrapMode="none">
                            {item.relativeDate}
                          </text>
                        </Show>
                        <Show when={section() === "prs"}>
                          <box flexDirection="row" gap={1}>
                            <text
                              fg={
                                item.draft
                                  ? theme.foreground.muted
                                  : item.state === "OPEN"
                                    ? theme.status.success.fg
                                    : item.state === "CLOSED"
                                      ? theme.status.error.fg
                                      : theme.status.warning.fg
                              }
                              attributes={TextAttributes.BOLD}
                              wrapMode="none"
                            >
                              {item.state === "OPEN" ? "○" : item.state === "CLOSED" ? "●" : "◐"}
                            </text>
                            <text fg={theme.status.warning.fg} wrapMode="none">
                              #{item.number}
                            </text>
                            <text
                              fg={theme.foreground.default}
                              attributes={isSelected() ? TextAttributes.BOLD : undefined}
                              wrapMode="none"
                              maxWidth={SIDE_WIDTH - 7}
                            >
                              {truncate(item.title, SIDE_WIDTH - 7)}
                            </text>
                          </box>
                          <text fg={theme.foreground.muted} attributes={TextAttributes.DIM} wrapMode="none">
                            {item.author} · {item.head}
                          </text>
                        </Show>
                        <Show when={section() === "issues"}>
                          <box flexDirection="row" gap={1}>
                            <text
                              fg={item.state === "OPEN" ? theme.status.success.fg : theme.status.error.fg}
                              attributes={TextAttributes.BOLD}
                              wrapMode="none"
                            >
                              {item.state === "OPEN" ? "○" : "●"}
                            </text>
                            <text fg={theme.status.warning.fg} wrapMode="none">
                              #{item.number}
                            </text>
                            <text
                              fg={theme.foreground.default}
                              attributes={isSelected() ? TextAttributes.BOLD : undefined}
                              wrapMode="none"
                              maxWidth={SIDE_WIDTH - 7}
                            >
                              {truncate(item.title, SIDE_WIDTH - 7)}
                            </text>
                          </box>
                          <text fg={theme.foreground.muted} attributes={TextAttributes.DIM} wrapMode="none">
                            {item.author}
                            {item.labels.length > 0 ? ` · ${truncate(item.labels.join(", "), 16)}` : ""}
                          </text>
                        </Show>
                      </box>
                    </box>
                  )
                }}
              </For>
            </scrollbox>
          </Show>
        </box>

        {/* Right detail panel */}
        <box
          flexGrow={1}
          flexDirection="column"
          paddingLeft={2}
          paddingRight={2}
          paddingTop={1}
          paddingBottom={1}
          minHeight={0}
        >
          <Show
            when={selectedItem()}
            fallback={
              <box flexGrow={1} alignItems="center" justifyContent="center">
                <text fg={theme.foreground.muted} attributes={TextAttributes.DIM} wrapMode="word">
                  Select a {section().replace(/s$/, "")} to view details
                </text>
              </box>
            }
          >
            {(item) => (
              <scrollbox scrollAcceleration={scrollAcceleration()} flexGrow={1} scrollbarOptions={{ visible: false }}>
                <box flexDirection="column" gap={1}>
                  <Show when={section() === "branches"}>
                    <box
                      border={["bottom"]}
                      borderColor={theme.border.subtle}
                      paddingBottom={1}
                      flexDirection="column"
                      gap={0}
                    >
                      <text fg={theme.accent.fg} attributes={TextAttributes.BOLD} wrapMode="word">
                        {(item() as Branch).name}
                      </text>
                      <text fg={theme.foreground.muted} attributes={TextAttributes.DIM} wrapMode="none">
                        {(item() as Branch).current ? "Current branch" : "Switch to branch"}
                      </text>
                      <Show when={!(item() as Branch).current}>
                        <text fg={theme.foreground.muted} wrapMode="none">
                          Press l to switch, d to delete
                        </text>
                      </Show>
                    </box>
                    <box flexDirection="column" gap={0}>
                      <text fg={theme.status.warning.fg} attributes={TextAttributes.BOLD} wrapMode="none">
                        Actions
                      </text>
                      <text fg={theme.foreground.muted} wrapMode="word">
                        c · create branch | l · switch | d · delete | o · open
                      </text>
                    </box>
                  </Show>
                  <Show when={section() === "commits"}>
                    <box
                      border={["bottom"]}
                      borderColor={theme.border.subtle}
                      paddingBottom={1}
                      flexDirection="column"
                      gap={0}
                    >
                      <box flexDirection="row" gap={2}>
                        <text fg={theme.status.warning.fg} wrapMode="none">
                          {selectedItem().hash}
                        </text>
                        <text fg={theme.foreground.muted} attributes={TextAttributes.DIM} wrapMode="none">
                          {initials(selectedItem().author)}
                        </text>
                        <text fg={theme.foreground.muted} attributes={TextAttributes.DIM} wrapMode="none">
                          {selectedItem().relativeDate}
                        </text>
                      </box>
                      <text fg={theme.foreground.default} attributes={TextAttributes.BOLD} wrapMode="word">
                        {selectedItem().subject}
                      </text>
                      <text fg={theme.foreground.muted} attributes={TextAttributes.DIM} wrapMode="none">
                        {selectedItem().fullHash}
                      </text>
                      <text fg={theme.foreground.muted} attributes={TextAttributes.DIM} wrapMode="none">
                        {selectedItem().author} · {selectedItem().date}
                      </text>
                      <box flexDirection="row" gap={1} paddingTop={0}>
                        <text fg={theme.foreground.muted} wrapMode="word">
                          o · open in browser | y · copy hash
                        </text>
                      </box>
                    </box>
                  </Show>
                  <Show when={section() === "prs"}>
                    <box
                      border={["bottom"]}
                      borderColor={theme.border.subtle}
                      paddingBottom={1}
                      flexDirection="column"
                      gap={0}
                    >
                      <box flexDirection="row" justifyContent="space-between">
                        <box flexDirection="row" gap={1}>
                          <text fg={theme.status.warning.fg} wrapMode="none">
                            #{selectedItem().number}
                          </text>
                          <text
                            fg={
                              selectedItem().draft
                                ? theme.foreground.muted
                                : selectedItem().state === "OPEN"
                                  ? theme.status.success.fg
                                  : selectedItem().state === "CLOSED"
                                    ? theme.status.error.fg
                                    : theme.status.warning.fg
                            }
                            attributes={TextAttributes.BOLD}
                            wrapMode="none"
                          >
                            {selectedItem().state}
                          </text>
                          <text
                            fg={
                              selectedItem().checksPassed
                                ? theme.status.success.fg
                                : selectedItem().checksPassed === false
                                  ? theme.status.error.fg
                                  : theme.foreground.muted
                            }
                            wrapMode="none"
                          >
                            {selectedItem().checksPassed
                              ? "✓ checks"
                              : selectedItem().checksPassed === false
                                ? "✗ checks"
                                : ""}
                          </text>
                        </box>
                        <box flexDirection="row" gap={1}>
                          <text fg={theme.status.success.fg} wrapMode="none">
                            +{selectedItem().additions}
                          </text>
                          <text fg={theme.status.error.fg} wrapMode="none">
                            -{selectedItem().deletions}
                          </text>
                        </box>
                      </box>
                      <text fg={theme.foreground.default} attributes={TextAttributes.BOLD} wrapMode="word">
                        {selectedItem().title}
                      </text>
                      <text fg={theme.foreground.muted} attributes={TextAttributes.DIM} wrapMode="none">
                        {selectedItem().author} {selectedItem().head} → {selectedItem().base}
                      </text>
                      <box flexDirection="row" gap={1} paddingTop={0}>
                        <text fg={theme.foreground.muted} wrapMode="word">
                          o · open | m · merge | x · close
                        </text>
                      </box>
                    </box>
                  </Show>
                  <Show when={section() === "issues"}>
                    <box
                      border={["bottom"]}
                      borderColor={theme.border.subtle}
                      paddingBottom={1}
                      flexDirection="column"
                      gap={0}
                    >
                      <box flexDirection="row" justifyContent="space-between">
                        <box flexDirection="row" gap={1}>
                          <text fg={theme.status.warning.fg} wrapMode="none">
                            #{selectedItem().number}
                          </text>
                          <text
                            fg={selectedItem().state === "OPEN" ? theme.status.success.fg : theme.status.error.fg}
                            attributes={TextAttributes.BOLD}
                            wrapMode="none"
                          >
                            {selectedItem().state}
                          </text>
                        </box>
                      </box>
                      <text fg={theme.foreground.default} attributes={TextAttributes.BOLD} wrapMode="word">
                        {selectedItem().title}
                      </text>
                      <text fg={theme.foreground.muted} attributes={TextAttributes.DIM} wrapMode="none">
                        {selectedItem().author}
                        {selectedItem().assignees.length > 0
                          ? ` · assigned: ${selectedItem().assignees.join(", ")}`
                          : ""}
                      </text>
                      <Show when={selectedItem().labels.length > 0}>
                        <box flexDirection="row" gap={1} flexWrap="wrap">
                          <For each={selectedItem().labels.slice(0, 6)}>
                            {(label: string) => (
                              <box paddingLeft={1} paddingRight={1} backgroundColor={theme.surface.offset}>
                                <text fg={theme.foreground.default} wrapMode="none">
                                  {label}
                                </text>
                              </box>
                            )}
                          </For>
                        </box>
                      </Show>
                      <box flexDirection="row" gap={1} paddingTop={0}>
                        <text fg={theme.foreground.muted} wrapMode="word">
                          o · open | x · close
                        </text>
                      </box>
                    </box>
                  </Show>
                </box>
              </scrollbox>
            )}
          </Show>
        </box>
      </box>

      {/* Footer */}
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
              GitHub
            </text>
            <FooterSep />
            <FooterHint keys="j · k" label="move" />
            <FooterSep />
            <FooterHint keys="/ · f" label="search" />
            <FooterSep />
            <FooterHint keys="c" label={`new ${section().replace(/s$/, "")}`} />
            <FooterSep />
            <FooterHint keys="o" label="open" />
            <FooterSep />
            <FooterHint keys="[ · ]" label="section" />
            <FooterSep />
            <FooterHint keys="r" label="refresh" />
            <FooterSep />
            <FooterHint keys="g/G" label="top/end" />
          </box>
          <box flexDirection="row" gap={2}>
            <text fg={theme.foreground.muted} wrapMode="none">
              {`[${Math.min(selected() + 1, Math.max(1, visibleItems().length))}/${Math.max(1, visibleItems().length)}]`}
            </text>
            <FooterHint keys="esc" label={filterText() ? "clear" : "back"} />
          </box>
        </box>
      </box>
    </box>
  )
}
