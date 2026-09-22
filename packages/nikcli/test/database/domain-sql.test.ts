import { describe, expect, it } from "bun:test"
import { Effect } from "effect"
import { existsSync } from "fs"
import fs from "fs/promises"
import path from "path"
import { withIsolatedDatabase } from "../helpers/sqlite"

function missionDef(id = "mission_sql_1") {
  return {
    id,
    name: "sql mission",
    brief: "Prove missions survive the JSON-to-SQL move",
    status: "ready" as const,
    createdAt: 1_700_000_000_000,
    models: {},
    milestones: [
      {
        id: "m1",
        name: "milestone-1",
        validation: "none" as const,
        status: "pending" as const,
        features: [
          {
            id: "f1",
            name: "feature-1",
            agent: "general",
            objective: "Do the first thing",
            dependsOn: [],
            status: "pending" as const,
          },
        ],
      },
    ],
  }
}

function missionExec(missionID: string, id = "mission_exec_sql_1") {
  return {
    id,
    missionID,
    kind: "feature" as const,
    targetID: "f1",
    targetName: "feature-1",
    startedAt: 1_700_000_000_100,
    heartbeatAt: 1_700_000_000_100,
    status: "running" as const,
    ok: false,
  }
}

describe("domain SQL (missions, monitors, shares, artifacts)", () => {
  it("backfills the JSON tree into SQL on first open", async () => {
    await withIsolatedDatabase(async ({ home }) => {
      const storage = path.join(home, "data", "storage")
      const def = missionDef()
      const exec = missionExec(def.id)
      const share = { id: "share_sql_1", mode: "local" as const, url: "http://local/share/share_sql_1" }
      const local = {
        id: "share_sql_1",
        sessionID: "ses_share_1",
        url: share.url,
        time: { created: 10, updated: 20 },
        items: { "session:ses_share_1": { type: "session", data: { id: "ses_share_1" } } },
      }
      const monitor = {
        id: "mon_sql_1",
        sessionID: "ses_mon_1",
        messageID: "msg_sql_1",
        callID: "call_1",
        title: "echo",
        command: "echo hi",
        cwd: "/tmp",
        agent: "build",
        wake: false,
        status: "running" as const,
        logPath: "/tmp/out.log",
        commandPath: "/tmp/command",
        pidPath: "/tmp/pid",
        exitCodePath: "/tmp/exit",
        preview: "",
        bytes: 0,
        time: { created: 30, updated: 40 },
      }
      const artifact = {
        id: "art_sql_1",
        title: "page",
        filename: "index.html",
        contentType: "text/html",
        kind: "html" as const,
        url: "https://nikcli-ai.dev/artifact/art_sql_1",
        viewKey: "view",
        secret: "sekrit",
        version: 1,
        sessionID: "ses_art_1",
        size: 12,
        time: { created: 50, updated: 60 },
      }

      await fs.mkdir(path.join(storage, "mission", "proj_sql"), { recursive: true })
      await fs.mkdir(path.join(storage, "mission_exec", "proj_sql", def.id), { recursive: true })
      await fs.mkdir(path.join(storage, "session_share"), { recursive: true })
      await fs.mkdir(path.join(storage, "local_share"), { recursive: true })
      await fs.mkdir(path.join(storage, "monitor", monitor.sessionID), { recursive: true })
      await fs.mkdir(path.join(storage, "artifact", artifact.sessionID), { recursive: true })
      await fs.writeFile(path.join(storage, "mission", "proj_sql", `${def.id}.json`), JSON.stringify(def))
      await fs.writeFile(
        path.join(storage, "mission_exec", "proj_sql", def.id, `${exec.id}.json`),
        JSON.stringify(exec),
      )
      await fs.writeFile(path.join(storage, "session_share", `${local.sessionID}.json`), JSON.stringify(share))
      await fs.writeFile(path.join(storage, "local_share", `${local.id}.json`), JSON.stringify(local))
      await fs.writeFile(
        path.join(storage, "monitor", monitor.sessionID, `${monitor.id}.json`),
        JSON.stringify(monitor),
      )
      await fs.writeFile(
        path.join(storage, "artifact", artifact.sessionID, `${artifact.id}.json`),
        JSON.stringify(artifact),
      )

      const { Database } = await import("@/database/database")
      const { MissionRepo } = await import("@/mission/repo")
      const { MonitorRepo } = await import("@/monitor/repo")
      const { ShareRepo } = await import("@/share/repo")
      const { ArtifactRepo } = await import("@/artifact/repo")

      Database.syncDb()

      expect(Effect.runSync(MissionRepo.get("proj_sql", def.id))?.name).toBe("sql mission")
      expect(Effect.runSync(MissionRepo.listExecs("proj_sql", def.id)).map((row) => row.id)).toEqual([exec.id])
      expect(Effect.runSync(MonitorRepo.get(monitor.sessionID, monitor.id))?.title).toBe("echo")
      expect(Effect.runSync(ShareRepo.get(local.sessionID))?.url).toBe(share.url)
      expect(Effect.runSync(ShareRepo.getLocal(local.id))?.sessionID).toBe(local.sessionID)
      const stored = Effect.runSync(ArtifactRepo.get(artifact.sessionID, artifact.id))
      expect(stored?.secret).toBe("sekrit")
      expect(Effect.runSync(ArtifactRepo.list(artifact.sessionID)).map((row) => row.id)).toEqual([artifact.id])

      const { Artifact } = await import("@/artifact")
      const listed = await Artifact.list(artifact.sessionID)
      expect(listed).toHaveLength(1)
      expect(listed[0]?.id).toBe(artifact.id)
      expect(listed[0]).not.toHaveProperty("secret")

      const domainSql = (await import("@/database/migration/20260814020000_domain_sql")).default
      domainSql.up(Database.syncNative())
      expect(Effect.runSync(MissionRepo.list("proj_sql"))).toHaveLength(1)
      expect(Effect.runSync(MonitorRepo.listRunning()).map((row) => row.id)).toEqual([monitor.id])

      // Downgrade fallback: the JSON tree is left in place.
      expect(await fs.readFile(path.join(storage, "mission", "proj_sql", `${def.id}.json`), "utf8")).toContain(def.name)
      expect(
        await fs.readFile(path.join(storage, "monitor", monitor.sessionID, `${monitor.id}.json`), "utf8"),
      ).toContain(monitor.title)
      expect(await fs.readFile(path.join(storage, "session_share", `${local.sessionID}.json`), "utf8")).toContain(
        share.url,
      )
      expect(await fs.readFile(path.join(storage, "local_share", `${local.id}.json`), "utf8")).toContain(
        local.sessionID,
      )
      expect(
        await fs.readFile(path.join(storage, "artifact", artifact.sessionID, `${artifact.id}.json`), "utf8"),
      ).toContain("sekrit")
    })
  })

  it("does not write JSON files after the domains have moved", async () => {
    await withIsolatedDatabase(async ({ home }) => {
      const { Database } = await import("@/database/database")
      const { MissionRepo } = await import("@/mission/repo")
      const { MonitorRepo } = await import("@/monitor/repo")
      const { ShareRepo } = await import("@/share/repo")
      const { ArtifactRepo } = await import("@/artifact/repo")
      Database.syncDb()

      const def = missionDef("mission_no_json")
      Effect.runSync(MissionRepo.upsert("proj_live", def))
      Effect.runSync(MissionRepo.putExec("proj_live", missionExec(def.id, "mission_exec_no_json")))
      Effect.runSync(
        MonitorRepo.upsert({
          id: "mon_no_json",
          sessionID: "ses_no_json",
          messageID: "msg_no_json",
          callID: "call_no_json",
          title: "ping",
          command: "echo ping",
          cwd: "/tmp",
          agent: "build",
          wake: false,
          status: "running",
          logPath: "/tmp/out.log",
          commandPath: "/tmp/command",
          pidPath: "/tmp/pid",
          exitCodePath: "/tmp/exit",
          preview: "",
          bytes: 0,
          time: { created: 1, updated: 1 },
        }),
      )
      Effect.runSync(
        ShareRepo.put("ses_no_json", { url: "http://local/share/no-json", mode: "local", id: "share_no_json" }),
      )
      Effect.runSync(
        ShareRepo.putLocal({
          id: "share_no_json",
          sessionID: "ses_no_json",
          url: "http://local/share/no-json",
          time: { created: 1, updated: 1 },
          items: {},
        }),
      )
      Effect.runSync(
        ArtifactRepo.upsert({
          id: "art_no_json",
          title: "page",
          filename: "index.html",
          contentType: "text/html",
          kind: "html",
          url: "https://example.test/art_no_json",
          viewKey: "view",
          secret: "sekrit",
          version: 1,
          sessionID: "ses_no_json",
          size: 4,
          time: { created: 1, updated: 1 },
        }),
      )

      const storage = path.join(home, "data", "storage")
      expect(existsSync(storage)).toBe(false)
    })
  })

  it("runtime reads ignore leftover JSON after the domains have moved", async () => {
    await withIsolatedDatabase(async ({ home }) => {
      const { Database } = await import("@/database/database")
      const { MissionRepo } = await import("@/mission/repo")
      const { MonitorRepo } = await import("@/monitor/repo")
      const { ShareRepo } = await import("@/share/repo")
      const { ArtifactRepo } = await import("@/artifact/repo")
      Database.syncDb()

      const def = missionDef("mission_trap")
      Effect.runSync(MissionRepo.upsert("proj_trap", def))
      Effect.runSync(MissionRepo.putExec("proj_trap", missionExec(def.id, "mission_exec_trap")))
      Effect.runSync(
        MonitorRepo.upsert({
          id: "mon_trap",
          sessionID: "ses_trap",
          messageID: "msg_trap",
          callID: "call_trap",
          title: "sql-title",
          command: "echo sql",
          cwd: "/tmp",
          agent: "build",
          wake: false,
          status: "running",
          logPath: "/tmp/out.log",
          commandPath: "/tmp/command",
          pidPath: "/tmp/pid",
          exitCodePath: "/tmp/exit",
          preview: "",
          bytes: 0,
          time: { created: 1, updated: 1 },
        }),
      )
      Effect.runSync(ShareRepo.put("ses_trap", { url: "http://sql/share", mode: "local", id: "share_sql_trap" }))
      Effect.runSync(
        ShareRepo.putLocal({
          id: "share_sql_trap",
          sessionID: "ses_trap",
          url: "http://sql/share",
          time: { created: 1, updated: 1 },
          items: {},
        }),
      )
      Effect.runSync(
        ArtifactRepo.upsert({
          id: "art_trap",
          title: "sql-page",
          filename: "index.html",
          contentType: "text/html",
          kind: "html",
          url: "https://example.test/art_trap",
          viewKey: "view",
          secret: "sql-secret",
          version: 1,
          sessionID: "ses_trap",
          size: 4,
          time: { created: 1, updated: 1 },
        }),
      )

      const storage = path.join(home, "data", "storage")
      await fs.mkdir(path.join(storage, "mission", "proj_trap"), { recursive: true })
      await fs.mkdir(path.join(storage, "mission_exec", "proj_trap", def.id), { recursive: true })
      await fs.mkdir(path.join(storage, "monitor", "ses_trap"), { recursive: true })
      await fs.mkdir(path.join(storage, "session_share"), { recursive: true })
      await fs.mkdir(path.join(storage, "local_share"), { recursive: true })
      await fs.mkdir(path.join(storage, "artifact", "ses_trap"), { recursive: true })
      await fs.writeFile(
        path.join(storage, "mission", "proj_trap", `${def.id}.json`),
        JSON.stringify({ ...def, name: "json-trap" }),
      )
      await fs.writeFile(
        path.join(storage, "mission_exec", "proj_trap", def.id, "mission_exec_trap.json"),
        JSON.stringify({ ...missionExec(def.id, "mission_exec_trap"), targetName: "json-trap" }),
      )
      await fs.writeFile(
        path.join(storage, "monitor", "ses_trap", "mon_trap.json"),
        JSON.stringify({ title: "json-trap" }),
      )
      await fs.writeFile(
        path.join(storage, "session_share", "ses_trap.json"),
        JSON.stringify({ url: "http://json-trap/share", mode: "local", id: "share_json_trap" }),
      )
      await fs.writeFile(
        path.join(storage, "local_share", "share_sql_trap.json"),
        JSON.stringify({ sessionID: "ses_json_trap" }),
      )
      await fs.writeFile(
        path.join(storage, "artifact", "ses_trap", "art_trap.json"),
        JSON.stringify({ title: "json-page", secret: "json-secret" }),
      )

      expect(Effect.runSync(MissionRepo.get("proj_trap", def.id))?.name).toBe("sql mission")
      expect(Effect.runSync(MissionRepo.listExecs("proj_trap", def.id))[0]?.targetName).toBe("feature-1")
      expect(Effect.runSync(MonitorRepo.get("ses_trap", "mon_trap"))?.title).toBe("sql-title")
      expect(Effect.runSync(MonitorRepo.listRunning()).map((row) => row.title)).toEqual(["sql-title"])
      expect(Effect.runSync(ShareRepo.get("ses_trap"))?.url).toBe("http://sql/share")
      expect(Effect.runSync(ShareRepo.getLocal("share_sql_trap"))?.sessionID).toBe("ses_trap")
      expect(Effect.runSync(ArtifactRepo.get("ses_trap", "art_trap"))?.title).toBe("sql-page")
      expect(Effect.runSync(ArtifactRepo.get("ses_trap", "art_trap"))?.secret).toBe("sql-secret")
    })
  })

  it("round-trips monitor, share, and artifact records in SQL", async () => {
    await withIsolatedDatabase(async () => {
      const { Database } = await import("@/database/database")
      const { MonitorRepo } = await import("@/monitor/repo")
      const { ShareRepo } = await import("@/share/repo")
      const { ArtifactRepo } = await import("@/artifact/repo")
      Database.syncDb()

      const monitor = {
        id: "mon_live",
        sessionID: "ses_live",
        messageID: "msg_live",
        callID: "call_live",
        title: "ping",
        command: "echo ping",
        cwd: "/tmp",
        agent: "build",
        wake: false,
        status: "running" as const,
        logPath: "/tmp/out.log",
        commandPath: "/tmp/command",
        pidPath: "/tmp/pid",
        exitCodePath: "/tmp/exit",
        preview: "",
        bytes: 0,
        time: { created: 1, updated: 2 },
      }
      Effect.runSync(MonitorRepo.upsert(monitor))
      expect(Effect.runSync(MonitorRepo.get("ses_live", "mon_live"))?.title).toBe("ping")
      expect(Effect.runSync(MonitorRepo.listRunning()).map((row) => row.id)).toEqual(["mon_live"])
      Effect.runSync(
        MonitorRepo.upsert({ ...monitor, status: "complete", time: { ...monitor.time, completed: 3, updated: 3 } }),
      )
      expect(Effect.runSync(MonitorRepo.listRunning())).toEqual([])

      const share = { url: "http://local/share/x", mode: "local" as const, id: "share_live" }
      Effect.runSync(ShareRepo.put("ses_share_live", share))
      Effect.runSync(
        ShareRepo.putLocal({
          id: "share_live",
          sessionID: "ses_share_live",
          url: share.url,
          time: { created: 1, updated: 1 },
          items: {},
        }),
      )
      expect(Effect.runSync(ShareRepo.get("ses_share_live"))?.id).toBe("share_live")
      expect(Effect.runSync(ShareRepo.getLocal("share_live"))?.sessionID).toBe("ses_share_live")
      Effect.runSync(ShareRepo.remove("ses_share_live"))
      Effect.runSync(ShareRepo.removeLocal("share_live"))
      expect(Effect.runSync(ShareRepo.get("ses_share_live"))).toBeUndefined()
      expect(Effect.runSync(ShareRepo.getLocal("share_live"))).toBeUndefined()

      Effect.runSync(
        ArtifactRepo.upsert({
          id: "art_live",
          title: "page",
          filename: "index.html",
          contentType: "text/html",
          kind: "html",
          url: "https://example.test/art_live",
          viewKey: "view",
          secret: "sekrit",
          version: 1,
          sessionID: "ses_art_live",
          size: 4,
          time: { created: 1, updated: 1 },
        }),
      )
      expect(Effect.runSync(ArtifactRepo.get("ses_art_live", "art_live"))?.secret).toBe("sekrit")
      expect(Effect.runSync(ShareRepo.get("ses_missing"))).toBeUndefined()
      expect(Effect.runSync(MonitorRepo.get("ses_missing", "mon_missing"))).toBeUndefined()
      expect(Effect.runSync(ArtifactRepo.get("ses_missing", "art_missing"))).toBeUndefined()
    })
  })

  it("round-trips mission CRUD without reading JSON", async () => {
    await withIsolatedDatabase(async () => {
      const { Database } = await import("@/database/database")
      const { MissionRepo } = await import("@/mission/repo")
      Database.syncDb()

      const def = missionDef("mission_live")
      Effect.runSync(MissionRepo.upsert("proj_live", def))
      expect(Effect.runSync(MissionRepo.get("proj_live", def.id))?.brief).toBe(def.brief)

      const exec = missionExec(def.id, "mission_exec_live")
      Effect.runSync(MissionRepo.putExec("proj_live", exec))
      const touched = Effect.runSync(
        MissionRepo.updateExec("proj_live", def.id, exec.id, (draft) => {
          draft.heartbeatAt = 99
        }),
      )
      expect(touched?.heartbeatAt).toBe(99)

      Effect.runSync(MissionRepo.remove("proj_live", def.id))
      expect(Effect.runSync(MissionRepo.get("proj_live", def.id))).toBeUndefined()
      expect(Effect.runSync(MissionRepo.listExecs("proj_live", def.id))).toEqual([])
    })
  })

  it("keeps the newest execs when trimming", async () => {
    await withIsolatedDatabase(async () => {
      const { Database } = await import("@/database/database")
      const { MissionRepo } = await import("@/mission/repo")
      Database.syncDb()

      const def = missionDef("mission_trim")
      Effect.runSync(MissionRepo.upsert("proj_trim", def))
      for (let i = 0; i < 5; i++) {
        Effect.runSync(
          MissionRepo.putExec("proj_trim", {
            ...missionExec(def.id, `mission_exec_trim_${i}`),
            startedAt: 1_000 + i,
          }),
        )
      }
      Effect.runSync(MissionRepo.trimExecs("proj_trim", def.id, 2))
      expect(Effect.runSync(MissionRepo.listExecs("proj_trim", def.id)).map((row) => row.id)).toEqual([
        "mission_exec_trim_4",
        "mission_exec_trim_3",
      ])
    })
  })
})

function loopDef(id = "loop_sql_1") {
  return {
    id,
    name: "sql loop",
    stages: [{ name: "stage", agent: "ralph", objective: "do it" }],
    trigger: { kind: "manual" as const },
    enabled: true,
    createdAt: 1_700_000_000_000,
  }
}

function loopRun(loopID: string, id = "loop_run_sql_1") {
  return {
    id,
    loopID,
    startedAt: 1_700_000_000_100,
    status: "running" as const,
    ok: false,
  }
}

describe("loop SQL", () => {
  it("backfills loop, loop_run, and loop_meta into SQL on first open", async () => {
    await withIsolatedDatabase(async ({ home }) => {
      const storage = path.join(home, "data", "storage")
      const def = loopDef()
      const run = loopRun(def.id)
      await fs.mkdir(path.join(storage, "loop", "proj_loop"), { recursive: true })
      await fs.mkdir(path.join(storage, "loop_run", "proj_loop", def.id), { recursive: true })
      await fs.mkdir(path.join(storage, "loop_meta", "proj_loop"), { recursive: true })
      await fs.writeFile(path.join(storage, "loop", "proj_loop", `${def.id}.json`), JSON.stringify(def))
      await fs.writeFile(path.join(storage, "loop_run", "proj_loop", def.id, `${run.id}.json`), JSON.stringify(run))
      await fs.writeFile(
        path.join(storage, "loop_meta", "proj_loop", `${def.id}.json`),
        JSON.stringify({ startedRuns: 7 }),
      )

      const { Database } = await import("@/database/database")
      const { LoopRepo } = await import("@/loop/repo")
      Database.syncDb()

      expect(Effect.runSync(LoopRepo.get("proj_loop", def.id))?.name).toBe("sql loop")
      expect(Effect.runSync(LoopRepo.startedRuns("proj_loop", def.id))).toBe(7)
      expect(Effect.runSync(LoopRepo.listRuns("proj_loop", def.id)).map((row) => row.id)).toEqual([run.id])

      const loopSql = (await import("@/database/migration/20260814000000_loop_sql")).default
      loopSql.up(Database.syncNative())
      expect(Effect.runSync(LoopRepo.list("proj_loop"))).toHaveLength(1)
      expect(Effect.runSync(LoopRepo.startedRuns("proj_loop", def.id))).toBe(7)

      expect(await fs.readFile(path.join(storage, "loop", "proj_loop", `${def.id}.json`), "utf8")).toContain(def.name)
      expect(await fs.readFile(path.join(storage, "loop_meta", "proj_loop", `${def.id}.json`), "utf8")).toContain("7")
    })
  })

  it("does not write JSON files after loops have moved", async () => {
    await withIsolatedDatabase(async ({ home }) => {
      const { Database } = await import("@/database/database")
      const { LoopRepo } = await import("@/loop/repo")
      Database.syncDb()

      const def = loopDef("loop_no_json")
      Effect.runSync(LoopRepo.upsert("proj_live", def))
      Effect.runSync(LoopRepo.putRun("proj_live", loopRun(def.id, "loop_run_no_json")))
      Effect.runSync(LoopRepo.setStartedRuns("proj_live", def.id, 3))

      expect(existsSync(path.join(home, "data", "storage"))).toBe(false)
    })
  })

  it("runtime reads ignore leftover loop JSON after the move", async () => {
    await withIsolatedDatabase(async ({ home }) => {
      const { Database } = await import("@/database/database")
      const { LoopRepo } = await import("@/loop/repo")
      Database.syncDb()

      const def = loopDef("loop_trap")
      Effect.runSync(LoopRepo.upsert("proj_trap", def))
      Effect.runSync(LoopRepo.putRun("proj_trap", loopRun(def.id, "loop_run_trap")))
      Effect.runSync(LoopRepo.setStartedRuns("proj_trap", def.id, 4))

      const storage = path.join(home, "data", "storage")
      await fs.mkdir(path.join(storage, "loop", "proj_trap"), { recursive: true })
      await fs.mkdir(path.join(storage, "loop_run", "proj_trap", def.id), { recursive: true })
      await fs.mkdir(path.join(storage, "loop_meta", "proj_trap"), { recursive: true })
      await fs.writeFile(
        path.join(storage, "loop", "proj_trap", `${def.id}.json`),
        JSON.stringify({ ...def, name: "json-trap" }),
      )
      await fs.writeFile(
        path.join(storage, "loop_run", "proj_trap", def.id, "loop_run_trap.json"),
        JSON.stringify({ ...loopRun(def.id, "loop_run_trap"), status: "complete" }),
      )
      await fs.writeFile(
        path.join(storage, "loop_meta", "proj_trap", `${def.id}.json`),
        JSON.stringify({ startedRuns: 99 }),
      )

      expect(Effect.runSync(LoopRepo.get("proj_trap", def.id))?.name).toBe("sql loop")
      expect(Effect.runSync(LoopRepo.listRuns("proj_trap", def.id))[0]?.status).toBe("running")
      expect(Effect.runSync(LoopRepo.startedRuns("proj_trap", def.id))).toBe(4)
    })
  })
})
