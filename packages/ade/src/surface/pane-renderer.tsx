import { Show, createMemo } from "solid-js"
import { BrowserPane } from "../browser"
import { FilePane, editBuffer, revertBuffer } from "../editor"
import { SessionPane } from "../grid/pane"
import type { GridPane } from "../grid/session-grid"
import type { SpawnedSession } from "../host/shell"
import type { Project } from "../host/project"
import { PluginPane } from "../plugin/pane"
import type { AdePluginRuntime } from "../plugin/runtime"
import { AgentMark } from "../session-new/agent-mark"
import { formatCost, formatTokens } from "../session/metrics"
import type { PermissionAnswer } from "../session/permission"
import { formatDroppedPaths } from "../sidebar/file-drag"
import { runVideoCommand } from "../video/commands"
import { VIDEO_VERBS } from "../video/video"
import { VideoPane } from "../video/video-pane"
import { runModelCommand } from "../model3d/commands"
import { MODEL_VERBS } from "../model3d/model"
import { ModelPane } from "../model3d/model-pane"
import type { DirEntry } from "../host/shell"
import { runSimulatorCommand } from "../simulator/commands"
import { SIMULATOR_VERBS, type DevServerGuess } from "../simulator/simulator"
import { SimulatorPane } from "../simulator/simulator-pane"
import { createPanelStack } from "../panels/stack"
import { DecisionsPane } from "../decisions/decisions-pane"
import type { DecisionsHub } from "../decisions/hub"
import type { PanelRouter } from "../panels/router"
import type { PaneRecords } from "./pane-records"
import { expandPane, isPanelPane, updatePane, type Pane, type Workbench as WorkbenchState } from "./state"
import { bindChoices, ownerStatus, type BrowserController } from "../browser/binding"
import type { BrowserRequest, Rect } from "../browser/request"
import { t } from "../i18n"

/**
 * What each tile in the grid actually draws.
 *
 * Five kinds of pane — a session, a file, a browser, a video, a plugin's own
 * body — chosen from the pane's own shape and wired to the surface around
 * them. It was three hundred lines in the middle of `workbench.tsx`, which is
 * where it grew every time a kind was added and where the two `<Show>` chains
 * that pick between them were easiest to get wrong.
 *
 * A `.tsx`, so none of it is reachable from `bun test` in this repo. That is
 * the honest cost of moving it: what this file buys is a boundary, not
 * coverage. Everything it decides that *can* be tested has been pushed out
 * already — `pane-records.ts` for the per-pane state, `video/commands.ts` for
 * what the video panel does, `panels/router.ts` for who answers an agent.
 */

export interface PaneRendererDeps {
  wb: () => WorkbenchState
  setWb: (next: WorkbenchState | ((current: WorkbenchState) => WorkbenchState)) => void
  project: () => Project | undefined
  /** The seven maps keyed by pane id. */
  records: PaneRecords
  /** Which panes have an xterm worth drawing. */
  liveTerminals: () => Set<string>
  isRunning: (id: string) => boolean
  /** The live process behind a pane, if there is one. */
  sessionFor: (id: string) => SpawnedSession | undefined
  appendLine: (id: string, text: string, kind?: "step" | "shell" | "note") => void
  close: (id: string) => void
  saveFile: (id: string) => void
  answerPermission: (id: string, answer: PermissionAnswer) => void
  /** "Riprova" on a session that failed. */
  /** Starts the pane's agent again, reopening its conversation; `line` is sent once it is ready. */
  restart: (pane: Pane, line?: string) => void
  /** The native file picker, narrowed to what the player can open. */
  pickVideo: () => Promise<string | undefined>
  /** The native file picker, narrowed to the formats the 3D panel reads. */
  pickModel: () => Promise<string | undefined>
  /** A project file's bytes, for the 3D panel; absent when the host cannot. */
  readBytes?: (path: string, maxBytes: number) => Promise<Uint8Array>
  /** A directory listing, for the 3D panel's change watcher. */
  readDir?: (path: string) => Promise<DirEntry[]>
  /** Where the open project's dev server probably is, for the simulator. */
  guessServers: () => Promise<DevServerGuess[]>
  /** The project's decisions register, shared with the bar's badge and window. */
  decisions: DecisionsHub
  /** Writes a captured frame and resolves to where it went. */
  captureFrame: (name: string, png: Uint8Array) => Promise<string>
  /** Where an agent's `@ade …` requests are routed. */
  panels: PanelRouter
  /** Tells every running session that a panel it can drive has opened. */
  announceToAll: (panel: string) => void
  pluginRuntime: AdePluginRuntime
  /** Each mounted browser pane's controls, for `@ade browser …`. */
  browserControllers: Map<string, BrowserController>
  /** Writes a browser request's details and picture, and queues its line for session `to` (S46). */
  sendBrowserRequest: (
    to: string,
    request: BrowserRequest,
    capture: { crop: Rect; redact: Rect[]; scale: number },
  ) => Promise<{ ok: true } | { ok: false; reason: string; stopped?: boolean }>
}

export function createPaneRenderer(deps: PaneRendererDeps) {
  const { wb, setWb, project, records, panels, pluginRuntime } = deps
  const { buffers, bufferLoading, reports, permissions } = records
  /* Panes of one kind share a panel name; see `panels/stack.ts`. */
  const stacks = {
    video: createPanelStack(panels, "video"),
    model: createPanelStack(panels, "model"),
    app: createPanelStack(panels, "app"),
  }

  /*
   * The rendered tile is built once per pane and kept.
   *
   * The grid calls `render()` from a reactive position, so rebuilding the
   * entry would throw the pane's DOM away and build it again on every
   * workbench change — focus included. See the comment on `current` below for
   * what that cost.
   */
  const cache = new Map<string, GridPane>()

  return createMemo<GridPane[]>(() => {
    const state = wb()
    const activeIds = new Set(state.panes.map((p) => p.id))
    for (const id of cache.keys()) {
      if (!activeIds.has(id)) cache.delete(id)
    }

    /*
     * One project's sessions at a time.
     *
     * A grid mixing two projects tiles six terminals that share nothing — and
     * every one of them looks alike. The sessions of the projects you are not
     * in keep running and keep their scrollback; the sidebar still counts
     * them, and switching project brings them straight back.
     */
    const owner = project()?.name
    const mine = owner ? state.panes.filter((p) => p.workspaceId === owner) : state.panes
    const currentPanes = state.expandedId ? mine.filter((p) => p.id === state.expandedId) : mine

    return currentPanes.map((p) => {
      let entry = cache.get(p.id)
      if (!entry) {
        entry = { id: p.id, render: () => renderPane(deps, p) }
        cache.set(p.id, entry)
      }
      return entry
    })
  })

  function renderPane(deps: PaneRendererDeps, p: Pane) {
    /*
     * The pane as it is now, not as it was when the tile was built.
     *
     * Which kind of pane this is has to be asked through <Show>, not an `if`.
     * The grid calls `render()` from a reactive position, so an `if` reading
     * the workbench here subscribes the whole pane to every workbench change
     * — and focus is a workbench change. Pressing a pane fires pointerdown,
     * which focuses it, which threw the pane's DOM away and built it again:
     * mouseup then landed on a node that no longer existed, so no click was
     * ever produced and the header buttons did nothing. <Show> keeps the read
     * inside its own memo, so only an actual change of kind rebuilds anything.
     */
    const current = () => wb().panes.find((x) => x.id === p.id) ?? p
    const focus = () => setWb((w) => ({ ...w, focusedId: current().id }))
    const expand = () => setWb((w) => expandPane(w, current().id))
    const isFocused = () => current().id === wb().focusedId
    /** The agent sessions of this pane's project, running or not. */
    const projectSessions = () =>
      wb()
        .panes.filter(
          (pane) => pane.workspaceId === current().workspaceId && !isPanelPane(pane) && (pane.agent ?? pane.model),
        )
        .map((pane) => ({ id: pane.id, title: pane.title, running: deps.isRunning(pane.id) }))

    const filePane = () => (
      <FilePane
        path={current().filePath!}
        buffer={buffers()[current().id]}
        loading={bufferLoading()[current().id]}
        focused={isFocused()}
        onFocus={focus}
        onChange={(draft) => buffers.update(current().id, (buffer) => (buffer ? editBuffer(buffer, draft) : buffer))}
        onSave={() => deps.saveFile(current().id)}
        onRevert={() => buffers.update(current().id, (buffer) => (buffer ? revertBuffer(buffer) : buffer))}
        onClose={() => deps.close(current().id)}
        onExpand={expand}
      />
    )

    const browserPane = () => (
      <BrowserPane
        id={current().id}
        title={current().title}
        initialUrl={current().browserUrl}
        initialHistory={current().browserHistory}
        onNavigate={(url, history) =>
          setWb((w) => updatePane(w, current().id, { browserUrl: url, browserHistory: history }))
        }
        focused={isFocused()}
        onFocus={focus}
        onClose={() => deps.close(current().id)}
        onExpand={expand}
        owner={ownerStatus(current().browserOwner, projectSessions())}
        sessions={bindChoices(projectSessions())}
        onBind={(sessionId) => {
          const session = sessionId ? wb().panes.find((pane) => pane.id === sessionId) : undefined
          setWb((w) =>
            updatePane(w, current().id, {
              browserOwner: session ? { id: session.id, title: session.title } : undefined,
            }),
          )
        }}
        onFocusOwner={() => {
          const ownerId = current().browserOwner?.id
          if (ownerId) setWb((w) => ({ ...w, focusedId: ownerId }))
        }}
        onController={(controller) => {
          if (controller) deps.browserControllers.set(current().id, controller)
          else deps.browserControllers.delete(current().id)
        }}
        /*
         * Goes to the session the pane chose: the one it is bound to, or the
         * one the user picked when asked (S46). It arrives as a message, at
         * the end of the session's turn; a session that stopped meanwhile
         * reaches nobody, and the pane asks again.
         */
        onSendRequest={(request, capture, to) => deps.sendBrowserRequest(to, request, capture)}
      />
    )

    const videoPane = () => (
      <VideoPane
        id={current().id}
        title={current().title}
        path={current().videoPath ?? ""}
        focused={isFocused()}
        onOpen={(path) => setWb((w) => updatePane(w, current().id, { videoPath: path }))}
        onPick={() => deps.pickVideo()}
        onCapture={(name, png) => deps.captureFrame(name, png)}
        onController={(controller) => {
          /*
           * One panel name, not one per pane.
           *
           * The agent writes `@ade video play`; it has no pane id and no way
           * to get one. With two video panes open the second to mount is the
           * one that answers, which is the one the user just opened — the
           * least surprising of the wrong answers available.
           */
          if (controller) {
            stacks.video.push(current().id, {
              verbs: VIDEO_VERBS,
              run: (request) => runVideoCommand(controller, request),
            })
            deps.announceToAll("video")
          } else {
            stacks.video.remove(current().id)
          }
        }}
        onFocus={focus}
        onClose={() => deps.close(current().id)}
        onExpand={expand}
      />
    )

    const modelPane = () => (
      <ModelPane
        id={current().id}
        title={current().title}
        path={current().modelPath ?? ""}
        focused={isFocused()}
        onOpen={(path) => setWb((w) => updatePane(w, current().id, { modelPath: path }))}
        onPick={() => deps.pickModel()}
        readBytes={deps.readBytes}
        readDir={deps.readDir}
        onCapture={(name, png) => deps.captureFrame(name, png)}
        onController={(controller) => {
          // One panel name for every 3D pane, as for video: the last opened answers.
          if (controller) {
            stacks.model.push(current().id, {
              verbs: MODEL_VERBS,
              run: (request) => runModelCommand(controller, request),
            })
            deps.announceToAll("model")
          } else {
            stacks.model.remove(current().id)
          }
        }}
        onFocus={focus}
        onClose={() => deps.close(current().id)}
        onExpand={expand}
      />
    )

    const decisionsPane = () => (
      <DecisionsPane
        hub={deps.decisions}
        focused={isFocused()}
        onFocus={focus}
        onClose={() => deps.close(current().id)}
        onExpand={expand}
      />
    )

    const simulatorPane = () => (
      <SimulatorPane
        id={current().id}
        title={current().title}
        url={current().appUrl ?? ""}
        deviceId={current().appDevice}
        landscape={current().appLandscape}
        windowSize={current().appWindow}
        focused={isFocused()}
        onChange={(patch) => setWb((w) => updatePane(w, current().id, patch))}
        guessServers={() => deps.guessServers()}
        onController={(controller) => {
          if (controller) {
            stacks.app.push(current().id, {
              verbs: SIMULATOR_VERBS,
              run: (request) => runSimulatorCommand(controller, request),
            })
            deps.announceToAll("app")
          } else {
            stacks.app.remove(current().id)
          }
        }}
        onFocus={focus}
        onClose={() => deps.close(current().id)}
        onExpand={expand}
      />
    )

    /* A session whose process is gone — exited, failed, or restored from disk. */
    const restartable = () =>
      !deps.isRunning(current().id) &&
      Boolean(current().agent ?? current().model) &&
      (current().status === "done" || current().status === "error")

    const sessionPane = () => (
      <SessionPane
        id={current().id}
        title={current().title}
        status={current().status}
        /* What the agent says it is doing beats the label ADE guessed. */
        activity={reports()[current().id]?.activity ?? current().activity}
        elapsed={current().elapsed}
        tokens={(() => {
          const count = reports()[current().id]?.tokens
          return count === undefined ? current().tokens : `${formatTokens(count)} token`
        })()}
        cost={(() => {
          const spent = reports()[current().id]?.costUsd
          return spent === undefined ? undefined : formatCost(spent)
        })()}
        model={current().model}
        mode={current().mode}
        agent={current().agent}
        glyph={<AgentMark id={current().agent ?? current().model} size={14} />}
        tree={current().tree}
        terminalId={deps.liveTerminals().has(current().id) ? current().id : undefined}
        onInput={(data) => {
          const session = deps.sessionFor(current().id)
          if (!session) return
          // Enter typed straight into the terminal submits a turn, exactly as
          // the composer does; the quiet timer brings the pane back to idle.
          // …and a turn of its own, after which a repeated `@ade` line is a new request.
          if (data.includes("\r")) deps.panels.newTurn(current().id)
          if (data.includes("\r") && current().status === "idle") {
            deps.setWb((w) => updatePane(w, current().id, { status: "working", activity: "running" }))
          }
          session.write(data)
        }}
        /*
         * The paths, and not a keystroke more.
         *
         * Relative to the project when they are inside it, quoted when they
         * contain a space — a screenshot filename carries spaces and a date,
         * and an unquoted one reaches the agent as three arguments. No
         * newline: the drag said which agent gets the file, it did not say
         * what to ask about it.
         *
         * Offered on every session, not only a running one. A drop onto a
         * finished session used to be discarded in silence, which is
         * indistinguishable from a drop that missed; now it says so in the
         * transcript.
         */
        onDropPath={(paths) => {
          const text = formatDroppedPaths(paths, project()?.root)
          if (!text) return

          focus()

          const session = deps.sessionFor(current().id)
          if (session) {
            session.write(`${text} `)
            return
          }
          deps.appendLine(current().id, t("pane.notDelivered", text), "note")
        }}
        onResize={(cols, rows) => deps.sessionFor(current().id)?.resize(cols, rows)}
        onSubmit={
          deps.isRunning(current().id)
            ? (line) => {
                // The composer types into the terminal like a keyboard would,
                // carriage return included: the CLI cannot tell the
                // difference, which is the point.
                deps.setWb((w) => updatePane(w, current().id, { status: "working", activity: "running" }))
                deps.sessionFor(current().id)?.write(`${line}\r`)
              }
            : restartable()
              ? // No process: writing to the session starts it again, the way
                // pressing Enter in a closed terminal tab would reopen it.
                (line) => deps.restart(current(), line)
              : undefined
        }
        actions={
          /*
           * The buttons exist only when the agent actually asked something:
           * they are its own choices, in its own order, and pressing one
           * writes exactly the string it is waiting for.
           */
          permissions()[current().id]
            ? permissions()[current().id].answers.map((answer) => ({
                label: answer.label,
                tone: answer.tone,
                onClick: () => deps.answerPermission(current().id, answer),
              }))
            : restartable()
              ? [
                  {
                    label: current().status === "error" ? "Riprova" : "Riprendi",
                    tone: "primary" as const,
                    onClick: () => deps.restart(current()),
                  },
                ]
              : undefined
        }
        lines={current().lines}
        focused={isFocused()}
        onFocus={focus}
        onClose={() => deps.close(current().id)}
        onExpand={expand}
        /* Into the workspace, so the name survives a restart like the pane does. */
        onRename={(title) => deps.setWb((w) => updatePane(w, current().id, { title }))}
      />
    )

    /*
     * The plugin's own body, looked up every time it is drawn.
     *
     * `definitionFor` reads the registry signal, so a plugin torn down while
     * one of its tiles is open makes this fall to the "not available" branch
     * rather than calling a `render` whose closure belongs to a disposed
     * plugin.
     */
    const pluginPane = () => (
      <PluginPane
        id={current().id}
        title={current().title}
        focused={isFocused()}
        onFocus={focus}
        onClose={() => deps.close(current().id)}
        onExpand={expand}
        render={() => {
          const definition = pluginRuntime.registry.definitionFor(current().id)
          if (!definition) {
            return <div data-slot="pane-plugin-error">{t("pane.pluginGone")}</div>
          }
          const tile = pluginRuntime.registry.open().find((item) => item.id === current().id)
          return definition.render({ data: tile?.data })
        }}
      />
    )

    return (
      <Show
        when={current().plugin}
        fallback={
          <Show
            when={current().filePath}
            fallback={
              <Show
                when={current().browserUrl}
                fallback={
                  /*
                   * Tested on the mode, not on the path: a video pane opens empty
                   * and `videoPath` is "" until a file is chosen, so asking for the
                   * path drew a terminal in a pane with no session behind it and no
                   * way to get one.
                   */
                  <Show
                    when={current().mode === "video"}
                    fallback={
                      <Show
                        when={current().mode === "model"}
                        fallback={
                          <Show
                            when={current().mode === "app"}
                            fallback={
                              <Show when={current().mode === "decisions"} fallback={sessionPane()}>
                                {decisionsPane()}
                              </Show>
                            }
                          >
                            {simulatorPane()}
                          </Show>
                        }
                      >
                        {modelPane()}
                      </Show>
                    }
                  >
                    {videoPane()}
                  </Show>
                }
              >
                {browserPane()}
              </Show>
            }
          >
            {filePane()}
          </Show>
        }
      >
        {pluginPane()}
      </Show>
    )
  }
}
