import { describe, expect, test } from "bun:test"
import { CURRENT_VERSION, parseWorkspace, serializeWorkspace } from "../session/persist"
import {
  addPane,
  createWorkbench,
  fromWorkspaceState,
  isResumable,
  restoredStatus,
  sessionsToResume,
  toWorkspaceState,
  type Pane,
} from "./state"

/*
 * What "the sessions survive" can actually mean.
 *
 * A pty is a child of the app: closing the window kills it, and a machine
 * restart kills everything. No process survives. What survives is the
 * session's identity — its agent, its directory, the task it was given and
 * what it said — and starting that work again on open is the promise this
 * code has to keep.
 */

const session = (over: Partial<Pane> = {}): Pane => ({
  id: "p1",
  title: "agy · rifattorizza",
  status: "working",
  model: "agy",
  mode: "auto",
  agent: "agy",
  cwd: "C:/repo/proj",
  task: "rifattorizza il parser",
  lines: [
    { kind: "step", text: "Letto src/parser.ts" },
    { kind: "shell", text: "bun test" },
  ],
  workspaceId: "proj",
  ...over,
})

/** One save/restore cycle, through the real serialiser. */
function roundTrip(panes: Pane[]) {
  let wb = createWorkbench()
  for (const pane of panes) wb = addPane(wb, pane)
  const saved = parseWorkspace(serializeWorkspace(toWorkspaceState(wb)))
  if (!saved) throw new Error("lo stato salvato non si rilegge")
  return { saved, restored: fromWorkspaceState(saved, "proj") }
}

describe("isResumable", () => {
  test("a live session with a task is", () => {
    expect(isResumable(session())).toBe(true)
    expect(isResumable(session({ status: "waiting" }))).toBe(true)
  })

  test("a finished or failed one is not: there is nothing to resume", () => {
    expect(isResumable(session({ status: "done" }))).toBe(false)
    expect(isResumable(session({ status: "error" }))).toBe(false)
  })

  /*
   * The guard that matters. Relaunching an agent with an empty prompt is not
   * resuming a session, it is opening a new one wearing the same name — and
   * doing it unasked, on every start, for every pane ever left open.
   */
  test("no task means no resume, whatever the status said", () => {
    expect(isResumable(session({ task: undefined }))).toBe(false)
    expect(isResumable(session({ task: "   " }))).toBe(false)
  })

  test("a browser pane and a file pane are not sessions", () => {
    expect(isResumable(session({ browserUrl: "http://localhost:3000" }))).toBe(false)
    expect(isResumable(session({ filePath: "src/a.ts" }))).toBe(false)
  })
})

describe("restoredStatus", () => {
  test("anything that was live becomes done: the process is gone", () => {
    expect(restoredStatus("working")).toBe("done")
    expect(restoredStatus("waiting")).toBe("done")
    expect(restoredStatus("provisioning")).toBe("done")
  })

  test("how a session ended outlives the app that ran it", () => {
    expect(restoredStatus("error")).toBe("error")
    expect(restoredStatus("done")).toBe("done")
  })

  test("a status from a corrupt store does not reach the interface", () => {
    expect(restoredStatus("running")).toBe("done")
    expect(restoredStatus("")).toBe("done")
  })
})

describe("saving and restoring a session", () => {
  test("the task survives, so the work can be started again", () => {
    const { saved } = roundTrip([session()])
    expect(saved.panes[0].task).toBe("rifattorizza il parser")
    expect(saved.panes[0].wasRunning).toBe(true)
  })

  /*
   * Before, every restored pane held exactly one line saying the process was
   * gone — true, and the only thing the user could no longer check, because
   * the output that would have told them what the agent did was discarded
   * along with it.
   */
  test("the transcript survives, with the death appended rather than replacing it", () => {
    const { restored } = roundTrip([session()])
    const texts = restored.panes[0].lines.map((line) => line.text)
    expect(texts[0]).toBe("Letto src/parser.ts")
    expect(texts[1]).toBe("bun test")
    expect(texts[2]).toContain("Sessione ripristinata")
  })

  test("a session that was running says it is being picked up again", () => {
    const { restored } = roundTrip([session()])
    expect(restored.panes[0].activity).toBe("toResume")
    expect(restored.panes[0].lines.at(-1)?.text).toContain("riprendo il compito")
  })

  test("a finished agent session is brought back too, and says so", () => {
    // The workbench reopens every agent pane on launch, not only the live ones.
    const { restored } = roundTrip([session({ status: "done" })])
    expect(restored.panes[0].activity).toBe("restored")
    expect(restored.panes[0].lines.at(-1)?.text).toContain("riprendo")
  })

  test("sessionsToResume names exactly the ones that were live and have a task", () => {
    const { saved } = roundTrip([
      session({ id: "live" }),
      session({ id: "finita", status: "done" }),
      session({ id: "senza-compito", task: undefined }),
      session({ id: "browser", browserUrl: "http://localhost:3000" }),
    ])

    expect(sessionsToResume(saved).map((pane) => pane.id)).toEqual(["live"])
  })

  test("a browser pane is not saved as a session", () => {
    const { saved } = roundTrip([session({ id: "b", browserUrl: "http://localhost:3000" })])
    expect(saved.panes).toHaveLength(0)
    expect(sessionsToResume(saved)).toHaveLength(0)
  })

  test("what is written is the current schema version", () => {
    const { saved } = roundTrip([session()])
    expect(saved.version).toBe(CURRENT_VERSION)
  })
})

describe("a store written by an older ADE", () => {
  /*
   * v2 has no record of what any session was asked to do, so those panes
   * restore visible and inert. Resuming them would mean launching agents with
   * empty prompts — which is why the migration adds nothing and claims
   * nothing.
   */
  test("v2 panes are restored and never resumed", () => {
    const v2 = JSON.stringify({
      version: 2,
      panes: [{ id: "p1", title: "agy", agent: "agy", cwd: "C:/repo", branch: "main", status: "working" }],
      focusedPaneId: "p1",
      currentView: "plancia",
      sidebarWidth: 260,
      projectPath: "C:/repo",
    })

    const saved = parseWorkspace(v2)
    expect(saved).toBeDefined()
    expect(saved!.version).toBe(CURRENT_VERSION)
    expect(saved!.panes[0].id).toBe("p1")
    expect(sessionsToResume(saved!)).toEqual([])

    const restored = fromWorkspaceState(saved!)
    expect(restored.panes[0].status).toBe("done")
  })

  test("a v1 store still migrates the whole way up", () => {
    const v1 = JSON.stringify({
      version: 1,
      panes: [{ id: "p1", title: "agy", agent: "agy", cwd: "C:/repo", branch: "main", status: "done" }],
      view: "plancia",
    })

    const saved = parseWorkspace(v1)
    expect(saved?.version).toBe(CURRENT_VERSION)
    expect(saved?.currentView).toBe("plancia")
  })
})

describe("a damaged store", () => {
  test("a line claiming an unknown kind is not carried into the interface", () => {
    const hostile = JSON.stringify({
      version: CURRENT_VERSION,
      panes: [
        {
          id: "p1",
          title: "t",
          agent: "agy",
          cwd: "C:/repo",
          branch: "main",
          status: "done",
          lines: [
            { kind: 'error" onload=alert(1)', text: "ciao" },
            { kind: 42, text: "due" },
            { text: "senza tipo" },
            "non un oggetto",
          ],
        },
      ],
      currentView: "plancia",
      sidebarWidth: 260,
    })

    const saved = parseWorkspace(hostile)
    expect(saved?.panes[0].lines?.map((line) => line.kind)).toEqual(["note", "note", "note"])
  })

  test("a line without text is dropped rather than rendered empty", () => {
    const saved = parseWorkspace(
      JSON.stringify({
        version: CURRENT_VERSION,
        panes: [{ id: "p1", title: "t", agent: "a", cwd: "", branch: "", status: "done", lines: [{ kind: "step" }] }],
        currentView: "plancia",
        sidebarWidth: 260,
      }),
    )
    expect(saved?.panes[0].lines).toEqual([])
  })
})

/*
 * The user's report: after switching project and back, and after a restart,
 * the browser pane showed http://localhost:3000/ ("Server non raggiungibile")
 * instead of the page they had opened. The pane has to come back on its own
 * page, with the way back to the pages before it.
 */
describe("browser panes across a restart", () => {
  const browser = (over: Partial<Pane> = {}): Pane => ({
    id: "b1",
    title: "Browser",
    status: "working",
    model: "—",
    mode: "browser",
    lines: [],
    workspaceId: "sito",
    browserUrl: "https://bastelli-cmp.vercel.app/#top",
    browserHistory: {
      entries: [
        "http://localhost:3000/",
        "https://bastelli-cmp.vercel.app/#top",
        "https://bastelli-cmp.vercel.app/catalogo",
      ],
      index: 1,
    },
    ...over,
  })

  test("comes back on the page it showed, in its own project, with its history", () => {
    const { restored } = roundTrip([session(), browser({ span: { columns: 2, rows: 1 } })])
    const pane = restored.panes.find((p) => p.id === "b1")
    expect(pane?.browserUrl).toBe("https://bastelli-cmp.vercel.app/#top")
    expect(pane?.browserHistory).toEqual(browser().browserHistory)
    expect(pane?.workspaceId).toBe("sito")
    expect(pane?.mode).toBe("browser")
    expect(pane?.span).toEqual({ columns: 2, rows: 1 })
    expect(restored.panes.map((p) => p.id)).toEqual(["p1", "b1"])
  })

  test("comes back bound to the same session (S46)", () => {
    const { restored } = roundTrip([session(), browser({ browserOwner: { id: "p1", title: "agy · rifattorizza" } })])
    expect(restored.panes.find((p) => p.id === "b1")?.browserOwner).toEqual({ id: "p1", title: "agy · rifattorizza" })
    expect(roundTrip([browser()]).restored.panes[0].browserOwner).toBeUndefined()
  })

  test("a damaged binding is dropped, the pane is kept", () => {
    const saved = parseWorkspace(
      JSON.stringify({
        version: CURRENT_VERSION,
        panes: [],
        browsers: [
          { id: "b1", title: "B", url: "https://a.test/", owner: { title: "senza id" } },
          { id: "b2", title: "B", url: "https://a.test/", owner: "n1-1" },
          { id: "b3", title: "B", url: "https://a.test/", owner: { id: "n1-1" } },
        ],
        currentView: "code",
        sidebarWidth: 260,
      }),
    )
    expect(saved?.browsers?.map((b) => b.owner)).toEqual([undefined, undefined, { id: "n1-1", title: "" }])
  })

  test("a pane that never navigated comes back on its URL, with no history to restore", () => {
    const { restored } = roundTrip([browser({ browserUrl: "http://localhost:3000", browserHistory: undefined })])
    expect(restored.panes[0].browserUrl).toBe("http://localhost:3000")
    expect(restored.panes[0].browserHistory).toBeUndefined()
  })

  test("a damaged entry is dropped, and a history that does not match its URL starts over", () => {
    const saved = parseWorkspace(
      JSON.stringify({
        version: CURRENT_VERSION,
        panes: [],
        browsers: [
          { id: "senza-url", title: "x" },
          { title: "senza-id", url: "https://a.test/" },
          { id: "b2", title: "B", url: "https://a.test/", history: { entries: ["https://z.test/"], index: 0 } },
          { id: "b3", title: "C", url: "https://a.test/", history: { entries: ["https://a.test/"], index: 7 } },
        ],
        currentView: "code",
        sidebarWidth: 260,
      }),
    )
    expect(saved?.browsers?.map((b) => b.id)).toEqual(["b2", "b3"])
    expect(saved?.browsers?.[0].history).toEqual({ entries: ["https://a.test/"], index: 0 })
    expect(saved?.browsers?.[1].history).toEqual({ entries: ["https://a.test/"], index: 0 })
  })

  test("a state saved before browser panes were kept still reads, with none", () => {
    const saved = parseWorkspace(
      JSON.stringify({ version: CURRENT_VERSION, panes: [], currentView: "code", sidebarWidth: 260 }),
    )
    expect(saved?.browsers).toEqual([])
    expect(fromWorkspaceState(saved!, "proj").panes).toEqual([])
  })

  test("what is saved carries no credentials from the URL or the history", () => {
    const { saved, restored } = roundTrip([
      browser({
        browserUrl: "http://localhost:8888/lab?token=SECRET",
        browserHistory: {
          entries: ["https://a.test/cb?code=C1&state=s", "http://localhost:8888/lab?token=SECRET"],
          index: 1,
        },
      }),
    ])
    expect(JSON.stringify(saved)).not.toContain("SECRET")
    expect(JSON.stringify(saved)).not.toContain("C1")
    expect(restored.panes[0].browserUrl).toBe("http://localhost:8888/lab")
    expect(restored.panes[0].browserHistory).toEqual({
      entries: ["https://a.test/cb?state=s", "http://localhost:8888/lab"],
      index: 1,
    })
  })

  test("a plugin tile is not saved as a browser pane", () => {
    const { saved } = roundTrip([browser({ plugin: { pluginId: "x", name: "X" } })])
    expect(saved.browsers ?? []).toHaveLength(0)
  })
})
