import fs from "fs/promises"
import path from "path"

/**
 * A mutex every nikcli process on this machine can see.
 *
 * `Lock` (`src/util/lock.ts`) guards a critical section inside one process,
 * which is all a section that only touches memory needs. It is not enough for
 * one whose side effect is *remote and single-use*: the identity issuer rotates
 * a refresh token the first time it is presented and revokes the whole family
 * the second time, so two processes posting the same one — an installed TUI and
 * a dev build, a background service and a `nikcli` command — do not merely race,
 * they sign the machine out until the user signs in again.
 *
 * `O_EXCL` on a lock file is the primitive all of them share. A holder that
 * dies leaves its file behind, so a lock older than `staleMs` is taken over
 * rather than waited on forever, and a caller that cannot get in before
 * `timeoutMs` is told so (`undefined`) instead of proceeding unguarded.
 */
export namespace FileLock {
  export type Handle = {
    readonly path: string
    [Symbol.asyncDispose](): Promise<void>
  }

  export type Options = {
    /** Age at which a lock file is assumed abandoned. Default 30s. */
    staleMs?: number
    /** How long to wait for the holder before giving up. Default 15s. */
    timeoutMs?: number
    /** Gap between attempts. Default 50ms. */
    pollMs?: number
  }

  type Owner = { pid: number; at: number }

  function owner(contents: string): Owner | undefined {
    try {
      const parsed = JSON.parse(contents) as Partial<Owner>
      if (typeof parsed.pid !== "number" || typeof parsed.at !== "number") return undefined
      return { pid: parsed.pid, at: parsed.at }
    } catch {
      return undefined
    }
  }

  async function read(file: string): Promise<Owner | undefined> {
    return owner(await fs.readFile(file, "utf8").catch(() => ""))
  }

  /**
   * How long the lock file has existed, by its own timestamp rather than what
   * it contains.
   *
   * Creating the file and writing who owns it are two syscalls, so a contender
   * can read it while it is still empty. Judging staleness by the contents made
   * that half-created lock look abandoned and both callers took it — which is
   * the exact double-entry this whole namespace exists to prevent.
   */
  async function age(file: string): Promise<number | undefined> {
    const stat = await fs.stat(file).catch(() => undefined)
    return stat ? Date.now() - stat.mtimeMs : undefined
  }

  function sleep(ms: number) {
    return new Promise<void>((resolve) => setTimeout(resolve, ms))
  }

  /**
   * Take the lock, or answer `undefined` when the current holder outlasts
   * `timeoutMs`. Release it by disposing the handle — `await using` — which
   * removes the file only while this caller still owns it, so a lock that was
   * taken over as stale is never deleted out from under its new holder.
   */
  export async function acquire(file: string, options: Options = {}): Promise<Handle | undefined> {
    const staleMs = options.staleMs ?? 30_000
    const timeoutMs = options.timeoutMs ?? 15_000
    const pollMs = options.pollMs ?? 50
    const deadline = Date.now() + timeoutMs

    await fs.mkdir(path.dirname(file), { recursive: true }).catch(() => undefined)

    for (;;) {
      const mine: Owner = { pid: process.pid, at: Date.now() }
      try {
        const handle = await fs.open(file, "wx")
        await handle.writeFile(JSON.stringify(mine))
        await handle.close()
        return {
          path: file,
          async [Symbol.asyncDispose]() {
            const current = await read(file)
            if (current && current.pid === mine.pid && current.at === mine.at) {
              await fs.unlink(file).catch(() => undefined)
            }
          },
        }
      } catch (error) {
        if ((error as { code?: string }).code !== "EEXIST") throw error
      }

      const held = await age(file)
      if (held === undefined) {
        // Released while we looked. Contend again rather than wait out a lock
        // that is no longer there.
        if (Date.now() >= deadline) return undefined
        continue
      }
      if (held > staleMs) {
        // Abandoned — or written by a process that died mid-write. Clear it and
        // contend again; `wx` still decides who actually gets in.
        await fs.unlink(file).catch(() => undefined)
        if (Date.now() >= deadline) return undefined
        continue
      }

      if (Date.now() >= deadline) return undefined
      await sleep(pollMs)
    }
  }
}
