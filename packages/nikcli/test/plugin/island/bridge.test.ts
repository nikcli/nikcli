import { preserveTestEnv } from "../../helpers/env"
import { removeTestDir } from "../../helpers/fs"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { afterAll, describe, expect, it } from "bun:test"
import { Bus } from "@/bus"
import { IslandBridge } from "@nikcli-ai/util/island-bridge"
import { PermissionNext } from "@/permission/next"
import { MessageV2 } from "@/session/message-v2"
import { Session } from "@/session"
import { SessionStatus } from "@/session/status"
import { Instance } from "@/project/instance"
import { runPromiseWithLayer, withCurrentInstance } from "@/effect"
import { Effect } from "effect"
import { Auth } from "@/server/httpapi/auth"

// This exercises the real event pipeline (Bus.publish -> GlobalBus -> IslandBridge),
// the same path every session.status / permission.asked / tool-part update takes in
// production — not a hand-rolled GlobalBus.emit — so a schema drift in any of those
// BusEvent definitions fails this test instead of silently breaking the notch app.

const testHome = await fs.mkdtemp(path.join(os.tmpdir(), "nikcli-island-test-home-"))
const supportDir = await fs.mkdtemp(path.join(os.tmpdir(), "nikcli-island-support-"))
process.env.NIKCLI_TEST_HOME = testHome
process.env.NIKCLI_DISABLE_PROJECT_CONFIG = "1"
process.env.ISLAND_SUPPORT_DIR = supportDir
process.env.NIKCLI_ISLAND_TEST_FORCE_DARWIN = "1"
process.env.NIKCLI_ISLAND = "1"
process.env.NIKCLI_PORT = "4123" // short-circuits the dynamic @/server/server import

preserveTestEnv([
  "NIKCLI_TEST_HOME",
  "NIKCLI_DISABLE_PROJECT_CONFIG",
  "ISLAND_SUPPORT_DIR",
  "NIKCLI_ISLAND_TEST_FORCE_DARWIN",
  "NIKCLI_ISLAND",
  "NIKCLI_PORT",
])

IslandBridge.setEnabled(true)

const projectDirs: string[] = []
async function withProject<T>(fn: () => Promise<T> | T): Promise<T> {
  const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "nikcli-island-project-"))
  projectDirs.push(projectDir)
  return Instance.provide({ directory: projectDir, fn })
}

function stateFile(sessionID: string) {
  return path.join(supportDir, "state.d", `nikcli-${sessionID}.json`)
}

// write() is fire-and-forget (the GlobalBus listener doesn't await it, matching
// production where a hook/event handler must never block the publisher), so a
// second write racing a first can land after this file already existed with the
// first write's content. Polling "until the file exists" isn't enough — poll until
// it satisfies the caller's predicate (or time out showing the last snapshot seen).
async function waitForSnapshot(sessionID: string, predicate: (s: any) => boolean, tries = 80): Promise<any> {
  let last: any
  for (let i = 0; i < tries; i++) {
    try {
      const raw = await fs.readFile(stateFile(sessionID), "utf8")
      last = JSON.parse(raw)
      if (predicate(last)) return last
    } catch {
      // not written yet
    }
    await new Promise((r) => setTimeout(r, 20))
  }
  throw new Error(`snapshot for ${sessionID} never matched; last seen: ${JSON.stringify(last)}`)
}

async function expectNoSnapshot(sessionID: string) {
  await new Promise((r) => setTimeout(r, 100))
  await expect(fs.access(stateFile(sessionID))).rejects.toThrow()
}

function setStatus(sessionID: string, status: SessionStatus.Info) {
  return runPromiseWithLayer(
    SessionStatus.defaultLayer,
    withCurrentInstance(
      Effect.gen(function* () {
        const svc = yield* SessionStatus.Service
        yield* svc.set(sessionID, status)
      }),
    ),
  )
}

function createSession(input: { title: string; parentID?: string }) {
  return runPromiseWithLayer(
    Session.defaultLayer,
    withCurrentInstance(
      Effect.gen(function* () {
        const svc = yield* Session.Service
        return yield* svc.createNext({
          directory: Instance.directory,
          ...input,
        })
      }),
    ),
  )
}

describe("IslandBridge", () => {
  it("mirrors session.status busy -> thinking, idle -> idle", async () => {
    await withProject(async () => {
      const sid = "island-busy"
      await setStatus(sid, { type: "busy", since: Date.now() })
      const busy = await waitForSnapshot(sid, (s) => s.state === "thinking")
      expect(busy.label).toBe("Thinking…")
      expect(busy.startedAt).toBeGreaterThan(0)

      await setStatus(sid, { type: "idle" })
      const idle = await waitForSnapshot(sid, (s) => s.state === "idle")
      expect(idle.startedAt).toBe(0)
    })
  })

  it("mirrors permission.asked -> permission, permission.replied -> thinking", async () => {
    await withProject(async () => {
      const sid = "island-permission"
      await Bus.publish(PermissionNext.Event.Asked, {
        id: "per_test123",
        sessionID: sid,
        permission: "bash",
        patterns: ["*"],
        metadata: {},
        always: [],
      })
      const asked = await waitForSnapshot(sid, (s) => s.state === "permission")
      expect(asked.permissionID).toBe("per_test123")

      await Bus.publish(PermissionNext.Event.Replied, {
        sessionID: sid,
        requestID: "per_test123",
        reply: "once",
      })
      const replied = await waitForSnapshot(sid, (s) => s.state === "thinking")
      expect(replied.permissionID).toBe("")
    })
  })

  it("mirrors a running tool part, then lingers its label past completion", async () => {
    await withProject(async () => {
      const sid = "island-tool"
      await Bus.publish(MessageV2.Event.PartUpdated, {
        part: {
          id: "prt_1",
          sessionID: sid,
          messageID: "msg_1",
          type: "tool",
          callID: "call_1",
          tool: "edit",
          state: {
            status: "running",
            input: { file_path: "/tmp/example/IslandView.swift" },
            time: { start: Date.now() },
          },
        } as any,
      })
      const running = await waitForSnapshot(sid, (s) => s.state === "tool" && s.toolEndsAt === 0)
      expect(running.tool).toBe("edit")
      expect(running.label).toBe("Editing")
      expect(running.detail).toBe("IslandView.swift")

      const before = Date.now() / 1000
      await Bus.publish(MessageV2.Event.PartUpdated, {
        part: {
          id: "prt_1",
          sessionID: sid,
          messageID: "msg_1",
          type: "tool",
          callID: "call_1",
          tool: "edit",
          state: {
            status: "completed",
            input: { file_path: "/tmp/example/IslandView.swift" },
            output: "ok",
            title: "edit",
            metadata: {},
            time: { start: Date.now() - 10, end: Date.now() },
          },
        } as any,
      })
      // Still reporting "tool"/"Editing" (the linger) rather than flashing straight
      // to "Thinking…" — the aggregator on the Swift side is what actually falls
      // back once toolEndsAt passes; the bridge's job is just to set that deadline.
      const completed = await waitForSnapshot(sid, (s) => s.toolEndsAt > 0)
      expect(completed.state).toBe("tool")
      expect(completed.label).toBe("Editing")
      expect(completed.toolEndsAt).toBeGreaterThan(before)
    })
  })

  it("falls back to a generic label for an unmapped tool, and a specific one for mcp__ tools", async () => {
    await withProject(async () => {
      const sid = "island-unknown-tool"
      await Bus.publish(MessageV2.Event.PartUpdated, {
        part: {
          id: "prt_2",
          sessionID: sid,
          messageID: "msg_2",
          type: "tool",
          callID: "call_2",
          tool: "mcp__linear__create_issue",
          state: { status: "running", input: {}, time: { start: Date.now() } },
        } as any,
      })
      const mcp = await waitForSnapshot(sid, (s) => s.state === "tool")
      expect(mcp.label).toBe("Using MCP tool")

      const sid2 = "island-unknown-tool-2"
      await Bus.publish(MessageV2.Event.PartUpdated, {
        part: {
          id: "prt_3",
          sessionID: sid2,
          messageID: "msg_3",
          type: "tool",
          callID: "call_3",
          tool: "some_future_tool",
          state: { status: "running", input: {}, time: { start: Date.now() } },
        } as any,
      })
      const generic = await waitForSnapshot(sid2, (s) => s.state === "tool")
      expect(generic.label).toBe("Working…")
    })
  })

  it("clears the snapshot file on session.deleted", async () => {
    await withProject(async () => {
      const sid = "island-deleted"
      await setStatus(sid, { type: "busy", since: Date.now() })
      await waitForSnapshot(sid, (s) => s.state === "thinking")

      await Bus.publish(Session.Event.Deleted, {
        info: { id: sid } as any,
      })
      await expectNoSnapshot(sid)
    })
  })

  it("stamps parentID/agentTitle for a subagent so the island can tell it apart from its orchestrator", async () => {
    await withProject(async () => {
      const parent = await createSession({ title: "orchestrator run" })
      const child = await createSession({
        title: "security-review subagent",
        parentID: parent.id,
      })

      await Bus.publish(PermissionNext.Event.Asked, {
        id: "per_subagent1",
        sessionID: child.id,
        permission: "bash",
        patterns: ["*"],
        metadata: {},
        always: [],
      })
      const asked = await waitForSnapshot(child.id, (s) => s.state === "permission")
      expect(asked.parentID).toBe(parent.id)
      expect(asked.agentTitle).toBe("security-review subagent")

      // The orchestrator itself has no parent, so its own snapshot must not pick up
      // any subagent identity.
      await setStatus(parent.id, { type: "busy", since: Date.now() })
      const parentSnap = await waitForSnapshot(parent.id, (s) => s.state === "thinking")
      expect(parentSnap.parentID).toBe("")
    })
  })

  it("stamps the port from NIKCLI_PORT so the app can reply to a permission", async () => {
    await withProject(async () => {
      const sid = "island-port"
      await setStatus(sid, { type: "busy", since: Date.now() })
      const snap = await waitForSnapshot(sid, (s) => s.state === "thinking")
      expect(snap.port).toBe(4123)
      expect(snap.authorization).toBe("")
    })
  })

  it("stamps the credentials the server requires, so a permission reply is not refused", async () => {
    Auth.useServicePassword("island-secret")
    try {
      await withProject(async () => {
        const sid = "island-auth"
        await setStatus(sid, { type: "busy", since: Date.now() })
        const snap = await waitForSnapshot(sid, (s) => s.state === "thinking")
        expect(snap.authorization).toBe(`Basic ${btoa("nikcli:island-secret")}`)
      })
    } finally {
      Auth.useServicePassword("")
    }
  })
})

afterAll(async () => {
  await Instance.disposeAll().catch(() => undefined)
  await Promise.all(projectDirs.map((dir) => removeTestDir(dir)))
  await removeTestDir(testHome)
  await removeTestDir(supportDir)
})
