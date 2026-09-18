import { afterAll, describe, expect, it } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { FileLock } from "@/util/file-lock"

const dir = await fs.mkdtemp(path.join(os.tmpdir(), "nikcli-file-lock-"))

afterAll(async () => {
  await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined)
})

function lockFile(name: string) {
  return path.join(dir, "nested", `${name}.lock`)
}

/** A lock file whose holder is long gone — staleness is read off the file's own age. */
async function abandoned(file: string, contents: string) {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await Bun.write(file, contents)
  const old = new Date(Date.now() - 60_000)
  await fs.utimes(file, old, old)
}

describe("FileLock", () => {
  it("creates the lock file, and its directory, on acquire", async () => {
    const file = lockFile("create")
    const handle = await FileLock.acquire(file)
    expect(handle).toBeDefined()
    expect(await Bun.file(file).exists()).toBe(true)
    await handle![Symbol.asyncDispose]()
    expect(await Bun.file(file).exists()).toBe(false)
  })

  it("refuses a second holder while the first still has it", async () => {
    const file = lockFile("exclusive")
    const first = await FileLock.acquire(file)
    // The whole point: the *second* caller is told no rather than proceeding.
    // In the account refresh that "proceeding" is a single-use token being
    // spent twice, which ends the session for both processes.
    const second = await FileLock.acquire(file, { timeoutMs: 60, pollMs: 10 })
    expect(first).toBeDefined()
    expect(second).toBeUndefined()
    await first![Symbol.asyncDispose]()
  })

  it("hands the lock to a waiter once the holder releases", async () => {
    const file = lockFile("handover")
    const first = await FileLock.acquire(file)
    const waiting = FileLock.acquire(file, { timeoutMs: 2_000, pollMs: 10 })
    await first![Symbol.asyncDispose]()
    const second = await waiting
    expect(second).toBeDefined()
    await second![Symbol.asyncDispose]()
  })

  it("takes over a lock left behind by a dead holder", async () => {
    const file = lockFile("stale")
    await abandoned(file, JSON.stringify({ pid: 999_999, at: Date.now() - 60_000 }))
    const handle = await FileLock.acquire(file, { staleMs: 1_000, timeoutMs: 200, pollMs: 10 })
    expect(handle).toBeDefined()
    await handle![Symbol.asyncDispose]()
  })

  it("takes over an abandoned lock file that holds nothing readable", async () => {
    const file = lockFile("garbage")
    await abandoned(file, "half-written")
    const handle = await FileLock.acquire(file, { staleMs: 1_000, timeoutMs: 200, pollMs: 10 })
    expect(handle).toBeDefined()
    await handle![Symbol.asyncDispose]()
  })

  it("waits for a lock whose contents are not there yet", async () => {
    // Creating the file and naming its owner are two syscalls, so a contender
    // can read an empty lock. Age decides, not contents: a lock written a
    // moment ago is being taken, not abandoned.
    const file = lockFile("half-created")
    await fs.mkdir(path.dirname(file), { recursive: true })
    await Bun.write(file, "")
    const handle = await FileLock.acquire(file, { staleMs: 30_000, timeoutMs: 60, pollMs: 10 })
    expect(handle).toBeUndefined()
    await fs.unlink(file)
  })

  it("leaves a lock alone when it was taken over as stale", async () => {
    // Disposing must not delete whatever is there — only what this caller
    // still owns — or a slow holder would be released by a stranger.
    const file = lockFile("ownership")
    const mine = await FileLock.acquire(file)
    await Bun.write(file, JSON.stringify({ pid: 4, at: Date.now() }))
    await mine![Symbol.asyncDispose]()
    expect(await Bun.file(file).exists()).toBe(true)
    await fs.unlink(file)
  })

  it("serializes contending callers so only one runs the section at a time", async () => {
    const file = lockFile("serial")
    let inside = 0
    let overlapped = false
    await Promise.all(
      Array.from({ length: 4 }, async () => {
        const handle = await FileLock.acquire(file, { timeoutMs: 5_000, pollMs: 5 })
        expect(handle).toBeDefined()
        inside++
        if (inside > 1) overlapped = true
        await Bun.sleep(10)
        inside--
        await handle![Symbol.asyncDispose]()
      }),
    )
    expect(overlapped).toBe(false)
  })
})
