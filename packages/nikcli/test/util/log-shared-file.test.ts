import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"

/**
 * The TUI and its server worker write one log.
 *
 * The worker used to open the log itself, which truncated the file the main
 * process had just opened, and the two writers then overwrote each other from
 * their own offsets. Every stalled start investigated for
 * `specs/effect-tui/00-startup-hang.md` left an empty `dev.log` for that reason.
 *
 * `Log.init` is never called in the unit suite (other files rely on the default
 * stderr writer), so both writers run as their own processes here.
 */
const fixture = path.join(import.meta.dir, "fixtures", "log-writer.ts")
const COUNT = 300

function writer(home: string, who: string, join?: string) {
  return Bun.spawn(["bun", fixture], {
    cwd: path.join(import.meta.dir, "..", ".."),
    env: { ...process.env, NIKCLI_TEST_HOME: home, WHO: who, COUNT: String(COUNT), ...(join ? { JOIN: join } : {}) },
    stdout: "pipe",
    stderr: "pipe",
  })
}

describe("shared log file", () => {
  test("a joining writer neither truncates nor overwrites the first one", async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "nikcli-log-shared-"))
    try {
      const file = path.join(home, "data", "log", "dev.log")
      mkdirSync(path.dirname(file), { recursive: true })

      const first = writer(home, "main")
      // Join only once the first writer has opened (and truncated) the file.
      const deadline = Date.now() + 10_000
      while (!existsSync(file) && Date.now() < deadline) await Bun.sleep(5)
      const second = writer(home, "worker", file)

      const [a, b] = await Promise.all([first.exited, second.exited])
      expect([a, b]).toEqual([0, 0])

      const lines = readFileSync(file, "utf8").split("\n").filter(Boolean)
      const by = (who: string) => lines.filter((line) => line.includes(`who=${who} `))
      expect(by("main")).toHaveLength(COUNT)
      expect(by("worker")).toHaveLength(COUNT)
      // Nothing torn: every line is a whole record.
      for (const line of lines)
        expect(line).toMatch(/^INFO {2}\S+ \+\d+ms service=writer-(main|worker) who=(main|worker) i=\d+ line$/)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})
