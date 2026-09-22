import { describe, expect, test } from "bun:test"
import { RGBA, type CapturedFrame } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { RepoStrip, WorkspaceTabBar, type ChromeTheme } from "@tui/routes/workspace/chrome"
import type { RepoStatus } from "@tui/routes/workspace/repo-status"
import type { WorkflowRun } from "@tui/routes/actions/ci"

const WHITE = RGBA.fromInts(255, 255, 255, 255)
const GREY = RGBA.fromInts(140, 140, 140, 255)
const DIM = RGBA.fromInts(90, 90, 90, 255)
const CYAN = RGBA.fromInts(0, 200, 200, 255)
const GREEN = RGBA.fromInts(0, 200, 0, 255)
const RED = RGBA.fromInts(220, 0, 0, 255)
const YELLOW = RGBA.fromInts(220, 200, 0, 255)
const BLUE = RGBA.fromInts(0, 120, 215, 255)
const PANEL = RGBA.fromInts(20, 20, 20, 255)
const OFFSET = RGBA.fromInts(40, 40, 40, 255)

const theme: ChromeTheme = {
  surface: { panel: PANEL, offset: OFFSET },
  foreground: { default: WHITE, muted: GREY, subtle: DIM },
  accent: { fg: CYAN },
  status: { success: { fg: GREEN }, error: { fg: RED }, warning: { fg: YELLOW }, info: { fg: BLUE } },
  border: { subtle: DIM },
}

const STATUS: RepoStatus = {
  directory: "/repo",
  name: "nikcli/nikcli",
  slug: "nikcli/nikcli",
  remoteUrl: "git@github.com:nikcli/nikcli.git",
  branch: "live-main",
  detached: false,
  upstream: "origin/live-main",
  ahead: 3,
  behind: 1,
  stashes: 2,
  dirty: { staged: 1, unstaged: 2, untracked: 4, conflicts: 0 },
  lastCommit: { hash: "5fff578", subject: "refactor(tests)", relative: "2 hours ago" },
}

function paint(captureSpans: () => CapturedFrame) {
  return captureSpans()
    .lines.map((line) =>
      line.spans
        .map((span) => span.text)
        .join("")
        .replace(/\s+$/, ""),
    )
    .join("\n")
}

/** Every span that carries `text`, so a colour can be asserted per token. */
function spanColor(captureSpans: () => CapturedFrame, text: string) {
  for (const line of captureSpans().lines) {
    for (const span of line.spans) {
      if (span.text.includes(text)) return span.fg
    }
  }
  return undefined
}

function sameColor(a: { r: number; g: number; b: number } | undefined, b: RGBA) {
  if (!a) return false
  return Math.round(a.r * 255) === Math.round(b.r * 255) && Math.round(a.g * 255) === Math.round(b.g * 255)
}

describe("<WorkspaceTabBar>", () => {
  async function mount(input: { active?: "tree" | "actions"; dirty?: number; ciTone?: "success" | "failure" } = {}) {
    const rendered = await testRender(
      () => (
        <box width={120} height={3}>
          <WorkspaceTabBar
            theme={theme}
            active={input.active ?? "tree"}
            onSelect={() => {}}
            dirty={() => input.dirty ?? 0}
            ciTone={() => input.ciTone}
          />
        </box>
      ),
      { width: 120, height: 3 },
    )
    await rendered.renderOnce()
    return rendered
  }

  test("paints all five tabs with their number keys", async () => {
    const { captureSpans } = await mount()
    const screen = paint(captureSpans)
    for (const [label, key] of [
      ["Sessions", "1"],
      ["Changes", "2"],
      ["Graph", "3"],
      ["GitHub", "4"],
      ["Actions", "5"],
    ]) {
      expect(screen).toContain(`${label} ${key}`)
    }
  })

  test("advertises the repository action key", async () => {
    const { captureSpans } = await mount()
    const screen = paint(captureSpans)
    expect(screen).toContain("actions")
    expect(screen).toContain("tab · cycle")
    expect(screen).toContain("esc · back")
  })

  test("badges Changes only while the tree is dirty", async () => {
    expect(paint((await mount({ dirty: 0 })).captureSpans)).toContain("Changes 2")
    expect(paint((await mount({ dirty: 7 })).captureSpans)).toContain("7")
  })

  test("shows a red mark on the Actions tab when CI failed", async () => {
    const { captureSpans } = await mount({ ciTone: "failure" })
    expect(paint(captureSpans)).toContain("✗")
    expect(sameColor(spanColor(captureSpans, "✗"), RED)).toBe(true)
  })

  test("shows nothing on the Actions tab before CI is known", async () => {
    expect(paint((await mount()).captureSpans)).not.toContain("✗")
  })
})

describe("<RepoStrip>", () => {
  async function mount(input: { status?: RepoStatus; loading?: boolean; run?: WorkflowRun } = {}) {
    const rendered = await testRender(
      () => (
        <box width={150} height={2}>
          <RepoStrip
            theme={theme}
            status={input.status}
            loading={input.loading ?? false}
            run={input.run}
            onActions={() => {}}
          />
        </box>
      ),
      { width: 150, height: 2 },
    )
    await rendered.renderOnce()
    return rendered
  }

  test("answers branch, drift, dirtiness and stash count in one line", async () => {
    const { captureSpans } = await mount({ status: STATUS })
    const screen = paint(captureSpans)
    expect(screen).toContain("nikcli/nikcli")
    expect(screen).toContain("live-main")
    expect(screen).toContain("↑3")
    expect(screen).toContain("↓1")
    expect(screen).toContain("+1")
    expect(screen).toContain("~2")
    expect(screen).toContain("?4")
    expect(screen).toContain("⌂2")
    expect(screen).toContain("5fff578")
  })

  test("says clean rather than printing four zeroes", async () => {
    const { captureSpans } = await mount({
      status: { ...STATUS, dirty: { staged: 0, unstaged: 0, untracked: 0, conflicts: 0 }, stashes: 0 },
    })
    const screen = paint(captureSpans)
    expect(screen).toContain("clean")
    expect(screen).not.toContain("+0")
  })

  test("calls out a branch with no upstream", async () => {
    const { captureSpans } = await mount({ status: { ...STATUS, upstream: undefined, ahead: 0, behind: 0 } })
    expect(paint(captureSpans)).toContain("no upstream")
  })

  test("marks a detached head in the warning colour", async () => {
    const { captureSpans } = await mount({
      status: { ...STATUS, detached: true, branch: "detached", upstream: undefined },
    })
    expect(sameColor(spanColor(captureSpans, "detached"), YELLOW)).toBe(true)
  })

  test("falls back to the git error, then to loading", async () => {
    expect(
      paint((await mount({ status: { ...STATUS, error: "fatal: not a git repository" } })).captureSpans),
    ).toContain("fatal: not a git repository")
    expect(paint((await mount({ loading: true })).captureSpans)).toContain("reading repository…")
  })

  test("shows the workflow name while CI runs and the conclusion once it stops", async () => {
    const running: WorkflowRun = {
      id: 1,
      number: 9,
      attempt: 1,
      workflow: "CI",
      title: "fix",
      branch: "live-main",
      event: "push",
      status: "in_progress",
      conclusion: "",
      url: "",
      createdAt: "",
      startedAt: "",
      updatedAt: "",
    }
    expect(paint((await mount({ status: STATUS, run: running })).captureSpans)).toContain("CI")
    const done = { ...running, status: "completed", conclusion: "success" }
    const { captureSpans } = await mount({ status: STATUS, run: done })
    expect(paint(captureSpans)).toContain("success")
    expect(sameColor(spanColor(captureSpans, "✓"), GREEN)).toBe(true)
  })
})
