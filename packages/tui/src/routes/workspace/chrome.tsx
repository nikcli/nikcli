import { Show } from "solid-js"
import { TextAttributes, type RGBA } from "@opentui/core"
import { isRunning, runIcon, runTone, type RunTone, type WorkflowRun } from "@tui/routes/actions/ci"
import { dirtyCount, formatAheadBehind, type RepoStatus } from "./repo-status"

/**
 * The workspace chrome: the tab row and the repository strip under it.
 *
 * Split out of the panel, and taking its colours as a prop rather than from the
 * theme context, so both rows can be painted in a bare `testRender`. They carry
 * the state a glance is supposed to answer — which tab, which branch, how dirty,
 * is CI green — and that is exactly the kind of thing that rots silently.
 */

/** The theme tokens the chrome paints with; `Theme` satisfies it structurally. */
export type ChromeTheme = {
  surface: { panel: RGBA; offset: RGBA }
  foreground: { default: RGBA; muted: RGBA; subtle: RGBA }
  accent: { fg: RGBA }
  status: {
    success: { fg: RGBA }
    error: { fg: RGBA }
    warning: { fg: RGBA }
    info: { fg: RGBA }
  }
  border: { subtle: RGBA }
}

export type WorkspaceTab = "tree" | "changes" | "graph" | "github" | "actions"

export const WORKSPACE_TABS: Array<{ id: WorkspaceTab; label: string; key: string }> = [
  { id: "tree", label: "Sessions", key: "1" },
  { id: "changes", label: "Changes", key: "2" },
  { id: "graph", label: "Graph", key: "3" },
  { id: "github", label: "GitHub", key: "4" },
  { id: "actions", label: "Actions", key: "5" },
]

export function WorkspaceTabBar(props: {
  theme: ChromeTheme
  active: WorkspaceTab
  onSelect: (tab: WorkspaceTab) => void
  dirty: () => number
  ciTone: () => RunTone | undefined
}) {
  const theme = props.theme
  const toneColor = (tone: RunTone | undefined): RGBA | undefined => {
    switch (tone) {
      case "success":
        return theme.status.success.fg
      case "failure":
        return theme.status.error.fg
      case "running":
        return theme.accent.fg
      case "pending":
        return theme.status.warning.fg
      default:
        return undefined
    }
  }

  return (
    <box
      flexDirection="row"
      paddingLeft={1}
      paddingRight={1}
      gap={1}
      flexShrink={0}
      backgroundColor={theme.surface.panel}
      border={["bottom"]}
      borderColor={theme.border.subtle}
    >
      {WORKSPACE_TABS.map((tab) => {
        const isActive = () => props.active === tab.id
        // A count only earns its place when it is non-zero: a permanent " 0"
        // next to every label is noise the eye learns to skip, which is exactly
        // how a red CI dot would get missed too.
        const badge = () => {
          if (tab.id === "changes" && props.dirty() > 0)
            // The bullet keeps the count from reading as part of the tab's own
            // number key: "Changes 2 12" is a puzzle, "Changes 2 ●12" is not.
            return { text: `●${props.dirty()}`, fg: theme.status.warning.fg }
          if (tab.id === "actions") {
            const tone = props.ciTone()
            if (tone) return { text: runIcon(tone), fg: toneColor(tone) ?? theme.foreground.muted }
          }
          return undefined
        }
        return (
          <box
            paddingLeft={1}
            paddingRight={1}
            flexDirection="row"
            gap={1}
            alignItems="center"
            onMouseDown={() => props.onSelect(tab.id)}
            backgroundColor={isActive() ? theme.surface.offset : undefined}
          >
            <text
              fg={isActive() ? theme.accent.fg : theme.foreground.muted}
              attributes={isActive() ? TextAttributes.BOLD : TextAttributes.DIM}
              wrapMode="none"
            >
              {tab.label}
              <span style={{ fg: theme.foreground.subtle }}>{` ${tab.key}`}</span>
            </text>
            <Show when={badge()}>
              {(value) => (
                <text fg={value().fg} attributes={TextAttributes.BOLD} wrapMode="none">
                  {value().text}
                </text>
              )}
            </Show>
          </box>
        )
      })}
      <box flexGrow={1} />
      <text fg={theme.foreground.muted} attributes={TextAttributes.DIM} wrapMode="none">
        tab · cycle
      </text>
      <text fg={theme.border.subtle} wrapMode="none">
        │
      </text>
      <text fg={theme.foreground.default} attributes={TextAttributes.BOLD} wrapMode="none">
        .
      </text>
      <text fg={theme.foreground.muted} attributes={TextAttributes.DIM} wrapMode="none">
        actions
      </text>
      <text fg={theme.border.subtle} wrapMode="none">
        │
      </text>
      <text fg={theme.foreground.muted} attributes={TextAttributes.DIM} wrapMode="none">
        esc · back
      </text>
    </box>
  )
}

/**
 * One line of repository context above every panel.
 *
 * Each panel answered a different question and none answered "where am I":
 * which branch, how far it has drifted from its upstream, how much is
 * uncommitted, and whether CI is green. That is the line the action menu acts
 * on, so it sits directly above it.
 */
export function RepoStrip(props: {
  theme: ChromeTheme
  status: RepoStatus | undefined
  loading: boolean
  run: WorkflowRun | undefined
  onActions: () => void
}) {
  const theme = props.theme
  const drift = () => (props.status ? formatAheadBehind(props.status.ahead, props.status.behind) : "")
  const dirty = () => props.status?.dirty
  const runLabel = () => {
    const run = props.run
    if (!run) return undefined
    const tone = runTone(run)
    const color =
      tone === "success"
        ? theme.status.success.fg
        : tone === "failure"
          ? theme.status.error.fg
          : tone === "running"
            ? theme.accent.fg
            : tone === "pending"
              ? theme.status.warning.fg
              : theme.foreground.muted
    return { icon: runIcon(tone), color, text: isRunning(run) ? run.workflow : run.conclusion || run.status }
  }

  return (
    <box
      flexDirection="row"
      alignItems="center"
      gap={1}
      paddingLeft={2}
      paddingRight={2}
      flexShrink={0}
      width="100%"
      border={["bottom"]}
      borderColor={theme.border.subtle}
      onMouseDown={() => props.onActions()}
    >
      <Show
        when={props.status && !props.status.error ? props.status : undefined}
        fallback={
          <text fg={theme.foreground.muted} attributes={TextAttributes.DIM} wrapMode="none">
            {props.loading ? "reading repository…" : (props.status?.error ?? "not a git repository")}
          </text>
        }
      >
        {(repo) => (
          <>
            <text fg={theme.foreground.muted} attributes={TextAttributes.DIM} wrapMode="none">
              {repo().name}
            </text>
            <text fg={theme.border.subtle} wrapMode="none">
              │
            </text>
            <text
              fg={repo().detached ? theme.status.warning.fg : theme.accent.fg}
              attributes={TextAttributes.BOLD}
              wrapMode="none"
            >
              {repo().branch}
            </text>
            <Show when={drift()}>
              <text fg={theme.status.info.fg} wrapMode="none">
                {drift()}
              </text>
            </Show>
            <Show when={!repo().upstream && !repo().detached}>
              <text fg={theme.foreground.subtle} attributes={TextAttributes.DIM} wrapMode="none">
                no upstream
              </text>
            </Show>
            <Show
              when={dirty() && dirtyCount(dirty()!) > 0}
              fallback={
                <text fg={theme.foreground.subtle} attributes={TextAttributes.DIM} wrapMode="none">
                  clean
                </text>
              }
            >
              <box flexDirection="row" gap={1}>
                <Show when={dirty()!.conflicts > 0}>
                  <text fg={theme.status.error.fg} wrapMode="none">{`!${dirty()!.conflicts}`}</text>
                </Show>
                <Show when={dirty()!.staged > 0}>
                  <text fg={theme.status.success.fg} wrapMode="none">{`+${dirty()!.staged}`}</text>
                </Show>
                <Show when={dirty()!.unstaged > 0}>
                  <text fg={theme.status.warning.fg} wrapMode="none">{`~${dirty()!.unstaged}`}</text>
                </Show>
                <Show when={dirty()!.untracked > 0}>
                  <text fg={theme.foreground.muted} wrapMode="none">{`?${dirty()!.untracked}`}</text>
                </Show>
              </box>
            </Show>
            <Show when={repo().stashes > 0}>
              <text fg={theme.foreground.muted} attributes={TextAttributes.DIM} wrapMode="none">
                {`⌂${repo().stashes}`}
              </text>
            </Show>
            <box flexGrow={1} minWidth={0} />
            <Show when={runLabel()}>
              {(value) => (
                <box flexDirection="row" gap={1} alignItems="center">
                  <text fg={value().color} attributes={TextAttributes.BOLD} wrapMode="none">
                    {value().icon}
                  </text>
                  <text fg={theme.foreground.muted} attributes={TextAttributes.DIM} wrapMode="none">
                    {value().text}
                  </text>
                </box>
              )}
            </Show>
            <Show when={repo().lastCommit}>
              {(commit) => (
                <>
                  <text fg={theme.border.subtle} wrapMode="none">
                    │
                  </text>
                  <text fg={theme.foreground.subtle} attributes={TextAttributes.DIM} wrapMode="none">
                    {`${commit().hash} ${commit().relative}`}
                  </text>
                </>
              )}
            </Show>
          </>
        )}
      </Show>
    </box>
  )
}
