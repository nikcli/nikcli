#!/usr/bin/env bun
/**
 * `nikcli-gadget` — pair, run, send, health.
 *
 * Runs on Bun or Node ≥ 20 (`node --experimental-strip-types` or a compiled
 * build). Subcommands mirror what Muse's `musegadget` offers, with the one
 * difference that matters: the other end is a nikcli server you run, so
 * `pair` takes the server URL and the code `nikcli` printed, not a cloud token.
 */
import { parseArgs } from "node:util"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { existsSync, writeFileSync } from "node:fs"
import { Gadget } from "./gadget.ts"
import { clearPairing, readPairing, stateFile } from "./state.ts"
import { collect } from "./commands/health.ts"
import { GadgetError } from "./protocol.ts"

const USAGE = `nikcli-gadget — a device that works for a nikcli agent

Usage:
  nikcli-gadget pair --server <url> --code <code> [--name <name>] [gadget.ts]
  nikcli-gadget run [gadget.ts]
  nikcli-gadget send "<text>" [--session-id <id>]
  nikcli-gadget health
  nikcli-gadget status
  nikcli-gadget unpair
  nikcli-gadget init [gadget.ts]

The gadget file default-exports a Gadget (see \`nikcli-gadget init\`). Without one, the
four built-in commands (system.run, file.read, file.write, device.health) are served.

State: ${stateFile()}
`

async function loadGadget(file: string | undefined, name?: string): Promise<Gadget> {
  const candidates = file ? [file] : ["gadget.ts", "gadget.js", "gadget.mjs"]
  for (const candidate of candidates) {
    const resolved = path.resolve(candidate)
    if (!existsSync(resolved)) {
      if (file) throw new Error(`${resolved} does not exist`)
      continue
    }
    const module = (await import(pathToFileURL(resolved).href)) as { default?: unknown }
    const value = module.default
    if (value instanceof Gadget) return value
    if (typeof value === "object" && value !== null) return new Gadget(value as ConstructorParameters<typeof Gadget>[0])
    throw new Error(`${resolved} must default-export a Gadget or its options`)
  }
  return new Gadget(name ? { name } : {})
}

const TEMPLATE = `import { Gadget, display, button } from "@nikcli-ai/gadget"

export default new Gadget({
  name: "my-gadget",
  // The four built-ins (system.run, file.read, file.write, device.health) stay on.
  commands: {
    "led.set": {
      description: "Turn the status LED on or off",
      args: { type: "object", properties: { on: { type: "boolean" } }, required: ["on"] },
      async run({ on }) {
        // Drive your hardware here.
        return \`led \${on ? "on" : "off"}\`
      },
    },
  },
  display: display.terminal({ columns: 40, rows: 10 }),
  buttons: button.keyboard({ keys: { ok: "enter", next: "n" } }),
})
`

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv
  if (!command || command === "--help" || command === "-h" || command === "help") {
    process.stdout.write(USAGE)
    return 0
  }
  switch (command) {
    case "pair": {
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: { server: { type: "string" }, code: { type: "string" }, name: { type: "string" } },
      })
      if (!values.server || !values.code) {
        process.stderr.write("pair needs --server <url> and --code <code>\n")
        return 2
      }
      const gadget = await loadGadget(positionals[0], values.name)
      const state = await gadget.pair(values.server, values.code)
      process.stdout.write(`paired as ${state.id} with ${state.server}\n`)
      return 0
    }
    case "run": {
      const { positionals } = parseArgs({ args: rest, allowPositionals: true, options: {} })
      const gadget = await loadGadget(positionals[0])
      const controller = new AbortController()
      const stop = () => controller.abort()
      process.once("SIGINT", stop)
      process.once("SIGTERM", stop)
      await gadget.run({ signal: controller.signal })
      return 0
    }
    case "send": {
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: { "session-id": { type: "string" } },
      })
      const text = positionals.join(" ").trim()
      if (!text) {
        process.stderr.write("send needs the text to send\n")
        return 2
      }
      const gadget = new Gadget({ builtins: false })
      const result = await gadget.send(text, values["session-id"])
      process.stdout.write(`${result.sessionID}\n`)
      return 0
    }
    case "health": {
      process.stdout.write(JSON.stringify(await collect(), null, 2) + "\n")
      return 0
    }
    case "status": {
      const pairing = readPairing()
      if (!pairing) {
        process.stdout.write("not paired\n")
        return 1
      }
      process.stdout.write(
        `${pairing.id} → ${pairing.server} (${pairing.confirmed ? "confirmed" : "waiting for button"}), paired ${new Date(pairing.pairedAt).toISOString()}\n`,
      )
      return 0
    }
    case "unpair": {
      clearPairing()
      process.stdout.write("pairing removed; the bridge still lists the device until you revoke it there\n")
      return 0
    }
    case "init": {
      const { positionals } = parseArgs({ args: rest, allowPositionals: true, options: {} })
      const target = path.resolve(positionals[0] ?? "gadget.ts")
      if (existsSync(target)) {
        process.stderr.write(`${target} already exists\n`)
        return 1
      }
      writeFileSync(target, TEMPLATE)
      process.stdout.write(`wrote ${target}\n`)
      return 0
    }
    default:
      process.stderr.write(`unknown command ${command}\n\n${USAGE}`)
      return 2
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error) => {
    const message =
      error instanceof GadgetError
        ? `${error.name}: ${error.message}`
        : error instanceof Error
          ? error.message
          : String(error)
    process.stderr.write(`${message}\n`)
    process.exit(1)
  },
)
