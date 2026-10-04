/**
 * `@nikcli-ai/plugin-gadgets` — the server half.
 *
 * Loaded by nikcli from `plugin` in `nikcli.json`. It starts the bridge (one
 * listener per process, shared by every project instance that loads the
 * plugin), registers the `gadget` tool, and gives the bridge two ways into the
 * running instance: starting a session when a device sends a message, and
 * answering a button press through `mod.event` so a mod that drew a `Button`
 * for the gadget can react to it.
 *
 * Settings. `nikcli.json` lists server plugins as bare specifiers, so they come
 * from the environment, with the second argument of `server()` taking
 * precedence for a host that passes one:
 *   NIKCLI_GADGET_PORT         listener port, default 4097
 *   NIKCLI_GADGET_HOST         bind address, default 0.0.0.0 (devices are on the LAN)
 *   NIKCLI_GADGET=0            registers nothing
 *   NIKCLI_GADGET_BRIDGE_FILE  where paired devices are stored
 */
import os from "node:os"
import path from "node:path"
import type { Hooks, PluginInput, PluginModule, PluginOptions } from "@nikcli-ai/plugin"
import type { DeviceEvent, GadgetInfo } from "@nikcli-ai/gadget/protocol"
import { Bridge, DEFAULT_PORT, type BridgeHooks } from "./bridge.ts"
import { createGadgetTool } from "./tool.ts"

export { Bridge, DEFAULT_PORT } from "./bridge.ts"
export { Registry } from "./registry.ts"

interface Shared {
  readonly key: string
  readonly bridge: Bridge
  refs: number
  readonly bindings: PluginInput[]
}

const shared = new Map<string, Shared>()

function setting(options: PluginOptions) {
  const raw = process.env.NIKCLI_GADGET_PORT
  const fromEnv = raw === undefined || raw === "" ? undefined : Number(raw)
  if (fromEnv !== undefined && (!Number.isInteger(fromEnv) || fromEnv < 0 || fromEnv > 65_535)) {
    throw new Error(`NIKCLI_GADGET_PORT must be a port number, got ${JSON.stringify(raw)}`)
  }
  return {
    enabled: options.enabled !== false && process.env.NIKCLI_GADGET !== "0",
    port: typeof options.port === "number" ? options.port : (fromEnv ?? DEFAULT_PORT),
    host: typeof options.host === "string" ? options.host : process.env.NIKCLI_GADGET_HOST || "0.0.0.0",
  }
}

function dataFile(options: PluginOptions): string {
  if (typeof options.file === "string" && options.file) return options.file
  if (process.env.NIKCLI_GADGET_BRIDGE_FILE) return process.env.NIKCLI_GADGET_BRIDGE_FILE
  const data = process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share")
  return path.join(data, "nikcli", "gadgets", "devices.json")
}

function failed(error: unknown, what: string): never {
  const detail =
    error instanceof Error
      ? error.message
      : typeof error === "object" && error !== null
        ? JSON.stringify(error)
        : String(error)
  throw new Error(`${what}: ${detail}`)
}

/** The hooks the bridge uses, bound to the newest project instance that loaded the plugin. */
function hooksFor(entry: Shared): BridgeHooks | undefined {
  const input = entry.bindings[entry.bindings.length - 1]
  if (!input) return undefined
  const { client, directory } = input
  return {
    async message(device: GadgetInfo, text: string, sessionID?: string) {
      let id = sessionID
      if (!id) {
        const created = await client.session.create({ title: `Gadget: ${device.name}`, directory })
        if (created.error || !created.data) failed(created.error, "could not start a session")
        id = created.data.id
      }
      const sent = await client.session.promptAsync({
        sessionID: id,
        parts: [{ type: "text", text: `[gadget ${device.id}] ${text}` }],
        directory,
      })
      if (sent.error) failed(sent.error, "could not deliver the message")
      return id
    },
    async press(device: GadgetInfo, event: DeviceEvent) {
      const answered = await client.mod.event({
        kind: event.kind === "press" ? "press" : "input",
        key: event.key,
        ...(event.value === undefined ? {} : { value: event.value }),
        component: "Gadget",
        requestId: device.id,
        directory,
      })
      if (answered.error || !answered.data) return { handled: false }
      return { handled: answered.data.handled }
    },
  }
}

function acquire(input: PluginInput, options: PluginOptions): Shared {
  const { port, host } = setting(options)
  const key = `${host}:${port}`
  let entry = shared.get(key)
  if (!entry) {
    const created: Shared = {
      key,
      refs: 0,
      bindings: [],
      bridge: new Bridge({ port, host, file: dataFile(options), hooks: () => hooksFor(created) }),
    }
    created.bridge.start()
    shared.set(key, created)
    entry = created
  }
  entry.refs++
  entry.bindings.push(input)
  return entry
}

function release(entry: Shared, input: PluginInput) {
  const at = entry.bindings.indexOf(input)
  if (at >= 0) entry.bindings.splice(at, 1)
  if (--entry.refs > 0) return
  entry.bridge.stop()
  shared.delete(entry.key)
}

const plugin: PluginModule = {
  id: "nikcli:gadgets",
  async server(input: PluginInput, options: PluginOptions = {}): Promise<Hooks> {
    if (!setting(options).enabled) return {}
    const entry = acquire(input, options)
    return {
      tool: { gadget: createGadgetTool(() => entry.bridge) },
      dispose: async () => release(entry, input),
    }
  },
}

export default plugin
