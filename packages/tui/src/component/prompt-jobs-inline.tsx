/**
 * Unified inline jobs/monitors display for the prompt bottom bar.
 * Single-line compact display that opens the full background dialog on click.
 */

import { createMemo, Show } from "solid-js"
import { useTheme } from "@tui/context/theme"
import { DISCLOSURE } from "@tui/component/disclosure"
import { useKV } from "@tui/context/kv"
import { getBackgroundDismissed } from "../util/background"
import { type MonitorInfo } from "../util/monitor-helpers"
import { Spinner } from "./spinner"
import { useCommandDialog } from "./dialog-command"
import { useRenderer, useTerminalDimensions } from "@opentui/solid"
import { Locale } from "@nikcli-ai/util/locale"
import { type JobItem } from "./prompt-frames"
export type { JobItem }

export type PromptJobsInlineProps = {
  sessionID: string
  jobs: JobItem[]
  monitors: MonitorInfo[]
  onOpenBgAgents?: () => void
}

function isActiveStatus(status: string): boolean {
  return status === "running" || status === "synthesizing"
}

function formatStatus(status: string): string {
  switch (status) {
    case "running":
      return "running"
    case "synthesizing":
      return "syncing"
    case "complete":
      return "done"
    case "error":
      return "error"
    case "timeout":
      return "timeout"
    case "cancelled":
      return "cancelled"
    default:
      return status
  }
}

function countLabel(total: number, active: number): string {
  if (active > 0 && active !== total) return `${active}/${total}`
  return String(total)
}

function latestJob(jobs: JobItem[]): JobItem | undefined {
  return [...jobs].sort((a, b) => b.updatedAt - a.updatedAt)[0]
}

function latestMonitor(monitors: MonitorInfo[]): MonitorInfo | undefined {
  return monitors[0]
}

/**
 * Compact inline jobs/monitors display - returns row elements for embedding.
 */
export function PromptJobsInlineCompact(props: PromptJobsInlineProps) {
  const { theme } = useTheme()
  const kv = useKV()
  const command = useCommandDialog()
  const dimensions = useTerminalDimensions()

  const activeJobs = createMemo(() => props.jobs.filter((j) => isActiveStatus(j.status)))
  const activeMonitors = createMemo(() => props.monitors.filter((m) => m.status === "running"))

  const renderer = useRenderer()
  const dismissed = createMemo(() => getBackgroundDismissed(kv, props.sessionID))
  const visibleJobs = createMemo(() => props.jobs.filter((job) => !dismissed().has(job.rootDelegationID)))

  const hasActiveJobs = createMemo(() => activeJobs().length > 0)
  const hasActiveMonitors = createMemo(() => activeMonitors().length > 0)
  const hasAnyItems = createMemo(() => visibleJobs().length > 0 || props.monitors.length > 0)
  const active = createMemo(() => hasActiveJobs() || hasActiveMonitors())
  const tight = createMemo(() => dimensions().width < 88)
  const roomy = createMemo(() => dimensions().width >= 118)
  const jobFocus = createMemo(() => latestJob(activeJobs()) ?? latestJob(visibleJobs()))
  const monitorFocus = createMemo(() => latestMonitor(activeMonitors()) ?? latestMonitor(props.monitors))
  const jobsLabel = createMemo(() => countLabel(visibleJobs().length, activeJobs().length))
  const monitorsLabel = createMemo(() => countLabel(props.monitors.length, activeMonitors().length))
  const jobSummary = createMemo(() => {
    const job = jobFocus()
    if (!job || tight()) return ""
    const agent = Locale.truncateMiddle(job.agent, roomy() ? 14 : 9)
    const title = Locale.truncateMiddle(job.title, roomy() ? 28 : 16)
    return `${formatStatus(job.status)} @${agent}${roomy() ? ` ${title}` : ""}`
  })
  const monitorSummary = createMemo(() => {
    const monitor = monitorFocus()
    if (!monitor || tight()) return ""
    const title = Locale.truncateMiddle(monitor.title, roomy() ? 26 : 14)
    return `${formatStatus(monitor.status)} ${title}`
  })

  function openBgAgents(event: { stopPropagation: () => void }) {
    event.stopPropagation()
    if (props.onOpenBgAgents) {
      props.onOpenBgAgents()
    } else {
      command.trigger("session.bg_agents")
    }
  }

  return (
    <Show when={hasAnyItems()}>
      <box
        flexDirection="row"
        gap={1}
        alignItems="center"
        flexShrink={1}
        onMouseUp={(event) => {
          // A drag ending on the bar is a selection, not a request to open the
          // background agents. Same guard every clickable transcript surface
          // carries.
          if (renderer.getSelection()?.getSelectedText()) return
          openBgAgents(event)
        }}
      >
        <Show when={active()}>
          <Spinner />
        </Show>
        <Show when={visibleJobs().length > 0}>
          <text fg={hasActiveJobs() ? theme.accent.alt : theme.foreground.muted} wrapMode="none">
            <span style={{ bold: hasActiveJobs() }}>bg</span> {jobsLabel()}
          </text>
          <Show when={jobSummary()}>
            <text fg={theme.foreground.muted} wrapMode="none" overflow="hidden">
              {jobSummary()}
            </text>
          </Show>
        </Show>
        <Show when={visibleJobs().length > 0 && props.monitors.length > 0}>
          <text fg={theme.border.subtle}>|</text>
        </Show>
        <Show when={props.monitors.length > 0}>
          <text fg={hasActiveMonitors() ? theme.accent.alt : theme.foreground.muted} wrapMode="none">
            <span style={{ bold: hasActiveMonitors() }}>mon</span> {monitorsLabel()}
          </text>
          <Show when={monitorSummary()}>
            <text fg={theme.foreground.muted} wrapMode="none" overflow="hidden">
              {monitorSummary()}
            </text>
          </Show>
        </Show>
        {/* The mark, at every width. It used to be the word "open", and only
            on narrow terminals — so the one place the bar said it was clickable
            was the place with the least room to say it. A mark costs one
            column. */}
        <text fg={theme.foreground.subtle} wrapMode="none">
          {DISCLOSURE.follow}
        </text>
      </box>
    </Show>
  )
}

export function PromptJobsInline(props: PromptJobsInlineProps) {
  return <PromptJobsInlineCompact {...props} />
}
