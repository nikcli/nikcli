import { describe, expect, test } from "bun:test"
import {
  TEST_APP_PORT_BASE,
  TEST_APP_PORT_SPAN,
  appStarted,
  devConfig,
  hashPath,
  instanceProcesses,
  instanceRunning,
  killOrder,
  type ProcessRow,
  parseRecord,
  planTestApp,
  startFailure,
  tauriDevArgs,
} from "./test-app"

describe("host/test-app", () => {
  test("the same worktree gets the same port however its path is spelled", () => {
    const a = planTestApp({ root: "C:\\Users\\me\\Favorites\\nikcli-ade", branch: "feat/ade" })
    const b = planTestApp({ root: "c:/users/me/favorites/nikcli-ade/", branch: "feat/ade" })
    expect(a.port).toBe(b.port)
  })

  test("different worktrees get different ports, inside the reserved range", () => {
    const ports = ["nikcli-ade", "nikcli-ade-testapp", "nikcli-ade-release", "nikcli-ade-fix"].map(
      (name) => planTestApp({ root: `C:/Users/me/Favorites/${name}`, branch: "x" }).port,
    )
    expect(new Set(ports).size).toBe(ports.length)
    for (const port of ports) {
      expect(port).toBeGreaterThanOrEqual(TEST_APP_PORT_BASE)
      expect(port).toBeLessThan(TEST_APP_PORT_BASE + TEST_APP_PORT_SPAN)
      // Never ADE's own dev port, which is where the wrong code was served from.
      expect(port).not.toBe(5177)
    }
  })

  test("state lives in the worktree, labelled with name and branch", () => {
    const plan = planTestApp({ root: "C:/Users/me/Favorites/nikcli-ade-testapp", branch: "ade/test-app" })
    expect(plan.name).toBe("nikcli-ade-testapp")
    expect(plan.label).toBe("nikcli-ade-testapp · ade/test-app")
    // S25: its own ade-msg mailbox, not the one every test build shares.
    expect(plan.mailboxDir.replace(/\\/g, "/")).toBe("C:/Users/me/Favorites/nikcli-ade-testapp/.ade-test/mailbox")
    expect(plan.profileDir.replace(/\\/g, "/")).toBe("C:/Users/me/Favorites/nikcli-ade-testapp/.ade-test/webview2")
  })

  test("the dev config points Vite and the window at the same port, strictly", () => {
    const config = JSON.parse(devConfig(5321))
    expect(config.build.devUrl).toBe("http://localhost:5321")
    expect(config.build.beforeDevCommand).toContain("--port 5321")
    expect(config.build.beforeDevCommand).toContain("--strictPort")
  })

  test("a record without a port or root is not trusted", () => {
    expect(parseRecord("{}")).toBeUndefined()
    expect(parseRecord("not json")).toBeUndefined()
    expect(parseRecord(JSON.stringify({ port: 5200, root: "C:/x", label: "x" }))?.port).toBe(5200)
  })

  describe("which processes are this worktree's instance", () => {
    const root = "C:\\Users\\me\\Favorites\\nikcli-ade-testapp"
    const other = "C:\\Users\\me\\Favorites\\nikcli-ade"
    const plan = planTestApp({ root, branch: "ade/test-app" })
    const otherPlan = planTestApp({ root: other, branch: "feat/ade" })
    const rows: ProcessRow[] = [
      {
        pid: 10,
        ppid: 1,
        cmd: `bun.exe x tauri dev --config src-tauri/tauri.test.conf.json --config ${plan.configPath}`,
      },
      { pid: 11, ppid: 10, cmd: `node "${root}\\packages\\ade\\node_modules\\@tauri-apps\\cli\\tauri.js" dev` },
      { pid: 12, ppid: 11, cmd: "cargo run --no-default-features" },
      {
        pid: 13,
        ppid: 12,
        exe: `${root}\\packages\\ade\\src-tauri\\target\\debug\\ade-desktop.exe`,
        cmd: "target\\debug\\ade-desktop.exe",
      },
      { pid: 14, ppid: 13, cmd: `msedgewebview2.exe --user-data-dir="${plan.profileDir}\\EBWebView"` },
      // Orphaned: its parent shell is gone, but it is still this port's Vite.
      {
        pid: 15,
        ppid: 999,
        cmd: `node "${root}\\packages\\ade\\node_modules\\vite\\bin\\vite.js" --port 5270 --strictPort`,
      },
      { pid: 16, ppid: 15, exe: `${root}\\node_modules\\esbuild.exe` },
      // Another worktree, whose path is a prefix of this one's.
      { pid: 20, ppid: 1, cmd: `bun.exe x tauri dev --config ${otherPlan.configPath}` },
      { pid: 21, ppid: 1, exe: `${other}\\packages\\ade\\src-tauri\\target\\debug\\ade-desktop.exe` },
      { pid: 22, ppid: 1, cmd: `node "${other}\\packages\\ade\\node_modules\\vite\\bin\\vite.js" --port 5270` },
      // The official app and an unrelated shell.
      { pid: 30, ppid: 1, exe: "C:\\Users\\me\\AppData\\Local\\ADE\\ade-desktop.exe" },
      { pid: 31, ppid: 1, cmd: "powershell.exe" },
    ]

    test("the whole tree, orphans included, and nothing of the other worktree", () => {
      const pids = instanceProcesses(rows, plan, root, 5270)
        .map((row) => row.pid)
        .sort((a, b) => a - b)
      expect(pids).toEqual([10, 11, 12, 13, 14, 15, 16])
      expect(instanceRunning(instanceProcesses(rows, plan, root, 5270), plan, root)).toBe(true)
    })

    test("a Vite or a WebView2 left alone does not count as running", () => {
      const leftovers = rows.filter((row) => row.pid === 14 || row.pid === 15)
      expect(instanceRunning(instanceProcesses(leftovers, plan, root, 5270), plan, root)).toBe(false)
    })

    describe("with the start recorded, only what that start created", () => {
      const startedAt = 1_000_000
      const at = (row: ProcessRow, created: number | undefined): ProcessRow => ({ ...row, created })
      const timed = rows.map((row) => at(row, startedAt + row.pid))

      test("the instance it started, orphans included", () => {
        const pids = instanceProcesses(timed, plan, root, 5270, startedAt)
          .map((row) => row.pid)
          .sort((a, b) => a - b)
        expect(pids).toEqual([10, 11, 12, 13, 14, 15, 16])
      })

      test("a process naming the same paths but started before is someone else's, with its tree", () => {
        const earlier = timed.map((row) => (row.pid === 10 ? at(row, startedAt - 60_000) : row))
        // 11 and 12 hang below it and stay with it; 13 and 15 are roots of their own.
        const pids = instanceProcesses(earlier, plan, root, 5270, startedAt)
          .map((row) => row.pid)
          .sort((a, b) => a - b)
        expect(pids).toEqual([13, 14, 15, 16])
      })

      test("a child older than its parent reused a dead process's pid, and is not ours", () => {
        const reused: ProcessRow = { pid: 40, ppid: 12, cmd: "notepad.exe", created: startedAt - 3_600_000 }
        const pids = instanceProcesses([...timed, reused], plan, root, 5270, startedAt).map((row) => row.pid)
        expect(pids).not.toContain(40)
      })

      test("a process whose creation time is unknown is left alone", () => {
        const unknown = timed.map((row) => (row.pid === 15 ? at(row, undefined) : row))
        const pids = instanceProcesses(unknown, plan, root, 5270, startedAt).map((row) => row.pid)
        expect(pids).not.toContain(15)
        expect(pids).not.toContain(16)
      })

      test("children are killed before their parents, one by one", () => {
        const order = killOrder(instanceProcesses(timed, plan, root, 5270, startedAt)).map((row) => row.pid)
        expect(order.indexOf(14)).toBeLessThan(order.indexOf(13))
        expect(order.indexOf(13)).toBeLessThan(order.indexOf(12))
        expect(order.indexOf(11)).toBeLessThan(order.indexOf(10))
        expect(order.indexOf(16)).toBeLessThan(order.indexOf(15))
      })
    })
  })

  test("start failures are recognised in tauri dev output", () => {
    expect(startFailure("Error Port 5321 is already in use")).toContain("5321")
    expect(
      startFailure("Failed to setup app: error encountered during setup hook: Accesso negato. (os error 5)"),
    ).toContain("Accesso negato")
    expect(startFailure("     Running `target\\debug\\ade-desktop.exe`")).toBeUndefined()
  })

  test("a test build runs as ade-test only where Cargo.toml has the feature, and either name counts as started", () => {
    const before = '[[bin]]\nname = "ade-desktop"\n'
    const after = before + '[[bin]]\nname = "ade-test"\nrequired-features = ["test-exe"]\n\n[features]\ntest-exe = []\n'
    expect(tauriDevArgs("C:/w/.ade-test/tauri.dev.json", before)).not.toContain("--features")
    expect(tauriDevArgs("C:/w/.ade-test/tauri.dev.json", after).slice(-5)).toEqual([
      "--features",
      "test-exe",
      "--",
      "--bin",
      "ade-test",
    ])
    // The bin's own required-features line is not the feature's declaration.
    expect(tauriDevArgs("x", '[[bin]]\nrequired-features = ["test-exe"]\n')).not.toContain("--features")
    expect(appStarted("     Running `target\\debug\\ade-desktop.exe`")).toBe(true)
    expect(appStarted("     Running `target/debug/ade-test`")).toBe(true)
    expect(appStarted("   Compiling ade-desktop v0.0.0")).toBe(false)
  })

  test("a Rust change does not restart the window unless the start asked to watch", () => {
    const cargo = '[[bin]]\nname = "ade-test"\nrequired-features = ["test-exe"]\n\n[features]\ntest-exe = []\n'
    const quiet = tauriDevArgs("C:/w/.ade-test/tauri.dev.json", cargo)
    expect(quiet).toContain("--no-watch")
    // Past `--` the arguments are cargo's, so the flag has to come before it.
    expect(quiet.indexOf("--no-watch")).toBeLessThan(quiet.indexOf("--"))
    expect(quiet.slice(-5)).toEqual(["--features", "test-exe", "--", "--bin", "ade-test"])

    const watching = tauriDevArgs("C:/w/.ade-test/tauri.dev.json", cargo, { watch: true })
    expect(watching).not.toContain("--no-watch")
    expect(watching.slice(-5)).toEqual(["--features", "test-exe", "--", "--bin", "ade-test"])

    // The same, on a branch without the test binary: still no watching.
    expect(tauriDevArgs("x", '[[bin]]\nname = "ade-desktop"\n')).toContain("--no-watch")
  })

  test("hashPath is stable", () => {
    expect(hashPath("abc")).toBe(hashPath("ABC"))
  })
})
