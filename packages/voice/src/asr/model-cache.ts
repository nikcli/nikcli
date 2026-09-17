/**
 * The local model, on disk: whether it is there, how big it is, and how to
 * throw it away.
 *
 * parakeet.js downloads the weights from Hugging Face once and keeps them as
 * blobs in IndexedDB — database `parakeet-cache-db`, store `file-store`, one
 * entry per file keyed `hf-<repo>-<revision>-<subfolder>-<filename>`. That is
 * the whole persistence story, and it is a good one: blob-valued IndexedDB in
 * Chromium is file-backed, so the weights survive a reload and an application
 * restart without being re-fetched.
 *
 * What was missing is everything *around* it, and each gap had a user-visible
 * consequence:
 *
 *   - Nothing could say whether the model was already downloaded, so the panel
 *     offered the local engine with no hint that choosing it meant a wait of
 *     several hundred megabytes, and `isModelDownloaded` — which the readiness
 *     check already accepted — was never supplied by anything but tests.
 *   - Nothing could throw a bad copy away. A response that is truncated
 *     mid-stream still arrives with a 200, and the short blob is cached and
 *     served forever: the model is then permanently broken with no way to fix
 *     it from inside the application.
 *   - Nothing asked the browser to keep it. Best-effort storage is evictable
 *     under disk pressure, and a multi-gigabyte blob is the first thing an
 *     eviction policy looks at — which is exactly the "it re-downloads every
 *     time" complaint.
 *
 * Two other things move the cache and are worth knowing before blaming this
 * file: IndexedDB is per-origin, so a dev build on `localhost:5177` and a
 * packaged build on `tauri.localhost` have separate caches; and it lives in the
 * WebView2 user-data folder, so a launch that does not set that folder to the
 * usual place starts from an empty one.
 */

/** The database parakeet.js writes to. Must match `parakeet.js/src/hub.js`. */
export const CACHE_DB = "parakeet-cache-db"
export const CACHE_STORE = "file-store"

/** The Hugging Face repository the default model comes from. */
export const MODEL_REPO = "ysdede/parakeet-tdt-0.6b-v3-onnx"

export interface CachedModel {
  /** How many files are cached for this repository. */
  readonly files: number
  /** Their total size in bytes, as far as the blobs report it. */
  readonly bytes: number
  /**
   * Whether there is enough here to start without downloading.
   *
   * "Enough" is a count, not a checksum: an encoder, a decoder and a
   * vocabulary is three files, and anything fewer means an interrupted
   * download. It cannot tell a truncated file from a whole one — nothing
   * short of a checksum can, and Hugging Face does not give us one here — so
   * the remedy for a bad copy is `clearModelCache`, which is why that exists.
   */
  readonly present: boolean
  /** Storage source: 'indexeddb' | 'filesystem' | 'none' */
  readonly source?: "indexeddb" | "filesystem" | "none"
  /** Local path on disk if detected in local user cache */
  readonly localPath?: string
  /** Model file format: 'onnx' | 'gguf' */
  readonly modelFormat?: "onnx" | "gguf"
}

export const EMPTY_CACHE: CachedModel = Object.freeze({
  files: 0,
  bytes: 0,
  present: false,
  source: "none",
})

/** Below this, whatever is in the cache is the remains of an interrupted download. */
const MINIMUM_FILES = 3

export interface CacheOptions {
  /** Test seam. Defaults to the global `indexedDB`. */
  readonly factory?: IDBFactory
  /** Which repository to look for. Defaults to the shipped model. */
  readonly repo?: string
  /** Whether to bypass local filesystem probing. */
  readonly skipFilesystem?: boolean
}

function resolveFactory(options: CacheOptions): IDBFactory | undefined {
  if (options.factory) return options.factory
  return typeof indexedDB !== "undefined" ? indexedDB : undefined
}

/**
 * Opens the cache database *without creating it*.
 *
 * The distinction matters: `indexedDB.open` happily creates an empty database,
 * and asking "is the model downloaded?" must never be the thing that leaves a
 * database behind. An upgrade event means it was not there, so the request is
 * aborted and the answer is "nothing cached".
 */
function openExisting(factory: IDBFactory): Promise<IDBDatabase | undefined> {
  return new Promise((resolve) => {
    let created = false
    const request = factory.open(CACHE_DB)

    request.onupgradeneeded = () => {
      created = true
      try {
        request.transaction?.abort()
      } catch {
        // The abort is what prevents the empty database; a browser that
        // refuses it leaves one behind, which is harmless.
      }
    }
    request.onsuccess = () => {
      if (created) {
        request.result.close()
        resolve(undefined)
        return
      }
      resolve(request.result)
    }
    request.onerror = () => resolve(undefined)
    request.onblocked = () => resolve(undefined)
  })
}

function keysOf(db: IDBDatabase): Promise<IDBValidKey[]> {
  return new Promise((resolve) => {
    if (!db.objectStoreNames.contains(CACHE_STORE)) {
      resolve([])
      return
    }
    try {
      const request = db.transaction(CACHE_STORE, "readonly").objectStore(CACHE_STORE).getAllKeys()
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => resolve([])
    } catch {
      resolve([])
    }
  })
}

function valuesOf(db: IDBDatabase, wanted: readonly IDBValidKey[]): Promise<unknown[]> {
  return new Promise((resolve) => {
    if (wanted.length === 0 || !db.objectStoreNames.contains(CACHE_STORE)) {
      resolve([])
      return
    }
    try {
      const store = db.transaction(CACHE_STORE, "readonly").objectStore(CACHE_STORE)
      const out: unknown[] = []
      let remaining = wanted.length
      for (const key of wanted) {
        const request = store.get(key)
        request.onsuccess = () => {
          out.push(request.result)
          if (--remaining === 0) resolve(out)
        }
        request.onerror = () => {
          if (--remaining === 0) resolve(out)
        }
      }
    } catch {
      resolve([])
    }
  })
}

/**
 * Which of these keys belong to the repository asked about.
 *
 * Pure, and separate, because the key format is a contract with another
 * package: `hf-<repo>-<revision>-<subfolder>-<filename>`, where the repo is
 * itself `owner/name` and therefore contains a slash but no leading marker.
 * Matching on the prefix is the only thing the format guarantees.
 */
export function keysForRepo(keys: readonly IDBValidKey[], repo: string): string[] {
  const prefix = `hf-${repo}-`
  return keys.filter((key): key is string => typeof key === "string" && key.startsWith(prefix))
}

/** Adds up whatever of these values look like stored files. */
export function sizeOf(values: readonly unknown[]): number {
  let bytes = 0
  for (const value of values) {
    if (value && typeof value === "object" && "size" in value && typeof (value as Blob).size === "number") {
      bytes += (value as Blob).size
    } else if (value instanceof ArrayBuffer) {
      bytes += value.byteLength
    }
  }
  return bytes
}

/** Whether this many cached files is a whole model or the remains of one. */
export function isComplete(files: number): boolean {
  return files >= MINIMUM_FILES
}

/**
 * Probes the local machine storage (Hugging Face cache, nikcli local cache, etc.)
 * for existing Parakeet models (both GGUF and ONNX).
 */
export async function inspectLocalFilesystemModel(): Promise<{
  present: boolean
  files: number
  bytes: number
  localPath?: string
  modelFormat?: "onnx" | "gguf"
}> {
  // 1. Try Node.js / Bun runtime filesystem if available
  try {
    const isNodeLike =
      typeof process !== "undefined" &&
      Boolean(process.versions?.node || (process as any).isBun)
    if (isNodeLike) {
      const fs = await import("fs")
      const path = await import("path")
      const home = process.env.USERPROFILE || process.env.HOME || ""
      const candidateBases: string[] = []

      if (process.env.HF_HOME) candidateBases.push(path.join(process.env.HF_HOME, "hub"))
      if (process.env.HUGGINGFACE_HUB_CACHE) candidateBases.push(process.env.HUGGINGFACE_HUB_CACHE)
      if (home) {
        candidateBases.push(path.join(home, ".cache", "huggingface", "hub"))
        candidateBases.push(path.join(home, ".cache", "nikcli", "models"))
        candidateBases.push(path.join(home, ".cache", "hyperframes", "whisper", "models"))
      }
      if (process.env.LOCALAPPDATA) {
        candidateBases.push(path.join(process.env.LOCALAPPDATA, "huggingface", "hub"))
        candidateBases.push(path.join(process.env.LOCALAPPDATA, "nikcli", "models"))
      }

      for (const base of candidateBases) {
        if (!fs.existsSync(base)) continue
        try {
          const entries = fs.readdirSync(base)
          entries.sort((a, b) => {
            const aTdt = a.toLowerCase().includes("tdt-0.6b-v3") ? 1 : 0
            const bTdt = b.toLowerCase().includes("tdt-0.6b-v3") ? 1 : 0
            return bTdt - aTdt
          })
          for (const entry of entries) {
            const lower = entry.toLowerCase()
            if (!lower.includes("parakeet")) continue
            const fullDir = path.join(base, entry)

            // Direct model file
            if (lower.endsWith(".gguf") || lower.endsWith(".onnx") || lower.endsWith(".bin")) {
              const stat = fs.statSync(fullDir)
              if (stat.size > 10_000_000) {
                return {
                  present: true,
                  files: 1,
                  bytes: stat.size,
                  localPath: fullDir,
                  modelFormat: lower.endsWith(".gguf") ? "gguf" : "onnx",
                }
              }
            }

            // Snapshot directory in HuggingFace cache format
            const snapDir = path.join(fullDir, "snapshots")
            if (fs.existsSync(snapDir)) {
              for (const snap of fs.readdirSync(snapDir)) {
                const snapPath = path.join(snapDir, snap)
                const files = fs.readdirSync(snapPath)
                files.sort((a, b) => {
                  const aTdt = a.toLowerCase().includes("tdt-0.6b-v3") ? 1 : 0
                  const bTdt = b.toLowerCase().includes("tdt-0.6b-v3") ? 1 : 0
                  return bTdt - aTdt
                })
                for (const file of files) {
                  const fLower = file.toLowerCase()
                  if (fLower.endsWith(".gguf") || fLower.endsWith(".onnx") || fLower.endsWith(".bin")) {
                    const filePath = path.join(snapPath, file)
                    const stat = fs.statSync(filePath)
                    if (stat.size > 10_000_000) {
                      return {
                        present: true,
                        files: 1,
                        bytes: stat.size,
                        localPath: filePath,
                        modelFormat: fLower.endsWith(".gguf") ? "gguf" : "onnx",
                      }
                    }
                  }
                }
              }
            }
          }
        } catch {
          // Ignore individual folder traversal errors
        }
      }
    }
  } catch {
    // Node/Bun fs probe failed or unavailable; continue to Tauri probe
  }

  // 2. Try Tauri desktop host if running inside Tauri WebView
  try {
    const tauriGlobal =
      typeof window !== "undefined" &&
      Boolean((window as any).__TAURI_INTERNALS__ || (window as any).__TAURI__)
    if (tauriGlobal) {
      let invoke: ((cmd: string, args?: Record<string, unknown>) => Promise<any>) | undefined
      try {
        const tauriCore: any = await (new Function('return import("@tauri-apps/api/core")')().catch(() => null))
        if (tauriCore && typeof tauriCore.invoke === "function") {
          invoke = tauriCore.invoke
        } else if (typeof (window as any).__TAURI_INTERNALS__?.invoke === "function") {
          invoke = (window as any).__TAURI_INTERNALS__.invoke
        }
      } catch {
        // Tauri import unavailable
      }

      if (invoke) {
        const home = await invoke("home_dir")
        if (home && typeof home === "string") {
          const candidateHubs = [
            `${home}/.cache/huggingface/hub`,
            `${home}\\.cache\\huggingface\\hub`,
            `${home}/.cache/nikcli/models`,
            `${home}\\.cache\\nikcli\\models`,
          ]
          for (const hub of candidateHubs) {
            const exists = await invoke("path_exists", { path: hub })
            if (!exists) continue
            const entries: Array<{ name: string; path: string; is_dir: boolean; size: number }> =
              (await invoke("read_dir", { path: hub })) || []

            entries.sort((a: any, b: any) => {
              const aTdt = String(a.name || "").toLowerCase().includes("tdt-0.6b-v3") ? 1 : 0
              const bTdt = String(b.name || "").toLowerCase().includes("tdt-0.6b-v3") ? 1 : 0
              return bTdt - aTdt
            })

            for (const entry of entries) {
              const lower = String(entry.name || "").toLowerCase()
              if (!lower.includes("parakeet")) continue

              if (
                !entry.is_dir &&
                (lower.endsWith(".gguf") || lower.endsWith(".onnx") || lower.endsWith(".bin")) &&
                entry.size > 10_000_000
              ) {
                return {
                  present: true,
                  files: 1,
                  bytes: entry.size,
                  localPath: entry.path,
                  modelFormat: lower.endsWith(".gguf") ? "gguf" : "onnx",
                }
              }

              const snapPath = `${entry.path}/snapshots`
              if (await invoke("path_exists", { path: snapPath })) {
                const snaps: Array<{ name: string; path: string; is_dir: boolean }> =
                  (await invoke("read_dir", { path: snapPath })) || []
                for (const snap of snaps) {
                  const snapFiles: Array<{ name: string; path: string; size: number }> =
                    (await invoke("read_dir", { path: snap.path })) || []
                  snapFiles.sort((a: any, b: any) => {
                    const aTdt = String(a.name || "").toLowerCase().includes("tdt-0.6b-v3") ? 1 : 0
                    const bTdt = String(b.name || "").toLowerCase().includes("tdt-0.6b-v3") ? 1 : 0
                    return bTdt - aTdt
                  })
                  for (const sf of snapFiles) {
                    const sfLower = String(sf.name || "").toLowerCase()
                    if (
                      (sfLower.endsWith(".gguf") ||
                        sfLower.endsWith(".onnx") ||
                        sfLower.endsWith(".bin")) &&
                      sf.size > 10_000_000
                    ) {
                      return {
                        present: true,
                        files: 1,
                        bytes: sf.size,
                        localPath: sf.path,
                        modelFormat: sfLower.endsWith(".gguf") ? "gguf" : "onnx",
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  } catch {
    // Tauri probe failed or not in desktop environment
  }

  return { present: false, files: 0, bytes: 0 }
}

/**
 * What is cached, or nothing at all.
 *
 * Checks both browser IndexedDB storage and local disk caches (HuggingFace Hub,
 * local application storage) so pre-existing models on the user's computer are
 * detected and acknowledged without triggering unnecessary downloads.
 *
 * Never throws and never creates anything: this is called to draw a line in a
 * settings panel, and a panel that fails to open because a storage API was
 * unavailable would be a worse answer than "niente in cache".
 */
export async function inspectModelCache(options: CacheOptions = {}): Promise<CachedModel> {
  const factory = resolveFactory(options)
  const repo = options.repo ?? MODEL_REPO
  let db: IDBDatabase | undefined
  let indexedDbResult: CachedModel | undefined

  if (factory) {
    try {
      db = await openExisting(factory)
      if (db) {
        const mine = keysForRepo(await keysOf(db), repo)
        if (mine.length > 0) {
          const files = mine.length
          const bytes = sizeOf(await valuesOf(db, mine))
          const present = isComplete(files)
          indexedDbResult = {
            files,
            bytes,
            present,
            source: "indexeddb",
            modelFormat: "onnx",
          }
          if (present) {
            return indexedDbResult
          }
        }
      }
    } catch {
      // Ignore IndexedDB read errors and proceed to filesystem inspection
    } finally {
      db?.close()
    }
  }

  // If not found in IndexedDB and filesystem probing is not skipped, check disk
  if (!options.skipFilesystem) {
    try {
      const localFs = await inspectLocalFilesystemModel()
      if (localFs.present) {
        return {
          files: localFs.files,
          bytes: localFs.bytes,
          present: true,
          source: "filesystem",
          localPath: localFs.localPath,
          modelFormat: localFs.modelFormat,
        }
      }
    } catch {
      // Ignore filesystem probe errors
    }
  }

  return indexedDbResult ?? EMPTY_CACHE
}

/**
 * Deletes the cached model, so the next start downloads it again.
 *
 * The only cure for a truncated file, and the only way to reclaim the space
 * without DevTools. Returns how many entries were removed, so the panel can
 * say something true rather than "fatto" whatever happened.
 */
export async function clearModelCache(options: CacheOptions = {}): Promise<number> {
  const factory = resolveFactory(options)
  if (!factory) return 0

  const repo = options.repo ?? MODEL_REPO
  let db: IDBDatabase | undefined
  try {
    db = await openExisting(factory)
    if (!db) return 0
    if (!db.objectStoreNames.contains(CACHE_STORE)) return 0

    const mine = keysForRepo(await keysOf(db), repo)
    if (mine.length === 0) return 0

    await new Promise<void>((resolve) => {
      const transaction = db!.transaction(CACHE_STORE, "readwrite")
      const store = transaction.objectStore(CACHE_STORE)
      for (const key of mine) store.delete(key)
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => resolve()
      transaction.onabort = () => resolve()
    })

    return mine.length
  } catch {
    return 0
  } finally {
    db?.close()
  }
}

/**
 * Asks the browser not to evict what we are about to download.
 *
 * Without this the weights are stored best-effort, and best-effort storage is
 * what a browser clears first when the disk fills — several hundred megabytes
 * of blob being the most attractive thing in the box. Chromium grants this
 * silently for an installed application and may refuse it elsewhere; a refusal
 * is not an error, it only means the cache is evictable, so the answer is
 * reported rather than thrown.
 */
export async function requestPersistentStorage(): Promise<boolean> {
  try {
    const storage = typeof navigator !== "undefined" ? navigator.storage : undefined
    if (!storage || typeof storage.persist !== "function") return false
    if (typeof storage.persisted === "function" && (await storage.persisted())) return true
    return await storage.persist()
  } catch {
    return false
  }
}

export interface DownloadParakeetProgress {
  loaded: number
  total: number
  percent?: number
  file?: string
  message: string
}

export type DownloadParakeetProgressCallback = (progress: DownloadParakeetProgress) => void

export interface DownloadParakeetOptions {
  repo?: string
  modelKey?: string
  quant?: "int8" | "fp16"
  getParakeetModel?: any
  onProgress?: DownloadParakeetProgressCallback
}

/**
 * Directly downloads the quantized Parakeet model weights into local IndexedDB
 * storage, making the local transcriber immediately ready for offline use.
 */
export async function downloadParakeetModel(
  options: DownloadParakeetOptions = {}
): Promise<CachedModel> {
  await requestPersistentStorage()

  let getModel = options.getParakeetModel
  if (!getModel) {
    try {
      const pkg: any = await import("parakeet.js")
      getModel = pkg.getParakeetModel ?? pkg.default?.getParakeetModel
    } catch (err: any) {
      throw new Error(
        `Impossibile caricare parakeet.js per il download: ${err?.message ?? "modulo mancante"}`
      )
    }
  }

  if (typeof getModel !== "function") {
    throw new Error("Funzione getParakeetModel non trovata in parakeet.js.")
  }

  const modelKey = options.modelKey ?? "parakeet-tdt-0.6b-v3"
  const TOTAL_ESTIMATED_BYTES = 670_488_135
  let completedFilesBytes = 0
  let lastFile = ""

  const fileSizes: Record<string, number> = {
    "encoder-model.int8.onnx": 652_183_999,
    "decoder_joint-model.int8.onnx": 18_202_004,
    "vocab.txt": 102_132,
  }

  const progressBridge = (p: { loaded: number; total: number; file: string }) => {
    if (lastFile && p.file !== lastFile) {
      completedFilesBytes += fileSizes[lastFile] || 0
    }
    lastFile = p.file

    const currentTotalLoaded = Math.min(
      TOTAL_ESTIMATED_BYTES,
      completedFilesBytes + (p.loaded || 0)
    )
    const percent = Math.min(
      99,
      Math.max(1, Math.round((currentTotalLoaded / TOTAL_ESTIMATED_BYTES) * 100))
    )
    const mbLoaded = (currentTotalLoaded / (1024 * 1024)).toFixed(0)
    const mbTotal = (TOTAL_ESTIMATED_BYTES / (1024 * 1024)).toFixed(0)

    options.onProgress?.({
      loaded: currentTotalLoaded,
      total: TOTAL_ESTIMATED_BYTES,
      percent,
      file: p.file,
      message: `Scaricamento ${p.file}: ${percent}% (${mbLoaded} MB di ${mbTotal} MB)...`,
    })
  }

  options.onProgress?.({
    loaded: 0,
    total: TOTAL_ESTIMATED_BYTES,
    percent: 0,
    message: "Inizio scaricamento del modello Parakeet quantizzato INT8 (~640 MB)...",
  })

  await getModel(modelKey, {
    backend: "wasm",
    encoderQuant: options.quant ?? "int8",
    decoderQuant: "int8",
    preprocessorBackend: "js",
    progress: progressBridge,
  })

  options.onProgress?.({
    loaded: TOTAL_ESTIMATED_BYTES,
    total: TOTAL_ESTIMATED_BYTES,
    percent: 100,
    message: "Download completato con successo! Il modello è pronto all'uso.",
  })

  return await inspectModelCache({ repo: options.repo })
}
