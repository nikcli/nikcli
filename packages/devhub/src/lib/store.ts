import { createEffect, createMemo, createRoot, createSignal, onCleanup } from "solid-js"
import { showToast } from "@nikcli-ai/ui/toast"
import { clientFor } from "./api"
import { errorText, native, type ServiceInfo, type Snapshot } from "./native"

export const HISTORY = 150

export type Sample = {
  at: number
  cpu: number
  mem: number
  swap: number
  nikcliRss: number
  nikcliCpu: number
  procs: number
}

function createStore() {
  const [services, setServices] = createSignal<ServiceInfo[]>([])
  const [selected, setSelected] = createSignal<string | undefined>(localStorage.getItem("devhub.service") ?? undefined)
  const [snapshot, setSnapshot] = createSignal<Snapshot>()
  const [history, setHistory] = createSignal<Sample[]>([])
  const [error, setError] = createSignal<string>()
  const [paused, setPaused] = createSignal(false)
  const [repo, setRepo] = createSignal<string>()
  const [repoError, setRepoError] = createSignal<string>()

  // Rust sorts live services first (newest first), so the fallback is always the best one; a stale
  // registration left behind by a crashed service is never picked over a running one.
  const service = createMemo(() => {
    const all = services()
    const chosen = all.find((s) => s.url === selected())
    return chosen?.alive ? chosen : (all.find((s) => s.alive) ?? chosen ?? all[0])
  })
  const client = createMemo(() => {
    const s = service()
    return s ? clientFor(s.url) : undefined
  })

  createEffect(() => {
    const s = selected()
    if (s) localStorage.setItem("devhub.service", s)
  })

  // Signed-in account (GET /account answers `null` when nobody is signed in).
  const [account, setAccount] = createSignal<{ email: string } | null | undefined>()
  const refreshAccount = () => {
    const s = service()
    if (!s?.alive) return setAccount(undefined)
    native
      .api({ serviceUrl: s.url, method: "GET", path: "/account" })
      .then((r) =>
        setAccount(
          r.status === 200 && r.body.trim() && r.body.trim() !== "null"
            ? (JSON.parse(r.body) as { email: string })
            : null,
        ),
      )
      .catch(() => setAccount(undefined))
  }
  createEffect(() => (service()?.url, service()?.alive, refreshAccount()))
  const accountTimer = setInterval(refreshAccount, 60_000)
  onCleanup(() => clearInterval(accountTimer))

  const refreshServices = () => native.services().then(setServices, (e) => setError(errorText(e)))
  const refreshRepo = () =>
    native.repoRoot().then(
      (r) => (setRepo(r), setRepoError(undefined)),
      (e) => setRepoError(errorText(e)),
    )

  const ingest = (snap: Snapshot) => {
    setSnapshot(snap)
    const own = snap.procs.filter((p) => ["service", "server", "cli", "test", "dev", "child"].includes(p.category))
    setHistory((h) =>
      [
        ...h,
        {
          at: snap.at,
          cpu: snap.cpuUsage,
          mem: snap.memTotal ? (snap.memUsed / snap.memTotal) * 100 : 0,
          swap: snap.swapTotal ? (snap.swapUsed / snap.swapTotal) * 100 : 0,
          nikcliRss: own.reduce((a, p) => a + p.rss, 0),
          nikcliCpu: own.reduce((a, p) => a + p.cpu, 0),
          procs: own.length,
        },
      ].slice(-HISTORY),
    )
    setError(undefined)
  }
  const tick = () => native.snapshot().then(ingest, (e) => setError(errorText(e)))

  void refreshServices()
  void refreshRepo()
  void tick()
  // Native sampler pushes a snapshot every 2 s over an IPC channel; pausing just drops them.
  native.subscribeSystem((snap) => !paused() && ingest(snap), 2000).catch((e) => setError(errorText(e)))
  const slow = setInterval(() => void refreshServices(), 5000)
  onCleanup(() => clearInterval(slow))

  return {
    services,
    service,
    select: setSelected,
    client,
    snapshot,
    account,
    refreshAccount,
    history,
    error,
    paused,
    setPaused,
    refreshServices,
    refreshNow: tick,
    repo,
    repoError,
    setRepo: async (path: string) => {
      setRepo(await native.setRepoRoot(path))
      setRepoError(undefined)
    },
  }
}

export const app = createRoot(createStore)

export function toastError(title: string, e: unknown) {
  showToast({ variant: "error", title, description: errorText(e) })
}
export function toastOk(title: string, description?: string) {
  showToast({ variant: "success", title, description })
}

/** Polls an async loader; re-runs when the service changes. Returns accessors. */
export function createPoll<T>(load: () => Promise<T>, intervalMs: number, deps?: () => unknown) {
  const [data, setData] = createSignal<T>()
  const [err, setErr] = createSignal<string>()
  const [loading, setLoading] = createSignal(true)
  let alive = true
  let stamp = 0
  const run = async () => {
    const mine = ++stamp
    try {
      const v = await load()
      if (alive && mine === stamp) (setData(() => v), setErr(undefined))
    } catch (e) {
      if (alive && mine === stamp) setErr(errorText(e))
    } finally {
      if (alive && mine === stamp) setLoading(false)
    }
  }
  createEffect(() => {
    deps?.()
    setLoading(true)
    void run()
  })
  const timer = intervalMs > 0 ? setInterval(() => void run(), intervalMs) : undefined
  onCleanup(() => ((alive = false), timer && clearInterval(timer)))
  return { data, error: err, loading, reload: run }
}
