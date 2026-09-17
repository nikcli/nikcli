import { createSignal, onCleanup } from "solid-js"
import type { Shot } from "./tray"

/**
 * Where the tray's screenshots come from.
 *
 * The host watches the folder the operating system saves screenshots to and
 * announces each one as it lands. This wraps that in the shape the tray wants:
 * a newest-first list, a way to take one out of it, and nothing else.
 *
 * Kept apart from the tray so the tray can be rendered — and read — without a
 * desktop host, and so this can be swapped for another source later without the
 * component learning about it.
 */

/** How many to keep on screen. Older ones are still on disk, just not in the way. */
const KEEP = 12

export interface ShotSource {
  shots: () => Shot[]
  dismiss: (path: string) => void
  remove: (path: string) => Promise<void>
  load: (path: string) => Promise<Uint8Array | null>
  /** Where the host is watching, once it has answered. Undefined in the browser. */
  folder: () => string | undefined
}

export function createShotSource(inTauri: boolean): ShotSource {
  const [shots, setShots] = createSignal<Shot[]>([])
  const [folder, setFolder] = createSignal<string>()
  /*
   * Dismissed paths are remembered, because the folder watcher has no idea a
   * screenshot was put away: the file is still there, and the next `shots_recent`
   * — after a reload, or a second window — would bring it straight back.
   */
  const dismissed = new Set<string>()

  const add = (incoming: Shot[]) => {
    setShots((current) => {
      const byPath = new Map(current.map((shot) => [shot.path, shot]))
      for (const shot of incoming) {
        if (dismissed.has(shot.path)) continue
        byPath.set(shot.path, shot)
      }
      return [...byPath.values()].sort((a, b) => b.modified_ms - a.modified_ms).slice(0, KEEP)
    })
  }

  if (inTauri) {
    /*
     * The unlisten handle is held in a variable, and the cleanup that uses
     * it is registered *synchronously*.
     *
     * Solid's owner is only current during the synchronous part of a
     * reactive scope; after an await it is null, and `onCleanup` there is a
     * silent no-op — it neither runs nor warns. So `stop` was never called:
     * the `shot:new` listener outlived the surface that installed it, and a
     * second surface added a second listener on top of the first.
     *
     * `disposed` covers the race where cleanup happens while the dynamic
     * imports are still in flight, in which case the listener must be
     * detached the moment it exists.
     */
    let disposed = false
    let stop: (() => void) | undefined

    onCleanup(() => {
      disposed = true
      stop?.()
      stop = undefined
    })

    void (async () => {
      const { invoke } = await import("@tauri-apps/api/core")
      const { listen } = await import("@tauri-apps/api/event")
      if (disposed) return

      const dir = await invoke<string | null>("shots_dir").catch(() => null)
      if (!dir || disposed) return
      setFolder(dir)

      // What is already there first: the screenshot taken a moment before
      // switching to ADE is the one the user came here to use, and it arrived
      // before anything was listening.
      const recent = await invoke<Shot[]>("shots_recent", { dir, limit: KEEP }).catch(() => [])
      if (disposed) return
      add(recent)

      const unlisten = await listen<Shot>("shot:new", (event) => add([event.payload]))
      if (disposed) {
        unlisten()
        return
      }
      stop = unlisten

      await invoke("shots_watch", { dir }).catch(() => undefined)
    })()
  }

  return {
    shots,
    folder,
    dismiss: (path) => {
      dismissed.add(path)
      setShots((current) => current.filter((shot) => shot.path !== path))
    },
    remove: async (path) => {
      dismissed.add(path)
      setShots((current) => current.filter((shot) => shot.path !== path))
      if (!inTauri) return
      const { invoke } = await import("@tauri-apps/api/core")
      await invoke("shot_delete", { path }).catch(() => undefined)
    },
    load: async (path) => {
      if (!inTauri) return null
      const { invoke } = await import("@tauri-apps/api/core")
      const bytes = await invoke<number[]>("shot_bytes", { path }).catch(() => null)
      return bytes ? new Uint8Array(bytes) : null
    },
  }
}
