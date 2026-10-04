/**
 * The `gadget` tool: how the agent reaches a paired device.
 *
 * One tool with an `action`, so the model sees a single entry in its tool list
 * however many gadgets are paired, and the devices' own commands travel as
 * data. What changes state asks first: `run` (except `device.health`), `pair`
 * and `revoke` go through `ctx.ask` under the permission id `gadget`, with the
 * pattern `<device>:<command>`, so a rule such as
 * `{ "gadget": { "pi-office:device.health": "allow", "*": "ask" } }` works and a
 * deny is a deny. `list`, `health`, `show` and `send` only read or draw.
 */
import { tool } from "@nikcli-ai/plugin/tool"
import { GadgetError, type GadgetInfo, type InvokeResult } from "@nikcli-ai/gadget/protocol"
import type { Bridge } from "./bridge.ts"

/** Commands that run whatever they are given. */
const OPEN_ENDED = new Set(["system.run", "file.write"])

const DESCRIPTION = `Work with gadgets: devices (a Raspberry Pi, a microcontroller, a panel) paired with this nikcli.

Actions:
- list: every paired gadget, whether it is online, and the commands it declares.
- health: uptime, load, memory, disk and temperature of a gadget (device.health).
- run: run one of the gadget's declared commands (command, args). Built-ins on a Linux gadget: system.run {argv}, file.read {path, offset, length}, file.write {path, content, append, final}, device.health. State-changing commands ask the user first.
- show: draw a tree on the gadget's display (tree), e.g. {"type":"Markdown","props":{"text":"# Build green"}}. Node types: Box, Text, Markdown, Code, Button.
- send: send text to the gadget (its display, or its log) (text).
- pair: open a ten minute pairing window and return the code and URL to enter on the new device. Asks the user first.
- revoke: unpair a gadget and invalidate its token. Asks the user first.

A gadget that is offline fails fast with GadgetError.Offline; one that is busy queues up to eight commands. Output is cut at the command's limit and marked truncated.`

function fail(error: unknown): never {
  if (error instanceof GadgetError) throw new Error(`${error.name}: ${error.message}`)
  throw error
}

function describe(info: GadgetInfo): string {
  const state = !info.confirmed ? "waiting for its button" : info.online ? "online" : "offline"
  const commands = info.commands.map((command) => command.name).join(", ") || "none declared"
  const display = info.display ? `, display ${info.display.columns}x${info.display.rows}` : ""
  const buttons = info.buttons?.length ? `, buttons ${info.buttons.join("/")}` : ""
  return `${info.id} (${info.name}) — ${state}; ${info.platform.os}/${info.platform.arch}; commands: ${commands}${display}${buttons}`
}

function formatResult(device: string, command: string, result: InvokeResult) {
  const header = `${device} ${command}: ${result.isError ? "failed" : "ok"}${result.exitCode === undefined ? "" : ` (exit ${result.exitCode})`} in ${result.durationMs} ms${result.truncated ? ", output truncated" : ""}`
  return { header, body: result.output }
}

export function createGadgetTool(bridge: () => Bridge | undefined) {
  const live = (): Bridge => {
    const current = bridge()
    if (!current) throw new Error("the gadgets bridge is not running in this process")
    if (!current.listening) {
      throw new Error(
        current.problem
          ? `the gadgets bridge could not start: ${current.problem}`
          : "the gadgets bridge has been stopped",
      )
    }
    return current
  }

  return tool({
    description: DESCRIPTION,
    args: {
      action: tool.schema.enum(["list", "health", "run", "show", "send", "pair", "revoke"]).describe("What to do"),
      device: tool.schema.string().optional().describe("Gadget id from `list` (required except for list and pair)"),
      command: tool.schema.string().optional().describe("For run: the declared command, e.g. system.run"),
      args: tool.schema
        .record(tool.schema.string(), tool.schema.unknown())
        .optional()
        .describe("For run: the command's arguments"),
      tree: tool.schema
        .record(tool.schema.string(), tool.schema.unknown())
        .optional()
        .describe("For show: the drawing tree"),
      text: tool.schema.string().optional().describe("For send: the text"),
      timeoutMs: tool.schema.number().int().positive().optional().describe("For run: deadline in milliseconds"),
    },
    async execute(input, ctx) {
      const registry = live().registry
      const text = (name: "device" | "command" | "text"): string => {
        const value = input[name]
        if (value === undefined || value === "") throw new Error(`${input.action} needs ${name}`)
        return value
      }
      const tree = (): Record<string, unknown> => {
        if (!input.tree) throw new Error(`${input.action} needs tree`)
        return input.tree
      }
      try {
        switch (input.action) {
          case "list": {
            const all = registry.list()
            return {
              title: "gadgets",
              output: all.length ? all.map(describe).join("\n") : "no gadgets are paired",
              metadata: { count: all.length },
            }
          }
          case "pair": {
            await ctx.ask({
              permission: "gadget",
              patterns: ["pair"],
              always: [],
              metadata: { action: "pair" },
            })
            const window = registry.openPairing()
            const minutes = Math.round((window.expiresAt - Date.now()) / 60_000)
            return {
              title: "pairing window",
              output: [
                `Pairing is open for ${minutes} minutes. Code: ${window.code}`,
                `On the new device: nikcli-gadget pair --server ${window.url} --code ${window.code}`,
                "A device with a button finishes by pressing it once.",
              ].join("\n"),
              metadata: { code: window.code, url: window.url, expiresAt: window.expiresAt },
            }
          }
          case "revoke": {
            const device = text("device")
            await ctx.ask({
              permission: "gadget",
              patterns: [`${device}:revoke`],
              always: [],
              metadata: { action: "revoke", device },
            })
            registry.revoke(device)
            return {
              title: `revoked ${device}`,
              output: `${device} was unpaired and its token revoked`,
              metadata: { device },
            }
          }
          case "health": {
            const device = text("device")
            const result = await registry.invoke(device, { command: "device.health", timeoutMs: input.timeoutMs })
            const { header, body } = formatResult(device, "device.health", result)
            return {
              title: `${device} health`,
              output: `${header}\n${body}`,
              metadata: { device, isError: result.isError },
            }
          }
          case "run": {
            const device = text("device")
            const command = text("command")
            if (command !== "device.health") {
              await ctx.ask({
                permission: "gadget",
                patterns: [`${device}:${command}`],
                // `system.run` and `file.write` take any argument, so "always allow" would allow `rm -rf` as readily as `ls`:
                // they are asked every time unless the user writes a rule by hand. A command the gadget's author declared
                // with a narrow purpose can be remembered.
                always: OPEN_ENDED.has(command) ? [] : [`${device}:${command}`],
                metadata: { action: "run", device, command, args: input.args ?? {} },
              })
            }
            const result = await registry.invoke(device, { command, args: input.args, timeoutMs: input.timeoutMs })
            const { header, body } = formatResult(device, command, result)
            return {
              title: `${device} ${command}`,
              output: `${header}\n${body}`,
              metadata: {
                device,
                command,
                exitCode: result.exitCode,
                isError: result.isError,
                durationMs: result.durationMs,
                truncated: result.truncated,
              },
            }
          }
          case "show": {
            const device = text("device")
            const frameID = registry.show(device, tree())
            return {
              title: `${device} display`,
              output: `drawn on ${device} (${frameID})`,
              metadata: { device, frameID },
            }
          }
          case "send": {
            const device = text("device")
            registry.tell(device, text("text"))
            return { title: `${device} message`, output: `sent to ${device}`, metadata: { device } }
          }
        }
      } catch (error) {
        fail(error)
      }
    },
  })
}
