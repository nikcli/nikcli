/**
 * Prompt Frames Component
 * Unified display for background jobs and monitors in the prompt area.
 * Shows active background tasks with clickable navigation and status indicators.
 */

import { createMemo, createSignal, For, Show } from "solid-js"
import { useTheme } from "@tui/context/theme"
import { DISCLOSURE } from "@tui/component/disclosure"
import { useSync } from "@tui/context/sync"
import { useRoute } from "@tui/context/route"
import { useSDK } from "@tui/context/sdk"
import { useKV } from "@tui/context/kv"
import { useCommandDialog } from "@tui/component/dialog-command"
import { useRenderer, useTerminalDimensions } from "@opentui/solid"
import { Spinner } from "./spinner"
import { TextAttributes } from "@opentui/core"
import { getMonitorsSorted, type MonitorInfo } from "../util/monitor-helpers"
import { dismissBackground, getBackgroundDismissed } from "../util/background"
import { Locale } from "@nikcli-ai/util/locale"

// Job item type from sync.background
export type JobItem = {
  rootDelegationID: string
  parentSessionID: string
  title: string
  agent: string
  status: "running" | "synthesizing" | "complete" | "error" | "timeout" | "cancelled" | "orphaned"
  source?: string
  workerSessionID?: string
  delegatorSessionID?: string
  createdAt: number
  updatedAt: number
  progressSummary?: string
  resultSummary?: string
}

export type PromptFramesProps = {
  sessionID: string
  jobs: JobItem[]
  onOpenJob?: (job: JobItem) => void
  onOpenMonitor?: (monitor: MonitorInfo) => void
  onCancelJob?: (jobID: string) => void
  onCancelMonitor?: (monitorID: string) => void
  collapsed?: boolean
}

function formatJobStatus(status: string): string {
  switch (status) {
    case "running":
      return "running"
    case "synthesizing":
      return "synthesizing"
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

function formatMonitorStatus(status: string): string {
  switch (status) {
    case "running":
      return "running"
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

function isActiveStatus(status: string): boolean {
  return status === "running" || status === "synthesizing"
}

export function PromptFrames(props: PromptFramesProps) {
  const { theme } = useTheme()
  const sync = useSync()
  const route = useRoute()
  const sdk = useSDK()
  const kv = useKV()
  const command = useCommandDialog()
  const dimensions = useTerminalDimensions()
  const renderer = useRenderer()

  const [jobsCollapsed, setJobsCollapsed] = createSignal(props.collapsed ?? false)
  const [monitorsCollapsed, setMonitorsCollapsed] = createSignal(props.collapsed ?? false)

  const monitors = createMemo(() => getMonitorsSorted(sync, props.sessionID))
  const activeJobs = createMemo(() => props.jobs.filter((j) => isActiveStatus(j.status)))
  const activeMonitors = createMemo(() => monitors().filter((m) => m.status === "running"))

  const totalCount = createMemo(() => props.jobs.length + monitors().length)
  const activeCount = createMemo(() => activeJobs().length + activeMonitors().length)

  const dismissed = createMemo(() => getBackgroundDismissed(kv, props.sessionID))
  const visibleJobs = createMemo(() => props.jobs.filter((job) => !dismissed().has(job.rootDelegationID)))

  function navigateToJob(job: JobItem) {
    const sessionID = job.workerSessionID ?? job.delegatorSessionID
    if (!sessionID) return
    void sync.session.sync(sessionID, { full: true })
    route.navigate({
      type: "session",
      sessionID,
      workspaceID: sync.session.get(sessionID)?.workspaceID,
    })
  }

  function openMonitorLog(monitor: MonitorInfo) {
    if (props.onOpenMonitor) {
      props.onOpenMonitor(monitor)
    } else {
      // Default behavior: open bg-agents dialog
      command.trigger("session.bg_agents")
    }
  }

  function cancelJob(job: JobItem) {
    if (job.status === "running" || job.status === "synthesizing") {
      sdk.client.session.background2
        .cancel({ sessionID: props.sessionID, delegationID: job.rootDelegationID })
        .catch(() => {})
    }
    dismissBackground(kv, props.sessionID, job.rootDelegationID)
  }

  function cancelMonitor(monitor: MonitorInfo) {
    if (monitor.status === "running") {
      sdk.client.session.monitorCancel({ sessionID: props.sessionID, monitorID: monitor.id }).catch(() => {})
    }
  }

  function getStatusIcon(status: string): string {
    switch (status) {
      case "running":
      case "synthesizing":
        return "◉"
      case "complete":
        return "✓"
      case "error":
        return "✗"
      case "timeout":
        return "⏱"
      default:
        return "○"
    }
  }

  function getStatusColor(status: string): string {
    switch (status) {
      case "running":
      case "synthesizing":
        return theme.accent.toString()
      case "complete":
        return theme.status.success.fg.toString()
      case "error":
        return theme.status.error.fg.toString()
      case "timeout":
        return theme.status.warning.fg.toString()
      default:
        return theme.foreground.muted.toString()
    }
  }

  return (
    <box
      border={["top"]}
      borderColor={theme.border.default}
      paddingTop={1}
      paddingBottom={1}
      paddingLeft={2}
      paddingRight={2}
      backgroundColor={theme.surface.panel}
      flexShrink={0}
    >
      {/* Header */}
      <box flexDirection="row" justifyContent="space-between" marginBottom={1}>
        <box flexDirection="row" gap={2}>
          <box
            onMouseUp={() => {
              if (renderer.getSelection()?.getSelectedText()) return
              setJobsCollapsed(!jobsCollapsed())
            }}
          >
            {/* The transcript's marks, not this panel's own arrows. */}
            <text fg={theme.foreground.default}>{jobsCollapsed() ? DISCLOSURE.closed : DISCLOSURE.open} </text>
            <text fg={theme.foreground.default} attributes={TextAttributes.BOLD}>
              Jobs
            </text>
            <text fg={theme.foreground.muted}>{` (${visibleJobs().length})`}</text>
          </box>
          <text fg={theme.foreground.muted}>·</text>
          <box
            onMouseUp={() => {
              if (renderer.getSelection()?.getSelectedText()) return
              setMonitorsCollapsed(!monitorsCollapsed())
            }}
          >
            <text fg={theme.foreground.default}>{monitorsCollapsed() ? DISCLOSURE.closed : DISCLOSURE.open} </text>
            <text fg={theme.foreground.default} attributes={TextAttributes.BOLD}>
              Monitors
            </text>
            <text fg={theme.foreground.muted}>{` (${monitors().length})`}</text>
          </box>
        </box>
        <text fg={theme.foreground.muted}>
          <Show when={activeCount() > 0}>
            <text fg={theme.accent.alt}>{String(activeCount())}</text>
            <text fg={theme.foreground.muted}>{" active · "}</text>
          </Show>
          <text fg={theme.foreground.muted}>click to open</text>
        </text>
      </box>

      {/* Jobs Section */}
      <Show when={!jobsCollapsed() && visibleJobs().length > 0}>
        <box marginBottom={1}>
          <For each={visibleJobs()}>
            {(job) => {
              const active = isActiveStatus(job.status)
              const agentColor = theme.accent.alt
              return (
                <box
                  flexDirection="row"
                  gap={1}
                  alignItems="center"
                  paddingTop={0.5}
                  paddingBottom={0.5}
                  onMouseUp={() => navigateToJob(job)}
                >
                  <text fg={getStatusColor(job.status)}>{getStatusIcon(job.status)}</text>
                  <Show when={active}>
                    <text fg={agentColor}>
                      <Spinner />
                    </text>
                  </Show>
                  <text fg={theme.foreground.default} flexGrow={1}>
                    {Locale.truncateMiddle(job.title, 40)}
                  </text>
                  <text fg={theme.foreground.muted}>@{job.agent.split("-")[0]}</text>
                  <text fg={getStatusColor(job.status)}>{formatJobStatus(job.status)}</text>
                </box>
              )
            }}
          </For>
        </box>
      </Show>

      {/* Monitors Section */}
      <Show when={!monitorsCollapsed() && monitors().length > 0}>
        <box>
          <For each={monitors()}>
            {(monitor) => {
              return (
                <box
                  flexDirection="row"
                  gap={1}
                  alignItems="center"
                  paddingTop={0.5}
                  paddingBottom={0.5}
                  onMouseUp={() => openMonitorLog(monitor)}
                >
                  <text fg={getStatusColor(monitor.status)}>{getStatusIcon(monitor.status)}</text>
                  <Show when={monitor.status === "running"}>
                    <text fg={theme.accent.alt}>
                      <Spinner />
                    </text>
                  </Show>
                  <text fg={theme.foreground.default} flexGrow={1}>
                    {Locale.truncateMiddle(monitor.title, 35)}
                  </text>
                  <text fg={theme.foreground.muted}>{Locale.truncateMiddle(monitor.command, 30)}</text>
                  <text fg={getStatusColor(monitor.status)}>{formatMonitorStatus(monitor.status)}</text>
                  <Show when={monitor.exitCode !== undefined}>
                    <text fg={theme.foreground.muted}>{`(${monitor.exitCode})`}</text>
                  </Show>
                </box>
              )
            }}
          </For>
        </box>
      </Show>

      {/* Empty state */}
      <Show when={visibleJobs().length === 0 && monitors().length === 0}>
        <text fg={theme.foreground.muted}>No active background tasks</text>
      </Show>
    </box>
  )
}
