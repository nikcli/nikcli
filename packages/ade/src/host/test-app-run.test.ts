import { describe, expect, test } from "bun:test"
import {
  TEST_APP_CLOSE_TIMEOUT_MS,
  instanceProcesses,
  planTestApp,
  stopInstance,
  superviseStart,
  type ProcessRow,
  type TestAppRecord,
} from "./test-app"

/*
 * The reviewer's P2 on 7c3ebf379: a start that times out, or whose app goes
 * away, must leave no process and no record.json behind. Driven here through
 * the same superviseStart and stopInstance the script runs, against a process
 * table and a record that kill and removeRecord really change.
 */

const root = "C:\\Users\\me\\Favorites\\nikcli-ade-testapp"
const plan = planTestApp({ root, branch: "ade/voice-prova" })
const startedAt = 1_000_000

function machine() {
  let clock = startedAt
  let rows: ProcessRow[] = [
    {
      pid: 10,
      ppid: 1,
      created: startedAt + 5,
      cmd: `bun.exe x tauri dev --config src-tauri/tauri.test.conf.json --config ${plan.configPath}`,
    },
    { pid: 11, ppid: 10, created: startedAt + 9, cmd: "cargo run --no-default-features" },
    { pid: 12, ppid: 11, created: startedAt + 20, cmd: "rustc --crate-name ade_desktop" },
    {
      pid: 15,
      ppid: 999,
      created: startedAt + 7,
      cmd: `node "${root}\\packages\\ade\\node_modules\\vite\\bin\\vite.js" --port 5270 --strictPort`,
    },
    // Not the instance's: another session's shell, and a process older than the start naming the same profile.
    { pid: 31, ppid: 1, created: startedAt - 10_000, cmd: "powershell.exe" },
    {
      pid: 40,
      ppid: 1,
      created: startedAt - 60_000,
      cmd: `powershell -Command "Start-Sleep 1800 # --user-data-dir=${plan.profileDir}"`,
    },
  ]
  let record: TestAppRecord | undefined = { port: 5270, label: plan.label, root, startedAt }
  let log = "   Compiling ade-desktop v0.0.0\n    Building [=====>   ] 120/482: tauri\n"
  const killed: number[] = []
  const stop = () =>
    stopInstance({
      rows,
      record,
      plan,
      root,
      selfPid: 4242,
      kill: (pid) => {
        killed.push(pid)
        rows = rows.filter((row) => row.pid !== pid)
      },
      removeRecord: () => (record = undefined),
    })
  return {
    deps: (overrides: Partial<Parameters<typeof superviseStart>[0]> = {}) => ({
      readLog: () => log,
      running: () => instanceProcesses(rows, plan, root, 5270, startedAt).some((row) => row.pid === 10),
      stop: () => void stop(),
      now: () => clock,
      sleep: async (ms: number) => void (clock += ms),
      timeoutMs: 20_000,
      livenessEveryMs: 5_000,
      ...overrides,
    }),
    left: () => instanceProcesses(rows, plan, root, 5270, startedAt).map((row) => row.pid),
    pids: () => rows.map((row) => row.pid),
    record: () => record,
    killed,
    setLog: (text: string) => (log = text),
    loseApp: () => (rows = rows.filter((row) => row.pid !== 10 && row.pid !== 11 && row.pid !== 12)),
  }
}

describe("host/test-app start and stop", () => {
  test("a start that times out stops every process it created and removes record.json", async () => {
    const m = machine()
    expect(await superviseStart(m.deps())).toEqual({ outcome: "timeout" })
    expect(m.left()).toEqual([])
    expect(m.record()).toBeUndefined()
    // Children before parents, and nothing that was not the start's.
    expect(m.killed.indexOf(12)).toBeLessThan(m.killed.indexOf(11))
    expect(m.killed.indexOf(11)).toBeLessThan(m.killed.indexOf(10))
    expect(m.pids()).toEqual([31, 40])
  })

  test("a start whose app goes away stops what it left (Vite) and removes record.json", async () => {
    const m = machine()
    let reads = 0
    const result = await superviseStart(
      m.deps({
        readLog: () => {
          if (++reads === 3) m.loseApp()
          return "    Building [=====>   ] 130/482: tauri\n"
        },
      }),
    )
    expect(result).toEqual({ outcome: "lost" })
    expect(m.killed).toEqual([15])
    expect(m.left()).toEqual([])
    expect(m.record()).toBeUndefined()
    expect(m.pids()).toEqual([31, 40])
  })

  test("an unreadable process table is not a lost app: it waits on until the timeout", async () => {
    const m = machine()
    expect(await superviseStart(m.deps({ running: () => undefined }))).toEqual({ outcome: "timeout" })
    expect(m.record()).toBeUndefined()
  })

  test("a build failure in the log stops the start at once", async () => {
    const m = machine()
    m.setLog("error[E0425]: cannot find value `x` in this scope\n")
    const result = await superviseStart(m.deps())
    expect(result.outcome).toBe("failed")
    expect(m.left()).toEqual([])
    expect(m.record()).toBeUndefined()
  })

  test("a start that opens the window stops nothing and keeps its record", async () => {
    const m = machine()
    m.setLog("     Running `target\\debug\\ade-test.exe`\n")
    expect(await superviseStart(m.deps())).toEqual({ outcome: "started" })
    expect(m.killed).toEqual([])
    expect(m.record()).toBeDefined()
  })

  describe("orderly stop (S34: a kill lost the localStorage WebView2 had not written yet)", () => {
    const appExe = `${root}\\packages\\ade\\src-tauri\\target\\debug\\ade-test.exe`
    const table = (): ProcessRow[] => [
      { pid: 10, ppid: 1, created: startedAt + 5, cmd: `bun.exe x tauri dev --config ${plan.configPath}` },
      {
        pid: 15,
        ppid: 999,
        created: startedAt + 7,
        cmd: `node "${root}\\packages\\ade\\node_modules\\vite\\bin\\vite.js" --port 5270 --strictPort`,
      },
      { pid: 20, ppid: 10, created: startedAt + 60_000, exe: appExe, cmd: appExe },
      { pid: 21, ppid: 20, created: startedAt + 61_000, cmd: `msedgewebview2.exe --user-data-dir=${plan.profileDir}` },
    ]

    function run(appCloses: boolean, tableReadable = true) {
      let rows = table()
      const calls: string[] = []
      let waited = 0
      const result = stopInstance({
        rows,
        record: { port: 5270, label: plan.label, root, startedAt },
        plan,
        root,
        selfPid: 4242,
        kill: (pid) => {
          calls.push(`kill ${pid}`)
          rows = rows.filter((row) => row.pid !== pid)
        },
        removeRecord: () => calls.push("record"),
        close: (pid) => calls.push(`close ${pid}`),
        waitExit: (pids, timeoutMs) => {
          waited = timeoutMs
          // The app closes its window; WebView2 goes with it.
          if (appCloses) rows = rows.filter((row) => row.pid !== 20 && row.pid !== 21)
          return pids.filter((pid) => rows.some((row) => row.pid === pid))
        },
        reread: () => (tableReadable ? rows : undefined),
      })
      return { result, calls, waited }
    }

    test("the app's window is closed and its exit awaited before anything is killed", () => {
      const { result, calls, waited } = run(true)
      expect(calls[0]).toBe("close 20")
      expect(waited).toBe(TEST_APP_CLOSE_TIMEOUT_MS)
      expect(calls).not.toContain("kill 20")
      expect(calls).not.toContain("kill 21")
      expect(result).toEqual({ outcome: "stopped", closed: [20], killed: expect.arrayContaining([10, 15]) })
      expect(calls.at(-1)).toBe("record")
    })

    test("an app that does not exit in time is killed, after its children", () => {
      const { result, calls } = run(false)
      expect(calls[0]).toBe("close 20")
      expect(calls.indexOf("kill 21")).toBeLessThan(calls.indexOf("kill 20"))
      expect(calls.indexOf("kill 20")).toBeLessThan(calls.indexOf("kill 10"))
      expect(result).toMatchObject({ outcome: "stopped", closed: [] })
    })

    test("with the table unreadable after the wait, the app's pids are not killed: they may be reused", () => {
      const { calls } = run(false, false)
      expect(calls).not.toContain("kill 20")
      expect(calls).not.toContain("kill 21")
      expect(calls).toContain("kill 10")
      expect(calls).toContain("kill 15")
    })
  })

  test("stop without a start time kills nothing and keeps the record, naming the pids", () => {
    const rows: ProcessRow[] = [{ pid: 10, ppid: 1, created: 5, cmd: `tauri dev --config ${plan.configPath}` }]
    let removed = false
    const killed: number[] = []
    const result = stopInstance({
      rows,
      record: { port: 5270, label: plan.label, root },
      plan,
      root,
      selfPid: 1,
      kill: (pid) => killed.push(pid),
      removeRecord: () => (removed = true),
    })
    expect(result).toEqual({ outcome: "refused", pids: [10] })
    expect(killed).toEqual([])
    expect(removed).toBe(false)
  })
})
