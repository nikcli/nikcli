/**
 * `@nikcli-ai/plugin-gadgets/tui` — the terminal half.
 *
 * Add `"@nikcli-ai/plugin-gadgets"` to `plugin` in `tui.json` and the TUI gets
 * `/gadget` (list), `/gadget pair`, `/gadget health <id>`, `/gadget send <id>
 * <text>` and `/gadget revoke <id>`, and a "Gadgets" block in the sidebar once
 * one is paired. It talks to the bridge's `/admin` routes,
 * which answer this machine only, so the TUI has to run where the nikcli
 * server runs. Option `url` points it elsewhere on the same machine
 * (default `http://127.0.0.1:4097`).
 *
 * A manifest asking for `commands` only: the TUI host supplies it, and there is
 * nothing else this plugin needs from the host.
 */
import { Plugin } from "@nikcli-ai/plugin/v2/tui"
import type { Context } from "@nikcli-ai/plugin/v2/tui/context"
import { GadgetError, ROUTES, type GadgetInfo, type HealthInfo, type PairWindow } from "@nikcli-ai/gadget/protocol"
import { trimTrailingSlashes } from "@nikcli-ai/gadget"
import { Gadgets } from "./sidebar.tsx"

const ID = "nikcli:gadgets"

async function call<T>(base: string, method: string, path: string, body?: unknown): Promise<T> {
  let response: Response
  try {
    response = await fetch(base + path, {
      method,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(65_000),
    })
  } catch {
    throw new Error(
      `the gadgets bridge is not reachable at ${base}: is nikcli's server running with the plugin enabled?`,
    )
  }
  const text = await response.text()
  const parsed: unknown = text ? JSON.parse(text) : undefined
  if (!response.ok) throw GadgetError.fromBody(parsed) ?? new Error(`bridge answered ${response.status}`)
  return parsed as T
}

function line(info: GadgetInfo): string {
  const state = !info.confirmed ? "waiting for button" : info.online ? "online" : "offline"
  return `${info.id.padEnd(18)} ${state.padEnd(18)} ${info.commands.length} commands${info.display ? `, ${info.display.columns}x${info.display.rows} display` : ""}`
}

function bytes(value: number): string {
  return value >= 1 << 30 ? `${(value / (1 << 30)).toFixed(1)} GB` : `${Math.round(value / (1 << 20))} MB`
}

function health(info: HealthInfo): string {
  return [
    `uptime ${Math.floor(info.uptimeSec / 3600)}h ${Math.floor((info.uptimeSec % 3600) / 60)}m`,
    `load ${info.load.map((value) => value.toFixed(2)).join(" ")}`,
    `memory ${bytes(info.memory.freeBytes)} free of ${bytes(info.memory.totalBytes)}`,
    ...(info.disk
      ? [`disk ${bytes(info.disk.freeBytes)} free of ${bytes(info.disk.totalBytes)} (${info.disk.path})`]
      : []),
    ...(info.temperatureC === undefined ? [] : [`temperature ${info.temperatureC.toFixed(1)} °C`]),
  ].join("\n")
}

export function setup(context: Context) {
  const base = trimTrailingSlashes(
    typeof context.options.url === "string" ? context.options.url : "http://127.0.0.1:4097",
  )
  const { ui } = context

  const alert = (title: string, message: string) =>
    ui.dialog.replace(() => ui.DialogAlert({ title, message, onConfirm: () => ui.dialog.clear() }))
  const problem = (error: unknown) =>
    ui.toast({
      variant: "error",
      title: "Gadgets",
      message:
        error instanceof Error
          ? error instanceof GadgetError
            ? `${error.name}: ${error.message}`
            : error.message
          : String(error),
      duration: 6000,
    })

  const list = async () => {
    const all = await call<GadgetInfo[]>(base, "GET", ROUTES.admin.devices)
    alert(
      "Gadgets",
      all.length
        ? all.map(line).join("\n")
        : "No gadgets are paired.\nRun /gadget pair, then nikcli-gadget pair on the device.",
    )
  }

  const pair = async () => {
    const window = await call<PairWindow>(base, "POST", ROUTES.admin.pair)
    const minutes = Math.round((window.expiresAt - Date.now()) / 60_000)
    alert(
      "Pair a gadget",
      [
        `Code: ${window.code}   (open for ${minutes} minutes)`,
        "",
        "On the device:",
        `nikcli-gadget pair --server ${window.url} --code ${window.code}`,
      ].join("\n"),
    )
  }

  const run = async (input?: string) => {
    const [action = "list", device, ...rest] = (input ?? "").trim().split(/\s+/).filter(Boolean)
    switch (action) {
      case "list":
        return list()
      case "pair":
        return pair()
      case "health": {
        if (!device) throw new Error("usage: /gadget health <id>")
        return alert(`${device} health`, health(await call<HealthInfo>(base, "GET", ROUTES.admin.health(device))))
      }
      case "send": {
        if (!device || rest.length === 0) throw new Error("usage: /gadget send <id> <text>")
        await call(base, "POST", ROUTES.admin.message(device), { text: rest.join(" ") })
        return ui.toast({ variant: "success", message: `sent to ${device}`, duration: 3000 })
      }
      case "revoke": {
        if (!device) throw new Error("usage: /gadget revoke <id>")
        await call(base, "DELETE", ROUTES.admin.device(device))
        return ui.toast({ variant: "success", message: `${device} unpaired`, duration: 3000 })
      }
      default:
        throw new Error(`unknown /gadget action ${action}: list, pair, health, send, revoke`)
    }
  }

  const guarded =
    <Args extends unknown[]>(fn: (...args: Args) => Promise<unknown>) =>
    (...args: Args) => {
      fn(...args).catch(problem)
    }

  const off = [
    ui.command({
      name: "gadget",
      title: "Gadgets",
      description: "List, pair and control gadgets: /gadget [list|pair|health <id>|send <id> <text>|revoke <id>]",
      namespace: "Gadgets",
      slash: { name: "gadget", aliases: ["gadgets"], arguments: true },
      run: guarded(run),
    }),
    ui.command({
      name: "gadget.pair",
      title: "Pair a gadget",
      description: "Open a ten minute pairing window and show the code",
      namespace: "Gadgets",
      run: guarded(() => pair()),
    }),
  ]
  off.push(ui.slot("sidebar.content", () => <Gadgets url={base} />))
  return () => off.forEach((dispose) => dispose())
}

export default Plugin.define({
  manifest: { id: ID, version: "1.427.0", kind: "user", capabilities: ["commands", "routes"] },
  id: ID,
  setup,
})
