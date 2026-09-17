import { describe, expect, test } from "bun:test"
import { parseRequest } from "../panels/protocol"
import {
  bindChoices,
  ownerStatus,
  planSend,
  runBrowserCommand,
  type BrowserCommandHost,
  type BrowserController,
  type BrowserOwner,
} from "./binding"

const claude = { id: "n1-1", title: "Claude", running: true }
const agy = { id: "n1-2", title: "agy", running: true }
const closed = { id: "n1-3", title: "Codex", running: false }

describe("ownerStatus", () => {
  test("no binding", () => {
    expect(ownerStatus(undefined, [claude])).toEqual({ state: "none" })
  })

  test("bound to a running session, under its current title", () => {
    expect(ownerStatus({ id: "n1-1", title: "old name" }, [claude, agy])).toEqual({
      state: "ready",
      id: "n1-1",
      title: "Claude",
    })
  })

  test("bound to a session that stopped or is gone keeps its name", () => {
    expect(ownerStatus({ id: "n1-3", title: "Codex" }, [claude, closed])).toEqual({
      state: "closed",
      id: "n1-3",
      title: "Codex",
    })
    expect(ownerStatus({ id: "gone", title: "Kimi" }, [claude])).toEqual({ state: "closed", id: "gone", title: "Kimi" })
  })
})

describe("planSend", () => {
  test("goes to the bound session only while it runs", () => {
    expect(planSend(ownerStatus({ id: "n1-2", title: "agy" }, [claude, agy]))).toEqual({ kind: "send", to: "n1-2" })
  })

  test("asks when unbound or when the bound session is closed, never picks another", () => {
    expect(planSend(ownerStatus(undefined, [claude, agy]))).toEqual({ kind: "ask" })
    expect(planSend(ownerStatus({ id: "n1-3", title: "Codex" }, [claude, closed]))).toEqual({ kind: "ask" })
  })

  test("only running sessions are offered", () => {
    expect(bindChoices([claude, closed, agy])).toEqual([claude, agy])
  })
})

describe("@ade browser", () => {
  function makeHost(sessions: BrowserOwner[] = [{ id: "n1-1", title: "Claude" }]) {
    const panes: { id: string; title: string; owner: string; url: string }[] = []
    const calls: string[] = []
    const controller: BrowserController = {
      reload: () => calls.push("reload"),
      setInspect: (on) => calls.push(`inspect ${on}`),
      state: () => ({ url: "http://localhost:5173/", inspecting: false, fidelity: "Nativo", selected: 2 }),
    }
    let visible = true
    const host: BrowserCommandHost = {
      session: (id) => sessions.find((session) => session.id === id),
      ownedPane: (owner) => panes.filter((pane) => pane.owner === owner).at(-1),
      openPane: (url, owner) => {
        const pane = { id: `b${panes.length + 1}`, title: "Browser", owner: owner.id, url }
        panes.push(pane)
        return pane
      },
      navigate: (id, url) => {
        panes.find((pane) => pane.id === id)!.url = url
      },
      controller: () => (visible ? controller : undefined),
    }
    return { host, panes, calls, hide: () => (visible = false) }
  }
  const run = (host: BrowserCommandHost, line: string, from?: string) =>
    runBrowserCommand(host, parseRequest(line)!, from)

  test("open creates a pane bound to the session that asked", async () => {
    const { host, panes } = makeHost()
    const outcome = await run(host, "@ade browser open :5173", "n1-1")
    expect(outcome).toEqual({ ok: true, detail: "aperto «Browser» su http://localhost:5173, legato a te" })
    expect(panes).toEqual([{ id: "b1", title: "Browser", owner: "n1-1", url: "http://localhost:5173" }])
  })

  test("open again moves the session's own pane instead of opening another", async () => {
    const { host, panes } = makeHost()
    await run(host, "@ade browser open :5173", "n1-1")
    const outcome = await run(host, "@ade browser open localhost:3000/settings", "n1-1")
    expect(outcome.ok).toBe(true)
    expect(panes).toHaveLength(1)
    expect(panes[0]!.url).toBe("http://localhost:3000/settings")
  })

  test("open refuses a bad address and a requester that is not a session", async () => {
    const { host, panes } = makeHost()
    expect((await run(host, "@ade browser open javascript:alert(1)", "n1-1")).ok).toBe(false)
    expect((await run(host, "@ade browser open", "n1-1")).ok).toBe(false)
    expect((await run(host, "@ade browser open :5173", "stranger")).ok).toBe(false)
    expect((await run(host, "@ade browser open :5173")).ok).toBe(false)
    expect(panes).toEqual([])
  })

  test("reload, inspect and state act on the requester's own pane", async () => {
    const { host, calls } = makeHost([
      { id: "n1-1", title: "Claude" },
      { id: "n1-2", title: "agy" },
    ])
    await run(host, "@ade browser open :5173", "n1-1")
    expect((await run(host, "@ade browser reload", "n1-2")).ok).toBe(false)
    expect(calls).toEqual([])

    expect(await run(host, "@ade browser reload", "n1-1")).toEqual({ ok: true, detail: "«Browser» ricaricato" })
    expect((await run(host, "@ade browser inspect on", "n1-1")).ok).toBe(true)
    expect((await run(host, "@ade browser inspect maybe", "n1-1")).ok).toBe(false)
    expect(calls).toEqual(["reload", "inspect true"])
    expect(await run(host, "@ade browser state", "n1-1")).toEqual({
      ok: true,
      detail: "http://localhost:5173/ — Naviga, Nativo, 2 elementi selezionati",
    })
  })

  test("a pane that is not on screen says so", async () => {
    const { host, hide } = makeHost()
    await run(host, "@ade browser open :5173", "n1-1")
    hide()
    const outcome = await run(host, "@ade browser reload", "n1-1")
    expect(outcome.ok).toBe(false)
  })

  test("an unknown verb lists the known ones", async () => {
    const { host } = makeHost()
    const outcome = await run(host, "@ade browser click #buy", "n1-1")
    expect(outcome).toEqual({ ok: false, reason: "comando sconosciuto; disponibili: open, reload, state, inspect" })
  })
})
