/**
 * Tool rendering for the session view.
 *
 * Split out of `index.tsx`, which had grown to 3972 lines holding the route,
 * the message components and every tool renderer at once. The ~30 renderers
 * below are the bulk of it and they change for reasons that have nothing to
 * do with the route, so they live here.
 *
 * `ToolPart` dispatches on the tool name; everything under it is per-tool
 * presentation. `ExplorationSummary` comes along because it renders tool
 * parts too — it is the collapsed form of a finished exploration run.
 */
import { FooterHint, FooterHintGroup } from "@tui/ui/footer-hints"
import { useScrollAcceleration } from "@tui/util/scroll"
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  Index,
  Match,
  on,
  onCleanup,
  onMount,
  Show,
  Switch,
} from "solid-js"
import { Dynamic } from "solid-js/web"
import path from "path"
import { useRoute } from "@tui/context/route"
import { useSync } from "@tui/context/sync"
import { useProject } from "@tui/context/project"
import { SplitBorder } from "@tui/component/border"
import { SessionTaskCard } from "@tui/component/session-task-card"
import { DISCLOSURE, LESS, more, summaryLine } from "@tui/component/disclosure"
import { Spinner } from "@tui/component/spinner"
import { useTheme, selectedForeground, tint } from "@tui/context/theme"
import { BoxRenderable, ScrollBoxRenderable, TextAttributes, RGBA } from "@opentui/core"
import { Prompt } from "@tui/component/prompt"
import { TuiPluginRuntime } from "@tui/plugin"
import { type AssistantMessage, type Part, type ToolPart } from "@nikcli-ai/sdk/httpapi"
import { useLocal } from "@tui/context/local"
import { Locale } from "@nikcli-ai/util/locale"
import { reasoningSummary } from "@tui/context/thinking"
import { Token } from "@nikcli-ai/util/token"
import {
  artifactPublishedHref,
  diagnosticMessage,
  type ApplyPatchShape,
  type ArtifactShape,
  type BashShape,
  type BrowserControlShape,
  type ComputerShape,
  type Diagnostic,
  type EditShape,
  type GlobShape,
  type GrepShape,
  type ListShape,
  type QuestionShape,
  type ReadShape,
  type ToolShape,
  type TodoWriteShape,
  type WriteShape,
} from "@tui/util/tool-shapes"

import { normalizeVizComponents } from "@nikcli-ai/util/viz"
import { useKeyboard, useRenderer, useTerminalDimensions, type JSX } from "@opentui/solid"
import { useSDK } from "@tui/context/sdk"
import { useCommandDialog } from "@tui/component/dialog-command"
import { useKeybind } from "@tui/context/keybind"
import { parsePatch } from "diff"
import { useDialog } from "../../ui/dialog"
import { TodoItem } from "../../component/todo-item"
import { DialogMessage } from "./dialog-message"
import type { PromptInfo } from "../../component/prompt/history"
import { DialogConfirm } from "@tui/ui/dialog-confirm"
import { DialogTimeline } from "./dialog-timeline"
import { DialogForkFromTimeline } from "./dialog-fork-from-timeline"
import { DialogSessionRename } from "../../component/dialog-session-rename"
import { Sidebar } from "./sidebar"
import { LANGUAGE_EXTENSIONS } from "@nikcli-ai/util/language"
import { Clipboard } from "../../util/clipboard"
import { useToast } from "../../ui/toast"
import { useKV } from "../../context/kv.tsx"
import { useServer } from "../../context/server"
import { Editor } from "../../util/editor"
import { stripAnsi } from "@nikcli-ai/util/bun-utils"
import { SubagentFooter } from "./subagent-footer.tsx"
import { usePromptRef } from "../../context/prompt"
import { useExit } from "../../context/exit"
import { Filesystem } from "@nikcli-ai/util/filesystem"
import { Global } from "@nikcli-ai/util/global"
import { formatPath } from "@tui/util/path-format"
import { PermissionPrompt } from "./permission"
import { QuestionPrompt } from "./question"
import { DialogExportOptions } from "../../ui/dialog-export-options"
import { formatTranscriptJson } from "../../util/transcript"
import { TurnUsage } from "../../util/turn-usage"
import { DialogWebPreview } from "@tui/component/dialog-web-preview"
import { DialogOpenTUIViz, Renderer as VizRenderer } from "@tui/component/dialog-opentui-viz"
import { compilePartialSpec } from "@tui/util/spec-stream"
import { TuiImageList } from "@tui/component/tui-image"
import { DialogSelect } from "../../ui/dialog-select"
import { DialogBgAgents } from "./dialog-bg-agents"
import { features } from "@nikcli-ai/util/features"
import { useLanguage } from "@tui/context/language"
import { visibleRange } from "./message-window"
import { groupLabel, groupParts, type ExplorationGroup } from "./rows"
import { RevertBanner } from "./revert-banner"
import { sessionCommandLabels } from "./session-command-labels"
import {
  dismissBackground as dismissBackgroundUtil,
  undismissBackground as undismissBackgroundUtil,
} from "../../util/background"
import { friendlyErrorMessage, shareErrorMessage } from "../../util/error-message"
import { Link } from "../../ui/link"
import { use } from "./session-context"

/**
 * One line standing in for a finished run of read-only tool calls.
 *
 * Anything the user still has to answer is rendered in full underneath: a
 * permission prompt must never be what got collapsed away.
 */
export function ExplorationSummary(props: { group: ExplorationGroup<ToolEntry>; sessionID: string }) {
  const { theme } = useTheme()
  return (
    <>
      <box paddingLeft={3}>
        <text paddingLeft={3} fg={theme.foreground.muted}>
          ⋮ {groupLabel(props.group)}
        </text>
      </box>
      <For each={props.group.pending}>
        {(entry) => <ToolPartView last={false} streaming={false} entry={entry} sessionID={props.sessionID} />}
      </For>
    </>
  )
}

// Pending messages moved to individual tool pending functions

/** What a tool renderer needs, from a v1 part or a v2 entry alike. */
export type ToolEntry = {
  readonly id: string
  readonly sessionID: string
  readonly messageID?: string
  readonly callID: string
  /** v1 parts name it `tool`, v2 entries name it `name`. */
  readonly tool?: string
  readonly name?: string
  readonly state: ToolPart["state"]
}

export function ToolPartView(props: { last: boolean; streaming: boolean; entry: ToolEntry; sessionID: string }) {
  const ctx = use()
  /** v1 parts name it `tool`, v2 entries name it `name`. */
  const toolName = createMemo(() => props.entry.tool ?? props.entry.name ?? "")
  const sync = useSync()
  const imagePreviewColumns = createMemo(() => Math.max(24, Math.min(180, ctx.width - 8)))
  const imagePreviewRows = createMemo(() => Math.max(4, Math.floor(ctx.height / 3)))
  const imagePreviewUrls = createMemo(() => {
    if (props.entry.state.status !== "completed") return []
    return (props.entry.state.attachments ?? [])
      .filter((file) => file.mime.startsWith("image/") && file.mime !== "image/svg+xml")
      .flatMap((file) => (file.url ? [file.url] : file.source?.type === "file" ? [file.source.path] : []))
  })

  // Hide tool if showDetails is false and tool completed successfully
  const shouldHide = createMemo(() => {
    if (ctx.showDetails()) return false
    if (props.entry.state.status !== "completed") return false
    return imagePreviewUrls().length === 0
  })

  const toolprops = {
    get metadata() {
      if (props.entry.state.status === "pending") return {}
      return {
        ...props.entry.state.metadata,
        ...(props.entry.state.status === "running" ? (props.entry.state.structured ?? {}) : {}),
      }
    },
    get input() {
      return props.entry.state.input ?? {}
    },
    get output() {
      return props.entry.state.status === "completed" ? props.entry.state.output : undefined
    },
    get permission() {
      const permissions = sync.data.permission[props.sessionID] ?? []
      const permissionIndex = permissions.findIndex((x) => x.tool?.callID === props.entry.callID)
      return permissions[permissionIndex]
    },
    get tool() {
      return toolName()
    },
    get part() {
      return props.entry
    },
  }

  return (
    <>
      <Show when={!shouldHide()}>
        <Switch>
          <Match when={toolName() === "bash"}>
            <Bash {...toolprops} />
          </Match>
          <Match when={toolName() === "exec_code" || toolName() === "code_mode"}>
            <ExecCode {...toolprops} />
          </Match>
          <Match when={toolName() === "glob"}>
            <Glob {...toolprops} />
          </Match>
          <Match when={toolName() === "read"}>
            <Read {...toolprops} />
          </Match>
          <Match when={toolName() === "grep"}>
            <Grep {...toolprops} />
          </Match>
          <Match when={toolName() === "list"}>
            <List {...toolprops} />
          </Match>
          <Match when={toolName() === "webfetch"}>
            <WebFetch {...toolprops} />
          </Match>
          <Match when={toolName() === "codesearch"}>
            <CodeSearch {...toolprops} />
          </Match>
          <Match when={toolName() === "websearch"}>
            <WebSearch {...toolprops} />
          </Match>
          <Match when={toolName() === "write"}>
            <Write {...toolprops} />
          </Match>
          {/* `multiedit` publishes the same metadata as `edit` — a `filePath`
              and a unified `diff` — and had no case at all, so every multi-edit
              fell through to the generic view and its diff was simply never
              drawn. */}
          <Match when={toolName() === "edit" || toolName() === "multiedit"}>
            <Edit {...toolprops} />
          </Match>
          <Match when={toolName() === "task"}>
            <Task {...toolprops} />
          </Match>
          <Match when={toolName() === "monitor"}>
            <Monitor {...toolprops} />
          </Match>
          <Match when={toolName() === "apply_patch"}>
            <ApplyPatch {...toolprops} />
          </Match>
          <Match when={toolName() === "todowrite"}>
            <TodoWrite {...toolprops} />
          </Match>
          <Match when={toolName() === "question"}>
            <Question {...toolprops} />
          </Match>
          <Match when={toolName() === "opentui"}>
            <OpenTUIViz {...toolprops} />
          </Match>
          <Match when={toolName() === "browser_control"}>
            <BrowserControlView {...toolprops} />
          </Match>
          <Match when={toolName() === "computer"}>
            <ComputerUse {...toolprops} />
          </Match>
          <Match when={toolName() === "artifact"}>
            <ArtifactView {...toolprops} />
          </Match>
          <Match when={true}>
            <GenericTool {...toolprops} />
          </Match>
        </Switch>
      </Show>
      <Show when={imagePreviewUrls().length > 0}>
        <box paddingLeft={3} flexShrink={0}>
          <TuiImageList urls={imagePreviewUrls()} maxColumns={imagePreviewColumns()} maxRows={imagePreviewRows()} />
        </box>
      </Show>
    </>
  )
}

type ToolProps<S extends ToolShape = ToolShape> = {
  input: Partial<S["input"]>
  metadata: Partial<S["metadata"]>
  permission: Record<string, any>
  tool: string
  output?: string
  part: ToolEntry
}

function BrowserControlView(props: ToolProps<BrowserControlShape>) {
  const { theme } = useTheme()
  const action = createMemo(() => props.metadata.action ?? props.input.action ?? "browser_control")
  const label = createMemo(() => (props.metadata.name ? `${action()} · ${props.metadata.name}` : action()))

  return (
    <Switch>
      <Match when={props.output !== undefined}>
        <BlockTool
          title={`# Browser Control · ${label()}`}
          titleColor={theme.accent.fg}
          accentColor={theme.accent.fg}
          part={props.part}
        >
          <box gap={1}>
            <text fg={theme.foreground.muted}>{props.output}</text>
          </box>
        </BlockTool>
      </Match>
      <Match when={true}>
        <InlineTool
          icon="◎"
          iconColor={theme.accent.fg}
          pending="Running browser-control action..."
          complete={label()}
          part={props.part}
        >
          Browser Control · {label()}
        </InlineTool>
      </Match>
    </Switch>
  )
}

function ComputerUse(props: ToolProps<ComputerShape>) {
  const { theme } = useTheme()
  const action = createMemo(() => props.input.action ?? "computer")
  const mode = createMemo(() => (props.metadata as Record<string, any>).mode as string | undefined)
  const liveUrl = createMemo(() => (props.metadata as Record<string, any>).liveUrl as string | undefined)
  const label = createMemo(() => (mode() === "host" ? "Computer" : "Computer (bg)"))
  return (
    <Switch>
      <Match when={props.output !== undefined}>
        <BlockTool
          title={`# ${label()} · ${action()}`}
          titleColor={theme.status.warning.fg}
          accentColor={theme.status.warning.fg}
          part={props.part}
        >
          <box gap={1}>
            <text fg={theme.foreground.muted}>{props.output}</text>
            <Show when={liveUrl()}>{(url) => <text fg={theme.foreground.muted}>Live preview: {url()}</text>}</Show>
          </box>
        </BlockTool>
      </Match>
      <Match when={true}>
        <InlineTool
          icon="▣"
          iconColor={theme.status.warning.fg}
          pending="Waiting for computer use..."
          complete={action()}
          part={props.part}
        >
          {label()} · {action()}
        </InlineTool>
      </Match>
    </Switch>
  )
}

function ArtifactView(props: ToolProps<ArtifactShape>) {
  const { theme } = useTheme()
  const title = createMemo(() => props.metadata.title ?? props.input.title ?? "Artifact")
  const url = createMemo(() => artifactPublishedHref(props.metadata, props.output))
  const detail = createMemo(() => {
    const kind = props.metadata.kind ? String(props.metadata.kind).toUpperCase() : "ARTIFACT"
    const version = props.metadata.version ? ` · v${props.metadata.version}` : ""
    return `${kind}${version}`
  })

  return (
    <Switch>
      <Match when={props.output !== undefined}>
        <BlockTool
          title={`# Published · ${title()}`}
          titleColor={theme.accent.fg}
          accentColor={theme.accent.fg}
          part={props.part}
        >
          <box gap={1}>
            <text fg={theme.foreground.muted}>{detail()}</text>
            <Show when={url()}>{(value) => <Link href={value()} fg={theme.accent.fg} />}</Show>
          </box>
        </BlockTool>
      </Match>
      <Match when={true}>
        <InlineTool
          icon="◇"
          iconColor={theme.accent.fg}
          pending={`Publishing ${title()}...`}
          complete={title()}
          part={props.part}
        >
          Artifact · {title()}
        </InlineTool>
      </Match>
    </Switch>
  )
}

function GenericTool(props: ToolProps<any>) {
  return (
    <InlineTool icon="⚙" pending="Writing command..." complete={true} part={props.part}>
      {props.tool} {input(props.input)}
    </InlineTool>
  )
}

function InlineTool(props: {
  icon: string
  iconColor?: RGBA
  complete: any
  pending: string
  children: JSX.Element
  part: ToolEntry
}) {
  const [margin, setMargin] = createSignal(0)
  const { theme } = useTheme()
  const ctx = use()
  const sync = useSync()

  const permission = createMemo(() => {
    const callID = sync.data.permission[ctx.sessionID]?.at(0)?.tool?.callID
    if (!callID) return false
    return callID === props.part.callID
  })

  const fg = createMemo(() => {
    if (permission()) return theme.status.warning.fg
    if (props.complete) return theme.foreground.muted
    return theme.foreground.default
  })

  const error = createMemo(() => (props.part.state.status === "error" ? props.part.state.error : undefined))

  const denied = createMemo(
    () =>
      error()?.includes("rejected permission") ||
      error()?.includes("specified a rule") ||
      error()?.includes("user dismissed"),
  )

  return (
    <box
      marginTop={margin()}
      paddingLeft={3}
      renderBefore={function () {
        const el = this as BoxRenderable
        const parent = el.parent
        if (!parent) {
          return
        }
        if (el.height > 1) {
          setMargin(1)
          return
        }
        const children = parent.getChildren()
        const index = children.indexOf(el)
        const previous = children[index - 1]
        if (!previous) {
          setMargin(0)
          return
        }
        if (previous.height > 1 || previous.id.startsWith("text-")) {
          setMargin(1)
          return
        }
      }}
    >
      <text paddingLeft={3} fg={fg()} attributes={denied() ? TextAttributes.STRIKETHROUGH : undefined}>
        <Show fallback={<>~ {props.pending}</>} when={props.complete}>
          <span style={{ fg: props.iconColor }}>{props.icon}</span> {props.children}
        </Show>
      </text>
      <Show when={error() && !denied()}>
        <text fg={theme.status.error.fg}>{error()}</text>
      </Show>
    </box>
  )
}

function BlockTool(props: {
  title: string
  titleColor?: RGBA
  accentColor?: RGBA
  children: JSX.Element
  onClick?: () => void
  /**
   * Whether the click opens something rather than unfolding this block.
   *
   * Decides the mark, and the mark is the whole point of having one: `→` is a
   * promise that something else comes up. Bash and code mode use their click to
   * expand in place and draw their own `▸`, so they say nothing here.
   */
  opens?: boolean
  part?: ToolEntry
  /** Skip the accent background tint — keep accent only on border/title. */
  transparent?: boolean
}) {
  const { theme } = useTheme()
  const renderer = useRenderer()
  const [hover, setHover] = createSignal(false)
  const error = createMemo(() => (props.part?.state.status === "error" ? props.part.state.error : undefined))

  const backgroundColor = createMemo(() => {
    // Fully transparent: paint nothing, let the session background show through.
    if (props.transparent) return hover() ? theme.surface.overlay : undefined
    const base = hover() ? theme.surface.overlay : theme.surface.panel
    const accent = props.accentColor
    if (!accent) return base

    // Adapt tint intensity for light vs dark panels.
    const luminance = 0.299 * base.r + 0.587 * base.g + 0.114 * base.b
    const isLight = luminance > 0.55
    const alpha = hover() ? (isLight ? 0.1 : 0.16) : isLight ? 0.06 : 0.12

    // Preserve the panel alpha channel (important for transparent themes).
    const tinted = tint(base, accent, alpha)
    const a = base.a <= 1 ? Math.round(base.a * 255) : Math.round(base.a)
    return RGBA.fromInts(Math.round(tinted.r * 255), Math.round(tinted.g * 255), Math.round(tinted.b * 255), a)
  })

  const borderColor = createMemo(() => props.accentColor ?? theme.surface.base)
  return (
    <box
      border={["left"]}
      paddingTop={1}
      paddingBottom={1}
      paddingLeft={2}
      marginTop={1}
      gap={1}
      backgroundColor={backgroundColor()}
      customBorderChars={SplitBorder.customBorderChars}
      borderColor={borderColor()}
      onMouseOver={() => props.onClick && setHover(true)}
      onMouseOut={() => setHover(false)}
      onMouseUp={() => {
        if (renderer.getSelection()?.getSelectedText()) return
        props.onClick?.()
      }}
    >
      <text paddingLeft={3} fg={props.titleColor ?? theme.foreground.muted}>
        {props.title}
        {/* The mark every clickable surface draws. It lives here so a block
            tool stops having to spend a row saying "view monitor output" —
            hover was the only other signal, and hover is not a signal on a
            surface you have not moved the mouse to yet. */}
        <Show when={props.onClick && props.opens}>
          <span style={{ fg: theme.foreground.subtle }}> {DISCLOSURE.follow}</span>
        </Show>
      </text>
      {props.children}
      <Show when={error()}>
        <text fg={theme.status.error.fg}>{error()}</text>
      </Show>
    </box>
  )
}

function Bash(props: ToolProps<BashShape>) {
  const { theme } = useTheme()
  const sync = useSync()
  const output = createMemo(() => stripAnsi(props.metadata.output?.trim() ?? ""))
  const [expanded, setExpanded] = createSignal(false)
  const lines = createMemo(() => output().split("\n"))
  const overflow = createMemo(() => lines().length > 10)
  const limited = createMemo(() => {
    if (expanded() || !overflow()) return output()
    return [...lines().slice(0, 10), "…"].join("\n")
  })

  // Prefer streamed input; fall back to metadata.command published at execute start
  // so the running command is visible before the model finishes the tool-call args.
  const command = createMemo(() => {
    if (typeof props.input.command === "string" && props.input.command.length > 0) return props.input.command
    const metaCmd = (props.metadata as { command?: string }).command
    return typeof metaCmd === "string" ? metaCmd : undefined
  })

  const workdirDisplay = createMemo(() => {
    const workdir = props.input.workdir
    if (!workdir || workdir === ".") return undefined

    const base = sync.data.path.directory
    if (!base) return undefined

    const absolute = path.resolve(base, workdir)
    if (absolute === base) return undefined

    const home = Global.Path.home
    if (!home) return absolute

    const match = absolute === home || absolute.startsWith(home + path.sep)
    return match ? absolute.replace(home, "~") : absolute
  })

  const title = createMemo(() => {
    const metaDesc = (props.metadata as { description?: string }).description
    const desc =
      (typeof props.input.description === "string" && props.input.description) ||
      (typeof metaDesc === "string" && metaDesc) ||
      "Shell"
    const wd = workdirDisplay()
    if (!wd) return `# ${desc}`
    if (desc.includes(wd)) return `# ${desc}`
    return `# ${desc} in ${wd}`
  })

  // Show the block as soon as we know the command (input or early metadata),
  // not only after the first stdout chunk — avoids stuck "Writing command...".
  const showRunning = createMemo(() => props.metadata.output !== undefined || Boolean(command()))

  return (
    <Switch>
      <Match when={showRunning()}>
        <BlockTool
          title={title()}
          part={props.part}
          onClick={overflow() ? () => setExpanded((prev) => !prev) : undefined}
        >
          <box gap={1}>
            <text fg={theme.foreground.default}>$ {command() ?? "…"}</text>
            <Show when={output()}>
              <text fg={theme.foreground.default}>{limited()}</text>
            </Show>
            <Show when={overflow()}>
              {/* The mark, not a sentence. `BlockTool` already says the surface
                  is clickable; this says what is behind it. */}
              <text fg={theme.foreground.subtle} wrapMode="none">
                {expanded() ? DISCLOSURE.open : DISCLOSURE.closed}{" "}
                {expanded() ? LESS : more(lines().length - 10, "lines")}
              </text>
            </Show>
          </box>
        </BlockTool>
      </Match>
      <Match when={true}>
        <InlineTool icon="$" pending="Writing command..." complete={command()} part={props.part}>
          {command()}
        </InlineTool>
      </Match>
    </Switch>
  )
}
function ExecCode(props: ToolProps<any>) {
  const { theme, syntax } = useTheme()

  type CodeModeCall = {
    tool: string
    status: "running" | "completed" | "error" | "interrupted"
    input?: Record<string, unknown>
  }

  const input = createMemo(
    () =>
      (props.input ?? {}) as {
        code?: string
        timeout?: number
        maxToolCalls?: number
        maxOutputBytes?: number
      },
  )
  const meta = createMemo(
    () =>
      (props.metadata ?? {}) as {
        success?: boolean
        durationMs?: number
        toolCalls?: CodeModeCall[]
      },
  )
  const toolCalls = createMemo(() => meta().toolCalls?.filter(isCodeModeCall) ?? [])

  const code = createMemo<string>(() => input().code ?? "")
  const codeLines = createMemo(() => code().split("\n"))
  const codeOverflow = createMemo(() => codeLines().length > 20)

  const output = createMemo(() => stripAnsi((props.output ?? "").trim()))
  const outputLines = createMemo(() => output().split("\n"))
  const outputOverflow = createMemo(() => outputLines().length > 10)

  const [expanded, setExpanded] = createSignal(false)
  const callsOverflow = createMemo(() => toolCalls().length > 12)
  const overflow = createMemo(() => codeOverflow() || outputOverflow() || callsOverflow())

  const limitedCode = createMemo(() => {
    if (expanded() || !codeOverflow()) return code()
    return [...codeLines().slice(0, 20), "…"].join("\n")
  })

  const limitedOutput = createMemo(() => {
    if (expanded() || !outputOverflow()) return output()
    return [...outputLines().slice(0, 10), "…"].join("\n")
  })

  const visibleToolCalls = createMemo(() => {
    if (expanded() || !callsOverflow()) return toolCalls()
    return toolCalls().slice(-12)
  })

  const success = createMemo(() => meta().success !== false && props.part.state.status !== "error")
  const duration = createMemo(() => meta().durationMs)
  const accent = createMemo(() => (success() ? theme.status.success.fg : theme.status.error.fg))

  const title = createMemo(() => {
    const ms = duration() != null ? ` · ${duration()}ms` : ""
    const icon = success() ? "✓" : "✗"
    const label = props.tool === "code_mode" ? "Code Mode" : "Execute Code"
    return `# ${label}${ms} ${icon}`
  })

  /**
   * The one line of code worth showing before anything is asked for.
   *
   * This memo already existed and nothing read it, which is the shape of an
   * intention someone did not finish: the block opened with twenty rows of
   * syntax-highlighted source, the least useful thing about a run that has
   * already finished. What it *did* and what it *printed* are the answers; the
   * source is the method, and the method waits.
   */
  const firstLine = createMemo(() => {
    const first = codeLines().find((line) => line.trim().length > 0) ?? ""
    const trimmed = first.trim()
    return trimmed.length > 72 ? trimmed.slice(0, 72) + "…" : trimmed
  })

  /** The last line that printed, which is normally the result. */
  const lastOutput = createMemo(() => {
    const line = [...outputLines()].reverse().find((entry) => entry.trim().length > 0)
    if (!line) return ""
    const trimmed = line.trim()
    return trimmed.length > 72 ? trimmed.slice(0, 72) + "…" : trimmed
  })

  /** Anything at all behind the fold — not just the old overflow thresholds. */
  const hasDetail = createMemo(() => codeLines().length > 1 || toolCalls().length > 0 || output().length > 0)

  return (
    <Switch>
      <Match when={props.output !== undefined}>
        <BlockTool
          title={title()}
          titleColor={accent()}
          accentColor={accent()}
          part={props.part}
          onClick={hasDetail() ? () => setExpanded((prev) => !prev) : undefined}
        >
          <Show
            when={expanded()}
            fallback={
              <box overflow="hidden">
                {/* Two rows: what it ran, and what came out. The title above
                    already carries the verdict and the duration. */}
                <text wrapMode="none" fg={theme.foreground.muted}>
                  <span style={{ fg: theme.foreground.default }}>{firstLine()}</span>
                  <Show when={toolCalls().length > 0}>
                    {" · "}
                    {toolCalls().length} tool {toolCalls().length === 1 ? "call" : "calls"}
                  </Show>
                </text>
                <Show when={lastOutput()}>
                  <text wrapMode="none" fg={success() ? theme.foreground.default : theme.status.error.fg}>
                    └ {lastOutput()}
                  </text>
                </Show>
                <Show when={hasDetail()}>
                  <text fg={theme.foreground.subtle} wrapMode="none">
                    {"  "}
                    {DISCLOSURE.closed} {more(codeLines().length, "lines")}
                    <Show when={outputLines().length > 1}>, {outputLines().length} of output</Show>
                  </text>
                </Show>
              </box>
            }
          >
            <box gap={1}>
              <line_number fg={theme.foreground.muted} minWidth={3} paddingRight={1}>
                <code
                  conceal={false}
                  fg={theme.foreground.default}
                  filetype="typescript"
                  syntaxStyle={syntax()}
                  content={limitedCode()}
                />
              </line_number>
              <CodeModeToolCalls calls={visibleToolCalls()} />
              <Show when={output().length > 0}>
                <text fg={theme.foreground.muted}>── output ──</text>
                <text fg={success() ? theme.foreground.default : theme.status.error.fg}>{limitedOutput()}</text>
              </Show>
              <text fg={theme.foreground.subtle} wrapMode="none">
                {"  "}
                {DISCLOSURE.open} {LESS}
              </text>
            </box>
          </Show>
        </BlockTool>
      </Match>
      <Match when={true}>
        <>
          <InlineTool
            icon="⚡"
            iconColor={theme.status.warning.fg}
            pending="Running code..."
            complete={code()}
            part={props.part}
          >
            {props.tool} {firstLine()}
          </InlineTool>
          <CodeModeToolCalls calls={visibleToolCalls()} />
        </>
      </Match>
    </Switch>
  )

  function isCodeModeCall(value: unknown): value is CodeModeCall {
    if (!value || typeof value !== "object") return false
    const call = value as Partial<CodeModeCall>
    return (
      typeof call.tool === "string" &&
      (call.status === "running" ||
        call.status === "completed" ||
        call.status === "error" ||
        call.status === "interrupted")
    )
  }

  function CodeModeToolCalls(callProps: { calls: CodeModeCall[] }) {
    return (
      <Show when={callProps.calls.length > 0}>
        <box paddingLeft={3} gap={0}>
          <text fg={theme.foreground.muted}>── nested tools ──</text>
          <For each={callProps.calls}>
            {(call) => {
              // An interrupted call was cancelled, not failed — a red ✗ next to it
              // reads as the tool having broken.
              const marker =
                call.status === "running"
                  ? "◌"
                  : call.status === "completed"
                    ? "✓"
                    : call.status === "interrupted"
                      ? "⊘"
                      : "✗"
              const color =
                call.status === "running"
                  ? theme.status.warning.fg
                  : call.status === "completed"
                    ? theme.status.success.fg
                    : call.status === "interrupted"
                      ? theme.foreground.muted
                      : theme.status.error.fg
              const details = summarizeCodeModeInput(call.input)
              return (
                <text fg={color}>
                  {marker} {call.tool}
                  <Show when={details.length > 0}>
                    <span style={{ fg: theme.foreground.muted }}> {details}</span>
                  </Show>
                </text>
              )
            }}
          </For>
        </box>
      </Show>
    )
  }
}

function summarizeCodeModeInput(value?: Record<string, unknown>) {
  if (!value) return ""
  const summary = input(value)
  return summary.length > 120 ? summary.slice(0, 119) + "…" : summary
}

function Write(props: ToolProps<WriteShape>) {
  const { theme, syntax } = useTheme()
  const code = createMemo(() => {
    if (!props.input.content) return ""
    return props.input.content
  })

  const diagnostics = createMemo(() => {
    const filePath = Filesystem.normalizePath(props.input.filePath ?? "")
    return props.metadata.diagnostics?.[filePath] ?? []
  })

  return (
    <Switch>
      <Match when={props.metadata.diagnostics !== undefined}>
        <BlockTool title={"# Wrote " + normalizePath(props.input.filePath!)} part={props.part}>
          <line_number fg={theme.foreground.muted} minWidth={3} paddingRight={1}>
            <code
              conceal={false}
              fg={theme.foreground.default}
              filetype={filetype(props.input.filePath!)}
              syntaxStyle={syntax()}
              content={code()}
            />
          </line_number>
          <Show when={diagnostics().length}>
            <For each={diagnostics()}>
              {(diagnostic) => (
                <text fg={theme.status.error.fg}>
                  Error [{diagnostic.range.start.line}:{diagnostic.range.start.character}]:{" "}
                  {diagnosticMessage(diagnostic)}
                </text>
              )}
            </For>
          </Show>
        </BlockTool>
      </Match>
      <Match when={true}>
        <InlineTool icon="←" pending="Preparing write..." complete={props.input.filePath} part={props.part}>
          Write {normalizePath(props.input.filePath!)}
        </InlineTool>
      </Match>
    </Switch>
  )
}

function Glob(props: ToolProps<GlobShape>) {
  return (
    <InlineTool icon="✱" pending="Finding files..." complete={props.input.pattern} part={props.part}>
      Glob "{props.input.pattern}" <Show when={props.input.path}>in {normalizePath(props.input.path)} </Show>
      <Show when={props.metadata.count}>({props.metadata.count} matches)</Show>
    </InlineTool>
  )
}

function Read(props: ToolProps<ReadShape>) {
  return (
    <InlineTool icon="→" pending="Reading file..." complete={props.input.filePath} part={props.part}>
      Read {normalizePath(props.input.filePath!)} {input(props.input, ["filePath"])}
    </InlineTool>
  )
}

function Grep(props: ToolProps<GrepShape>) {
  return (
    <InlineTool icon="✱" pending="Searching content..." complete={props.input.pattern} part={props.part}>
      Grep "{props.input.pattern}" <Show when={props.input.path}>in {normalizePath(props.input.path)} </Show>
      <Show when={props.metadata.matches}>({String(props.metadata.matches)} matches)</Show>
    </InlineTool>
  )
}

function List(props: ToolProps<ListShape>) {
  const dir = createMemo(() => {
    if (props.input.path) {
      return normalizePath(props.input.path)
    }
    return ""
  })
  return (
    <InlineTool icon="→" pending="Listing directory..." complete={props.input.path !== undefined} part={props.part}>
      List {dir()}
    </InlineTool>
  )
}

function WebFetch(props: ToolProps<any>) {
  const input = props.input as any
  const { theme } = useTheme()
  const dialog = useDialog()
  const url = createMemo(() => String(input.url ?? "").trim())
  const format = createMemo(() => String(input.format ?? "markdown"))
  const host = createMemo(() => formatURLHost(url()))

  const openPreview = () => {
    if (!url()) return
    dialog.replace(() => <DialogWebPreview url={url()} />)
  }

  return (
    <Switch>
      <Match when={props.output !== undefined && url()}>
        <BlockTool
          title={`# Web fetch: ${host()}`}
          accentColor={theme.accent.fg}
          titleColor={theme.accent.fg}
          onClick={openPreview}
          opens
          part={props.part}
        >
          <box gap={0}>
            <box flexDirection="row" justifyContent="space-between" alignItems="center" gap={1}>
              <text fg={theme.accent.fg} wrapMode="char" flexGrow={1}>
                {url()}
              </text>
            </box>
          </box>
        </BlockTool>
      </Match>
      <Match when={true}>
        <InlineTool icon="%" pending="Fetching from the web..." complete={(props.input as any).url} part={props.part}>
          WebFetch {(props.input as any).url}
        </InlineTool>
      </Match>
    </Switch>
  )
}

function OpenTUIViz(props: ToolProps<any>) {
  const { theme } = useTheme()
  const dialog = useDialog()
  const metadata = props.metadata as any
  const input = props.input as any

  const spec = createMemo(() => metadata?.spec ?? input)
  const title = createMemo(() => String(spec()?.title ?? input?.title ?? "Visualization"))
  const count = createMemo(() => {
    const c = spec()?.components ?? input?.components
    return Array.isArray(c) ? c.length : 0
  })

  // Real-time generative TUI: while the tool arguments are still streaming, the
  // raw JSON accumulates on the pending part. Compile it into a best-effort spec
  // so completed components render incrementally as the model emits them. We also
  // bridge the brief "running" window (after tool-call, before tool-result) by
  // using the now-parsed input — otherwise the user sees the streamed components
  // disappear into a generic "Generating visualization…" placeholder for the
  // lifetime of the tool.
  const live = createMemo(() => {
    if (props.output !== undefined) return undefined
    const state = props.part.state as {
      status: string
      raw?: string
      input?: unknown
    }
    if (state.status === "pending") {
      const raw = state.raw
      if (!raw) return undefined
      const partial = compilePartialSpec(raw)
      return partial.components.length > 0 || partial.title ? partial : undefined
    }
    if (state.status === "running") {
      const parsed = (state.input ?? props.input) as
        | { title?: string; subtitle?: string; components?: unknown }
        | undefined
      if (!parsed) return undefined
      const components = normalizeVizComponents(parsed.components)
      if (components.length === 0 && !parsed.title) return undefined
      return {
        title: typeof parsed.title === "string" ? parsed.title : "",
        subtitle: typeof parsed.subtitle === "string" ? parsed.subtitle : undefined,
        components,
        streaming: false,
      }
    }
    return undefined
  })

  const openViz = () => {
    const s = spec()
    if (!s) return
    dialog.replace(() => <DialogOpenTUIViz spec={s} />)
  }

  return (
    <Switch>
      <Match when={props.output !== undefined && count() > 0}>
        <BlockTool
          title={`# Visualization: ${title()}`}
          accentColor={theme.accent.alt}
          titleColor={theme.accent.alt}
          onClick={openViz}
          opens
          part={props.part}
          transparent
        >
          <box gap={1}>
            <box flexDirection="row" justifyContent="space-between" alignItems="center">
              <text fg={theme.accent.alt} attributes={TextAttributes.BOLD} flexGrow={1}>
                ◈ {title()}
              </text>
              <text fg={theme.foreground.muted}>open in TUI ↵</text>
            </box>
            <Show when={spec()?.subtitle}>
              <text fg={theme.foreground.muted}>{String(spec()?.subtitle)}</text>
            </Show>
            <VizRenderer spec={spec()} />
            <text fg={theme.foreground.muted} wrapMode="none">
              {count()} component{count() === 1 ? "" : "s"}
            </text>
          </box>
        </BlockTool>
      </Match>
      <Match when={live()}>
        {(partial) => (
          <box border borderColor={theme.accent.alt} paddingLeft={1} paddingRight={1} gap={1} flexDirection="column">
            <box flexDirection="row" gap={1} alignItems="center">
              <text fg={theme.accent.alt} attributes={TextAttributes.BOLD} flexGrow={1}>
                ◈ {partial().title || "Visualization"}
              </text>
              <text fg={theme.status.warning.fg ?? theme.accent.alt}>
                ● {partial().streaming ? "generating" : "rendering"}
              </text>
            </box>
            <VizRenderer spec={partial()} loading={partial().streaming} />
            <Show
              when={partial().streaming}
              fallback={
                <text fg={theme.foreground.muted}>
                  {partial().components.length} component
                  {partial().components.length === 1 ? "" : "s"} ready…
                </text>
              }
            >
              <text fg={theme.foreground.muted}>
                {partial().components.length} component
                {partial().components.length === 1 ? "" : "s"} streamed…
              </text>
            </Show>
          </box>
        )}
      </Match>
      <Match when={true}>
        <InlineTool icon="◈" pending="Generating visualization..." complete={input?.title} part={props.part}>
          OpenTUI {input?.title ?? ""}
        </InlineTool>
      </Match>
    </Switch>
  )
}

function CodeSearch(props: ToolProps<any>) {
  const input = props.input as any
  const metadata = props.metadata as any
  return (
    <InlineTool icon="◇" pending="Searching code..." complete={input.query} part={props.part}>
      Exa Code Search "{input.query}" <Show when={metadata.results}>({metadata.results} results)</Show>
    </InlineTool>
  )
}

function WebSearch(props: ToolProps<any>) {
  const input = props.input as any
  const { theme } = useTheme()
  const dialog = useDialog()
  const output = createMemo(() => String(props.output ?? "").trim())
  const results = createMemo(() => parseWebSearchResults(output()))

  const openPreview = (url: string) => {
    dialog.replace(() => <DialogWebPreview url={url} />)
  }

  const choosePreview = () => {
    if (results().length === 0) return
    if (results().length === 1) {
      openPreview(results()[0]!.url)
      return
    }

    dialog.replace(() => (
      <DialogSelect
        title="Open Web Result"
        placeholder="Filter results"
        options={results().map((result) => ({
          title: result.title,
          description: result.host,
          footer: result.snippet || result.url,
          value: result.url,
          onSelect: (ctx) => {
            ctx.replace(() => <DialogWebPreview url={result.url} />)
          },
        }))}
      />
    ))
  }

  return (
    <Switch>
      <Match when={results().length > 0}>
        <BlockTool
          title={`# Web search: ${input.query}`}
          accentColor={theme.accent.fg}
          titleColor={theme.accent.fg}
          onClick={choosePreview}
          opens
          part={props.part}
        >
          {/* One row. The host is the result, the count is how many more there
              are, and the title's `→` is the invitation — which used to be a
              third row spelling out what the mark now says. */}
          <box overflow="hidden">
            <text wrapMode="none">
              <span style={{ fg: theme.accent.fg }}>{results()[0]!.host}</span>
              <Show when={results().length > 1}>
                <span style={{ fg: theme.foreground.muted }}> · {results().length - 1} more</span>
              </Show>
            </text>
          </box>
        </BlockTool>
      </Match>
      <Match when={output()}>
        <BlockTool title={`# Web search: ${input.query}`} accentColor={theme.accent.fg} part={props.part}>
          <box overflow="hidden">
            {/* Clipped to a row rather than four hundred wrapped characters: a
                search that found nothing to preview should not cost more of the
                transcript than one that did. */}
            <text fg={theme.foreground.muted} wrapMode="none">
              no previewable URLs · {summaryLine(output())}
            </text>
          </box>
        </BlockTool>
      </Match>
      <Match when={true}>
        <InlineTool icon="◈" pending="Searching web..." complete={input.query} part={props.part}>
          Exa Web Search "{input.query}"
        </InlineTool>
      </Match>
    </Switch>
  )
}

type WebSearchPreviewResult = {
  url: string
  title: string
  snippet: string
  host: string
}

function cleanWebSearchUrl(value: string) {
  return value.replace(/[),.;:!?]+$/, "")
}

function cleanWebSearchLine(value: string) {
  return value
    .replace(/\[([^\]]+)\]\(https?:\/\/[^)]+\)/g, "$1")
    .replace(/https?:\/\/[^\s]+/g, "")
    .replace(/^[\s>*\-•\d.()#]+/, "")
    .replace(/[*_`~]+/g, "")
    .replace(/\s{2,}/g, " ")
    .trim()
}

function buildWebSearchSnippet(lines: string[]) {
  return lines.map(cleanWebSearchLine).filter(Boolean).join(" ").slice(0, 220)
}

function parseWebSearchResults(output: string): WebSearchPreviewResult[] {
  if (!output.trim()) return []

  const lines = output.split("\n")
  const results: WebSearchPreviewResult[] = []
  const seen = new Set<string>()
  let previousLine = ""

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]?.trim() ?? ""
    if (!line) continue

    const urlMatch = line.match(/https?:\/\/[^\s<>()\]]+/)
    if (!urlMatch) {
      previousLine = line
      continue
    }

    const url = cleanWebSearchUrl(urlMatch[0])
    if (seen.has(url)) {
      previousLine = line
      continue
    }
    seen.add(url)

    let host = url
    try {
      host = new URL(url).hostname.replace(/^www\./, "")
    } catch {}

    const titleFromLine = cleanWebSearchLine(line)
    const titleFromPrevious = cleanWebSearchLine(previousLine)
    const title = titleFromLine || titleFromPrevious || host

    const snippetLines: string[] = []
    for (let next = index + 1; next < lines.length; next++) {
      const candidate = lines[next]?.trim() ?? ""
      if (!candidate) {
        if (snippetLines.length > 0) break
        continue
      }
      if (/https?:\/\/[^\s<>()\]]+/.test(candidate)) break
      snippetLines.push(candidate)
      if (snippetLines.join(" ").length > 240) break
    }

    results.push({
      url,
      host,
      title,
      snippet: buildWebSearchSnippet(snippetLines),
    })

    if (results.length >= 8) break
    previousLine = line
  }

  if (results.length > 0) return results

  const fallbackUrls = Array.from(output.matchAll(/https?:\/\/[^\s<>()\]]+/g))
  return fallbackUrls.slice(0, 8).map((match) => {
    const url = cleanWebSearchUrl(match[0])
    let host = url
    try {
      host = new URL(url).hostname.replace(/^www\./, "")
    } catch {}
    return {
      url,
      host,
      title: host,
      snippet: "",
    }
  })
}

function formatURLHost(value: string) {
  if (!value) return "web"
  try {
    return new URL(value).hostname.replace(/^www\./, "") || value
  } catch {
    return value
  }
}

function summarizeTaskPreview(text: string) {
  const cleaned = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^<[^>]+>$/.test(line))
  if (cleaned.length === 0) return ""
  const summary = cleaned.slice(-2).join(" ")
  return summary.length > 180 ? summary.slice(0, 177).trimEnd() + "..." : summary
}

type MonitorLogSnapshot = {
  record: {
    id: string
    sessionID: string
    title: string
    command: string
    cwd: string
    logPath: string
    status: string
    wake: boolean
    exitCode?: number
    preview?: string
    time: {
      created: number
      completed?: number
    }
  }
  output: string
  truncated: boolean
}

function trimMonitorBuffer(value: string, maxChars: number = 120_000) {
  if (value.length <= maxChars) return value
  return value.slice(value.length - maxChars)
}

function monitorStatusLabel(status: string, exitCode?: number) {
  switch (status) {
    case "running":
      return "running"
    case "complete":
      return typeof exitCode === "number" ? `completed (exit ${exitCode})` : "completed"
    case "timeout":
      return "timed out"
    case "cancelled":
      return "cancelled"
    case "error":
      return typeof exitCode === "number" ? `failed (exit ${exitCode})` : "failed"
    default:
      return status
  }
}

async function fetchMonitorLog(
  sdk: ReturnType<typeof useSDK>,
  sessionID: string,
  monitorID: string,
  lines: number = 200,
): Promise<MonitorLogSnapshot> {
  const result = await sdk.client.session.monitorLog({
    sessionID,
    monitorID,
    lines,
  })
  if (!result.data) {
    throw new Error(shareErrorMessage(result.error) || "Failed to load monitor log")
  }
  return result.data as MonitorLogSnapshot
}

async function cancelMonitorRequest(sdk: ReturnType<typeof useSDK>, sessionID: string, monitorID: string) {
  const result = await sdk.client.session.monitorCancel({
    sessionID,
    monitorID,
  })
  if (!result.data) {
    throw new Error(shareErrorMessage(result.error) || "Failed to stop monitor")
  }
  return result.data
}

function formatMonitorBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
}

export function DialogMonitorLog(props: {
  sessionID: string
  monitorID: string
  title: string
  command: string
  status: string
  logPath?: string
}) {
  const sdk = useSDK()
  const scrollAcceleration = useScrollAcceleration()
  const toast = useToast()
  const { theme } = useTheme()
  const dialog = useDialog()
  const dimensions = useTerminalDimensions()
  const [content, setContent] = createSignal("")
  const [status, setStatus] = createSignal(props.status)
  const [logPath, setLogPath] = createSignal(props.logPath ?? "")
  const [cwd, setCwd] = createSignal("")
  const [createdAt, setCreatedAt] = createSignal<number>()
  const [completedAt, setCompletedAt] = createSignal<number>()
  const [exitCode, setExitCode] = createSignal<number | undefined>()
  const [loading, setLoading] = createSignal(true)
  const [truncated, setTruncated] = createSignal(false)
  const [follow, setFollow] = createSignal(true)
  const [error, setError] = createSignal<string>()
  const [now, setNow] = createSignal(Date.now())
  let scrollbox: ScrollBoxRenderable | undefined

  const refresh = async () => {
    setLoading(true)
    try {
      const snapshot = await fetchMonitorLog(sdk, props.sessionID, props.monitorID)
      setContent(trimMonitorBuffer(snapshot.output))
      setStatus(snapshot.record.status)
      setLogPath(snapshot.record.logPath)
      setCwd(snapshot.record.cwd)
      setCreatedAt(snapshot.record.time.created)
      setCompletedAt(snapshot.record.time.completed)
      setExitCode(snapshot.record.exitCode)
      setTruncated(snapshot.truncated)
      setError(undefined)
    } catch (error) {
      setError(error instanceof Error ? error.message : "Failed to load monitor log")
    } finally {
      setLoading(false)
    }
  }

  // Elapsed/duration ticker. Only runs while the command is still active so a
  // finished monitor doesn't keep the dialog re-rendering every second.
  createEffect(() => {
    if (status() !== "running") return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    onCleanup(() => clearInterval(timer))
  })

  const durationMs = createMemo(() => {
    const start = createdAt()
    if (!start) return undefined
    return Math.max(0, (completedAt() ?? now()) - start)
  })

  const statusLine = createMemo(() => {
    const parts = [monitorStatusLabel(status(), exitCode())]
    const duration = durationMs()
    if (duration !== undefined)
      parts.push(`${status() === "running" ? "elapsed" : "duration"} ${Locale.duration(duration)}`)
    if (content().length > 0) parts.push(`${formatMonitorBytes(content().length)} output`)
    return parts.join(" · ")
  })

  const stopMonitor = async () => {
    if (status() !== "running") return
    try {
      await cancelMonitorRequest(sdk, props.sessionID, props.monitorID)
      toast.show({ message: `Stopped ${props.title}`, variant: "info" })
      await refresh()
    } catch (error) {
      toast.show({
        message: friendlyErrorMessage(error, "Failed to stop monitor"),
        variant: "error",
      })
    }
  }

  createEffect(
    on(
      () => content(),
      () => {
        if (!follow()) return
        setTimeout(() => {
          if (scrollbox && !scrollbox.isDestroyed) scrollbox.scrollTo(scrollbox.scrollHeight)
        }, 10)
      },
    ),
  )

  onMount(() => {
    // Self-contained like DialogUsage/DialogAnalytics — don't depend on the
    // caller remembering to size the dialog before opening us.
    dialog.setSize("xlarge")
    void refresh()
    const unsubs = [
      sdk.event.on("monitor.output", (evt) => {
        if (evt.properties.monitorID !== props.monitorID || evt.properties.sessionID !== props.sessionID) return
        setContent((prev) => trimMonitorBuffer(prev + evt.properties.delta))
        setStatus(evt.properties.status)
        setError(undefined)
      }),
      sdk.event.on("monitor.updated", (evt) => {
        if (evt.properties.record.id !== props.monitorID || evt.properties.sessionID !== props.sessionID) return
        setStatus(evt.properties.record.status)
        setExitCode(evt.properties.record.exitCode)
        setLogPath(evt.properties.record.logPath)
      }),
      sdk.event.on("monitor.completed", (evt) => {
        if (evt.properties.monitorID !== props.monitorID || evt.properties.sessionID !== props.sessionID) return
        setStatus(evt.properties.status)
        setExitCode(evt.properties.exitCode ?? undefined)
        void refresh()
      }),
    ]
    onCleanup(() => {
      for (const unsub of unsubs) unsub()
    })
  })

  useKeyboard((evt) => {
    if (evt.ctrl || evt.meta) return
    if (evt.name === "f") {
      evt.preventDefault()
      evt.stopPropagation()
      setFollow((prev) => !prev)
      return
    }
    if (evt.name === "r") {
      evt.preventDefault()
      evt.stopPropagation()
      void refresh()
      return
    }
    if (evt.name === "x") {
      evt.preventDefault()
      evt.stopPropagation()
      void stopMonitor()
      return
    }
    if (evt.name === "c") {
      evt.preventDefault()
      evt.stopPropagation()
      void Clipboard.copy(content())
        .then(() => toast.show({ message: "Monitor log copied", variant: "success" }))
        .catch(() =>
          toast.show({
            message: "Failed to copy monitor log",
            variant: "error",
          }),
        )
    }
  })

  return (
    <box flexDirection="column" width="100%" gap={1}>
      <text fg={theme.foreground.default}>Monitor {props.title}</text>
      <text fg={theme.foreground.muted}>{props.command}</text>
      <text
        fg={
          status() === "complete"
            ? theme.status.success.fg
            : status() === "running"
              ? theme.foreground.default
              : theme.status.error.fg
        }
      >
        {statusLine()}
      </text>
      <Show when={cwd()}>
        <text fg={theme.foreground.muted}>dir {normalizePath(cwd())}</text>
      </Show>
      <Show when={logPath()}>
        <text fg={theme.foreground.muted}>log {normalizePath(logPath())}</text>
      </Show>
      <scrollbox
        scrollAcceleration={scrollAcceleration()}
        ref={(value: ScrollBoxRenderable) => {
          scrollbox = value
        }}
        height={Math.max(10, dimensions().height - 18)}
        focused={true}
        border={["top", "bottom", "left", "right"]}
        borderColor={theme.border.subtle}
        paddingLeft={1}
        paddingRight={1}
      >
        <text fg={theme.foreground.default}>
          {content() || (loading() ? "Loading log output..." : "No output yet")}
        </text>
      </scrollbox>
      <Show when={truncated()}>
        <text fg={theme.foreground.muted}>Showing the latest log window.</text>
      </Show>
      <Show when={error()}>
        <text fg={theme.status.error.fg}>{error()}</text>
      </Show>
      <FooterHintGroup>
        <FooterHint keys="f" label={`follow ${follow() ? "on" : "off"}`} />
        <FooterHint keys="r" label="refresh" />
        <FooterHint keys="c" label="copy" />
        <FooterHint keys="x" label="stop" />
        <FooterHint keys="esc" label="close" />
      </FooterHintGroup>
    </box>
  )
}

function Task(props: ToolProps<any>) {
  const { theme } = useTheme()
  const { navigate } = useRoute()
  const local = useLocal()
  const sync = useSync()

  const meta = createMemo(() => props.metadata as Record<string, any>)
  const input = createMemo(() => props.part.state.input as Record<string, any>)
  const metadataSessionID = createMemo(() =>
    typeof meta().sessionID === "string"
      ? (meta().sessionID as string)
      : typeof meta().sessionId === "string"
        ? (meta().sessionId as string)
        : undefined,
  )
  const rootDelegationID = createMemo(() => {
    if (typeof meta().rootDelegationId === "string") return meta().rootDelegationId as string
    if (typeof meta().delegationId === "string") return meta().delegationId as string
    return undefined
  })
  const isBackground = createMemo(() => Boolean(meta().background))
  // Only set when the caller overrode the model, so the line doubles as the
  // signal that this subagent is not running on the session's own model.
  const modelOverride = createMemo(() => (typeof meta().model === "string" ? meta().model.trim() : ""))
  const kind = createMemo(() => (typeof meta().kind === "string" ? meta().kind : undefined))
  const question = createMemo(() => (typeof meta().question === "string" ? meta().question.trim() : ""))
  const backgroundJob = createMemo(() => {
    const delegationID = rootDelegationID()
    if (!delegationID) return undefined
    return sync.background.get(props.part.sessionID, delegationID)
  })
  const sessionID = createMemo(() => metadataSessionID() ?? backgroundJob()?.workerSessionID)
  const liveSummary = createMemo(() => (typeof meta().liveSummary === "string" ? meta().liveSummary.trim() : ""))
  const derivedLiveSummary = createMemo(() => {
    const child = sessionID()
    if (!child) return ""
    const childMessages = sync.data.message[child] ?? []
    const lastAssistant = childMessages.findLast((message) => message.role === "assistant")
    if (!lastAssistant) return ""
    const parts = sync.data.part[lastAssistant.id] ?? []
    for (let index = parts.length - 1; index >= 0; index--) {
      const part = parts[index]
      if (part.type !== "text" || part.synthetic || part.ignored) continue
      const summary = summarizeTaskPreview(part.text)
      if (summary) return summary
    }
    return ""
  })
  const displaySummary = createMemo(() => liveSummary() || derivedLiveSummary())
  const childStatusLabel = createMemo(() => {
    switch (backgroundJob()?.status) {
      case "running":
        return "running in background"
      case "synthesizing":
        return "synthesizing results"
      case "complete":
        return isBackground() ? "background session ready" : "ready"
      case "cancelled":
        return "background job cancelled"
      case "timeout":
        return "background job timed out"
      case "orphaned":
        return "background job orphaned"
      case "error":
        return "background job errored"
      default:
        return undefined
    }
  })

  const current = createMemo(() => {
    const summary = meta().summary as
      | Array<{
          id: string
          tool: string
          state: { status: string; title?: string }
        }>
      | undefined
    if (!summary || summary.length === 0) return undefined
    for (let i = summary.length - 1; i >= 0; i--) {
      if (summary[i].state.status !== "pending") return summary[i]
    }
    return undefined
  })
  const color = createMemo(() => local.agent.color(input().subagent_type ?? "unknown"))

  // Fall back to metadata.description when the model streamed a title via
  // metadata instead of the `description` parameter (opencode #38100).
  const taskTitle = createMemo(() => {
    const description = input().description
    if (typeof description === "string" && description.trim()) return description
    const metaDesc = meta().description
    if (typeof metaDesc === "string" && metaDesc.trim()) return metaDesc
    return Locale.titlecase(input().subagent_type ?? "unknown")
  })

  const error = createMemo(() => (props.part.state.status === "error" ? props.part.state.error : undefined))

  /**
   * What the card says under its title, in order, one row each.
   *
   * Eleven `<Show>` blocks before this, each with its own condition and its own
   * copy of the same `└ muted text` row. The order they appeared in was the
   * order they happened to be written, no reader could see the whole set, and
   * every card paid for eleven conditional blocks to show two or three lines.
   * A list states the priority, the row shape exists once, and the card
   * rebuilds it only when the list changes.
   *
   * The "open nested session" line is gone: the card draws a `→` when it can be
   * opened, so the sentence was the marker again in words.
   */
  const statusLines = createMemo(() => {
    const lines: { text: string; tone?: "error" | "strong" }[] = []
    const push = (text: string | undefined | false, tone?: "error" | "strong") => {
      const value = typeof text === "string" ? text.trim() : ""
      if (value) lines.push({ text: value, tone })
    }

    // Ordered by what a reader needs first, because the first is all they get
    // until they ask for the rest. What went wrong, then what it is doing now,
    // then what it has produced — and only after that the bookkeeping, which
    // answers a question nobody has while the task is still running.
    push(error(), "error")

    const running = current()
    if (running) {
      const title = running.state.status === "completed" ? (running.state.title ?? "") : ""
      push(`${Locale.titlecase(running.tool)} ${title}`.trim(), running.state.status === "error" ? "error" : undefined)
    }

    if (isBackground()) push(childStatusLabel() || "starting background task")
    else push(childStatusLabel())

    push(displaySummary(), "strong")
    const progress = backgroundJob()?.progressSummary
    if (progress && progress !== displaySummary()) push(progress)
    if (kind() === "research") push(question())

    push(modelOverride())
    const summaryCount = meta().summary?.length
    if (summaryCount) push(`${summaryCount} toolcalls`)
    if (isBackground() && meta().reused) push("reused existing background research")
    if (isBackground() && rootDelegationID()) push(`job ${rootDelegationID()}`)

    return lines
  })

  /**
   * The status list follows the same disclosure rule as everything else: the
   * line that matters, and a mark for the rest.
   *
   * Its own state rather than the card's, because the card's click is already
   * spoken for — it opens the run, which is the better answer and the reason
   * `→` is there. Two different things to reveal, two places to click.
   */
  const [statusOpen, setStatusOpen] = createSignal(false)
  const visibleStatus = createMemo(() => (statusOpen() ? statusLines() : statusLines().slice(0, 1)))
  const hiddenStatus = createMemo(() => Math.max(0, statusLines().length - 1))

  return (
    <box paddingLeft={3} flexShrink={0}>
      <SessionTaskCard
        kind={isBackground() ? "background" : "subtask"}
        color={color()}
        agent={String(input().subagent_type ?? "")}
        title={taskTitle()}
        description={typeof input().description === "string" ? input().description : undefined}
        onClick={
          sessionID()
            ? () =>
                navigate({
                  type: "session",
                  sessionID: sessionID()!,
                  workspaceID: sync.session.get(sessionID()!)?.workspaceID,
                })
            : undefined
        }
      >
        {/* `Index`, not `For`: the memo builds new line objects on every run, and
            `For` reconciles by reference — so a task that is actually running
            tore down and rebuilt its whole status list on every tool call.
            Keyed by position, the rows stay mounted and only their text
            changes, which is what a short positional list wants. */}
        <Index each={visibleStatus()}>
          {(line) => (
            // One row each, clipped rather than wrapped: a long progress summary
            // used to reflow the card to three rows and push the next tool call
            // off the screen.
            <text
              wrapMode="none"
              style={{
                fg:
                  line().tone === "error"
                    ? theme.status.error.fg
                    : line().tone === "strong"
                      ? theme.foreground.default
                      : theme.foreground.muted,
              }}
            >
              └ {line().text}
            </text>
          )}
        </Index>
        <Show when={hiddenStatus() > 0}>
          <text
            wrapMode="none"
            style={{ fg: theme.foreground.subtle }}
            // `onMouseUp`, matching the card's own handler: stopping a
            // mousedown does nothing to the mouseup that follows it, so this
            // mark used to expand the list and then navigate away from it.
            onMouseUp={(event) => {
              event.stopPropagation()
              setStatusOpen((value) => !value)
            }}
          >
            {"  "}
            {statusOpen() ? DISCLOSURE.open : DISCLOSURE.closed} {statusOpen() ? LESS : more(hiddenStatus())}
          </text>
        </Show>
      </SessionTaskCard>
    </box>
  )
}

function Monitor(props: ToolProps<any>) {
  const { theme } = useTheme()
  const dialog = useDialog()

  const meta = props.metadata as Record<string, any>
  const title = createMemo(() => {
    if (typeof meta.title === "string" && meta.title.trim()) return meta.title.trim()
    if (typeof props.input.title === "string" && props.input.title.trim()) return props.input.title.trim()
    if (typeof props.input.command === "string" && props.input.command.trim()) return props.input.command.trim()
    return "monitor"
  })
  const monitorID = createMemo(() => (typeof meta.monitorId === "string" ? meta.monitorId : undefined))
  const sessionID = createMemo(() => (typeof meta.sessionId === "string" ? meta.sessionId : props.part.sessionID))
  const status = createMemo(() => (typeof meta.status === "string" ? meta.status : "running"))
  const recentOutput = createMemo(() => (typeof meta.recentOutput === "string" ? meta.recentOutput.trim() : ""))
  const exitCode = createMemo(() => (typeof meta.exitCode === "number" ? meta.exitCode : undefined))
  const logPath = createMemo(() => (typeof meta.logPath === "string" ? meta.logPath : undefined))
  const statusColor = createMemo(() => {
    if (status() === "complete") return theme.status.success.fg
    if (status() === "running") return theme.foreground.default
    if (status() === "cancelled") return theme.foreground.muted
    return theme.status.error.fg
  })

  const openMonitor = () => {
    if (!monitorID() || !sessionID()) return
    dialog.setSize("xlarge")
    dialog.replace(
      () => (
        <DialogMonitorLog
          sessionID={sessionID()!}
          monitorID={monitorID()!}
          title={title()}
          command={typeof props.input.command === "string" ? props.input.command : meta.command || title()}
          status={status()}
          logPath={logPath()}
        />
      ),
      () => dialog.setSize("medium"),
    )
  }

  /** Same shape as the task card's: ordered by need, collapsed to the first. */
  const monitorStatus = createMemo(() => {
    const lines: { text: string; tone?: "status" }[] = []
    const push = (text: string | undefined, tone?: "status") => {
      const value = text?.trim()
      if (value) lines.push({ text: value, tone })
    }
    push(monitorStatusLabel(status(), exitCode()), "status")
    push(recentOutput())
    if (meta.wake === true) push("wakes the session on completion")
    push(logPath() ? normalizePath(logPath()) : undefined)
    return lines
  })
  const [monitorOpen, setMonitorOpen] = createSignal(false)
  const visibleMonitorStatus = createMemo(() => (monitorOpen() ? monitorStatus() : monitorStatus().slice(0, 1)))
  const hiddenMonitorStatus = createMemo(() => Math.max(0, monitorStatus().length - 1))

  return (
    <Switch>
      <Match when={monitorID()}>
        <BlockTool title={`# Monitor ${title()}`} part={props.part} onClick={openMonitor} opens>
          <box overflow="hidden">
            {/* The command is the monitor's description, and a shell one-liner
                with a `while` loop in it wrapped to five rows. Clipped, like
                every other description in the transcript: the whole of it is in
                the log the title opens. */}
            <text style={{ fg: theme.foreground.muted }} wrapMode="none">
              {props.input.command}
            </text>
            <Index each={visibleMonitorStatus()}>
              {(line) => (
                <text wrapMode="none" style={{ fg: line().tone === "status" ? statusColor() : theme.foreground.muted }}>
                  └ {line().text}
                </text>
              )}
            </Index>
            <Show when={hiddenMonitorStatus() > 0}>
              <text
                wrapMode="none"
                style={{ fg: theme.foreground.subtle }}
                onMouseUp={(event) => {
                  event.stopPropagation()
                  setMonitorOpen((value) => !value)
                }}
              >
                {"  "}
                {monitorOpen() ? DISCLOSURE.open : DISCLOSURE.closed}{" "}
                {monitorOpen() ? LESS : more(hiddenMonitorStatus())}
              </text>
            </Show>
          </box>
        </BlockTool>
      </Match>
      <Match when={true}>
        <InlineTool
          icon="◌"
          pending="Starting monitor..."
          complete={props.input.title ?? props.input.command ?? title()}
          part={props.part}
        >
          Monitor {title()}
        </InlineTool>
      </Match>
    </Switch>
  )
}

function Edit(props: ToolProps<EditShape>) {
  const ctx = use()
  const { theme, syntax } = useTheme()

  const view = createMemo(() => {
    const diffStyle = ctx.sync.data.config.tui?.diff_style
    if (diffStyle === "stacked") return "unified"
    // Default to "auto" behavior
    return ctx.width > 120 ? "split" : "unified"
  })

  const ft = createMemo(() => filetype(props.input.filePath))

  const diffContent = createMemo(() => props.metadata.diff)

  /**
   * One view, two tools, so the title has to say which.
   *
   * `multiedit` carries an `edits` array; counting it is the only thing that
   * distinguishes the two once the diff is rendered, and the count is the part
   * a reader wants — a diff of one change reads differently from a diff of six.
   */
  const editTitle = createMemo(() => {
    const file = normalizePath(props.input.filePath!)
    const edits = (props.input as { edits?: unknown[] }).edits
    if (Array.isArray(edits)) return `← Edit ${file} · ${edits.length} ${edits.length === 1 ? "change" : "changes"}`
    return `← Edit ${file}`
  })

  const diagnostics = createMemo(() => {
    const filePath = Filesystem.normalizePath(props.input.filePath ?? "")
    const arr = props.metadata.diagnostics?.[filePath] ?? []
    return arr.filter((x: Diagnostic) => x.severity === 1).slice(0, 3)
  })

  return (
    <Switch>
      <Match when={props.metadata.diff !== undefined}>
        <BlockTool title={editTitle()} part={props.part}>
          <box paddingLeft={1}>
            <diff
              diff={diffContent()}
              view={view()}
              filetype={ft()}
              syntaxStyle={syntax()}
              showLineNumbers={true}
              width="100%"
              wrapMode={ctx.diffWrapMode()}
              fg={theme.foreground.default}
              addedBg={theme.diff.addedBg}
              removedBg={theme.diff.removedBg}
              contextBg={theme.diff.contextBg}
              addedSignColor={theme.diff.highlightAdded}
              removedSignColor={theme.diff.highlightRemoved}
              lineNumberFg={theme.diff.lineNumber}
              lineNumberBg={theme.diff.contextBg}
              addedLineNumberBg={theme.diff.addedLineNumberBg}
              removedLineNumberBg={theme.diff.removedLineNumberBg}
            />
          </box>
          <Show when={diagnostics().length}>
            <box>
              <For each={diagnostics()}>
                {(diagnostic) => (
                  <text fg={theme.status.error.fg}>
                    Error [{diagnostic.range.start.line + 1}:{diagnostic.range.start.character + 1}]{" "}
                    {diagnosticMessage(diagnostic)}
                  </text>
                )}
              </For>
            </box>
          </Show>
        </BlockTool>
      </Match>
      <Match when={true}>
        <InlineTool icon="←" pending="Preparing edit..." complete={props.input.filePath} part={props.part}>
          Edit {normalizePath(props.input.filePath!)} {input({ replaceAll: props.input.replaceAll })}
        </InlineTool>
      </Match>
    </Switch>
  )
}

function ApplyPatch(props: ToolProps<ApplyPatchShape>) {
  const ctx = use()
  const { theme, syntax } = useTheme()

  const files = createMemo(() => props.metadata.files ?? [])

  const view = createMemo(() => {
    const diffStyle = ctx.sync.data.config.tui?.diff_style
    if (diffStyle === "stacked") return "unified"
    return ctx.width > 120 ? "split" : "unified"
  })

  function Diff(p: { diff: string; filePath: string }) {
    return (
      <box paddingLeft={1}>
        <diff
          diff={p.diff}
          view={view()}
          filetype={filetype(p.filePath)}
          syntaxStyle={syntax()}
          showLineNumbers={true}
          width="100%"
          wrapMode={ctx.diffWrapMode()}
          fg={theme.foreground.default}
          addedBg={theme.diff.addedBg}
          removedBg={theme.diff.removedBg}
          contextBg={theme.diff.contextBg}
          addedSignColor={theme.diff.highlightAdded}
          removedSignColor={theme.diff.highlightRemoved}
          lineNumberFg={theme.diff.lineNumber}
          lineNumberBg={theme.diff.contextBg}
          addedLineNumberBg={theme.diff.addedLineNumberBg}
          removedLineNumberBg={theme.diff.removedLineNumberBg}
        />
      </box>
    )
  }

  function title(file: { type: string; relativePath: string; filePath: string; deletions: number }) {
    if (file.type === "delete") return "# Deleted " + file.relativePath
    if (file.type === "add") return "# Created " + file.relativePath
    if (file.type === "move") return "# Moved " + normalizePath(file.filePath) + " → " + file.relativePath
    return "← Patched " + file.relativePath
  }

  return (
    <Switch>
      <Match when={files().length > 0}>
        <For each={files()}>
          {(file) => (
            <BlockTool title={title(file)} part={props.part}>
              <Show
                when={file.type !== "delete"}
                fallback={
                  <text fg={theme.diff.removed}>
                    -{file.deletions} line{file.deletions !== 1 ? "s" : ""}
                  </text>
                }
              >
                <Diff diff={file.diff} filePath={file.filePath} />
              </Show>
            </BlockTool>
          )}
        </For>
      </Match>
      <Match when={true}>
        <InlineTool icon="%" pending="Preparing apply_patch..." complete={false} part={props.part}>
          apply_patch
        </InlineTool>
      </Match>
    </Switch>
  )
}

function TodoWrite(props: ToolProps<TodoWriteShape>) {
  return (
    <Switch>
      <Match when={props.metadata.todos?.length}>
        <BlockTool title="# Todos" part={props.part}>
          <box>
            <For each={props.input.todos ?? []}>
              {(todo) => <TodoItem status={todo.status} content={todo.content} />}
            </For>
          </box>
        </BlockTool>
      </Match>
      <Match when={true}>
        <InlineTool icon="⚙" pending="Updating todos..." complete={false} part={props.part}>
          Updating todos...
        </InlineTool>
      </Match>
    </Switch>
  )
}

function Question(props: ToolProps<QuestionShape>) {
  const { theme } = useTheme()
  const count = createMemo(() => props.input.questions?.length ?? 0)

  function format(answer?: readonly string[]) {
    if (!answer?.length) return "(no answer)"
    return answer.join(", ")
  }

  return (
    <Switch>
      <Match when={props.metadata.answers}>
        <BlockTool title="# Questions" part={props.part}>
          <box gap={1}>
            <For each={props.input.questions ?? []}>
              {(q, i) => (
                <box flexDirection="column">
                  <text fg={theme.foreground.muted}>{q.question}</text>
                  <text fg={theme.foreground.default}>{format(props.metadata.answers?.[i()])}</text>
                </box>
              )}
            </For>
          </box>
        </BlockTool>
      </Match>
      <Match when={true}>
        <InlineTool icon="→" pending="Asking questions..." complete={count()} part={props.part}>
          Asked {count()} question{count() !== 1 ? "s" : ""}
        </InlineTool>
      </Match>
    </Switch>
  )
}

/**
 * Display spelling for a path in a tool row.
 *
 * Used to differ from the permission prompt's version — it never abbreviated
 * to `~`, so the same file was spelled two ways on one screen.
 */
function normalizePath(input?: string) {
  return formatPath(input, { base: process.cwd(), home: Global.Path.home })
}

function input(input: Record<string, any>, omit?: string[]): string {
  const primitives = Object.entries(input).filter(([key, value]) => {
    if (omit?.includes(key)) return false
    return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
  })
  if (primitives.length === 0) return ""
  return `[${primitives.map(([key, value]) => `${key}=${value}`).join(", ")}]`
}

function filetype(input?: string) {
  if (!input) return "none"
  const ext = path.extname(input)
  const language = LANGUAGE_EXTENSIONS[ext]
  if (["typescriptreact", "javascriptreact", "javascript"].includes(language)) return "typescript"
  return language
}
