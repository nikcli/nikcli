import fs from "fs/promises"
import path from "path"
import { Global } from "@nikcli-ai/util/global"
import { Installation } from "@/installation"
import { BackgroundService } from "./service"

/**
 * How the background service is started, persisted between runs.
 *
 * Clients spawn the service, so there is nowhere to pass `--hostname` or a CORS
 * list at the moment it actually starts. This file is that "nowhere": settings
 * live next to the registration and `BackgroundService.start` reads them.
 *
 * Mirrors opencode's `services/service-config.ts`, including the part that is
 * easy to leave out — **every mutation stops the running service**. A setting
 * that only takes effect after the user happens to restart is a setting that
 * looks broken.
 *
 * Per-channel, like the registration: a `local` build's settings must not
 * reconfigure an installed release.
 */
export namespace ServiceConfig {
  export interface Info {
    hostname?: string
    port?: number
    cors?: string[]
    env?: Record<string, string>
  }

  export const KEYS = ["hostname", "port", "cors", "env"] as const
  export type Key = (typeof KEYS)[number]

  export function filename(channel = Installation.CHANNEL): string {
    return BackgroundService.filename(channel).replace(/\.json$/, "-config.json")
  }

  function configPath() {
    return path.join(Global.Path.state, filename())
  }

  export function isKey(value: string): value is Key {
    return (KEYS as ReadonlyArray<string>).includes(value)
  }

  function requireKey(value: string): Key {
    if (!isKey(value)) throw new Error(`Unknown setting "${value}". Known settings: ${KEYS.join(", ")}`)
    return value
  }

  export async function read(): Promise<Info> {
    try {
      const parsed = JSON.parse(await fs.readFile(configPath(), "utf8")) as Info
      return parsed && typeof parsed === "object" ? parsed : {}
    } catch {
      // A corrupt or absent file means "no settings", never a hard failure: the
      // service has to be startable to be fixable.
      return {}
    }
  }

  async function write(info: Info): Promise<void> {
    const file = configPath()
    await fs.mkdir(path.dirname(file), { recursive: true })
    const temp = `${file}.${process.pid}.tmp`
    await fs.writeFile(temp, JSON.stringify(info, null, 2), { mode: 0o600 })
    await fs.rename(temp, file)
  }

  export async function get(key?: string): Promise<Info | Info[Key]> {
    const info = await read()
    if (key === undefined) return info
    return info[requireKey(key)]
  }

  /** `env` is the one setting that takes a nested key: `set env NAME value`. */
  export async function set(key: string, value: string, nested?: string): Promise<void> {
    const selected = requireKey(key)
    if (selected !== "env" && nested !== undefined) {
      throw new Error(`Usage: nikcli service set ${selected} <value>`)
    }

    const info = await read()
    switch (selected) {
      case "hostname":
        info.hostname = value
        break
      case "port": {
        const port = Number(value)
        if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("Port must be between 1 and 65535")
        info.port = port
        break
      }
      case "cors":
        info.cors = value
          .split(",")
          .map((entry) => entry.trim())
          .filter(Boolean)
        break
      case "env": {
        if (nested === undefined) throw new Error("Usage: nikcli service set env <name> <value>")
        // The service's own password outranks these, so setting them would do
        // nothing — a setting that looks broken.
        if (value === "NIKCLI_SERVER_PASSWORD" || value === "NIKCLI_SERVER_USERNAME") {
          throw new Error("The service's credentials are managed by `nikcli service password`")
        }
        info.env = { ...info.env, [value]: nested }
        break
      }
    }

    // Stop first, write second: the running service keeps the old settings, and
    // stopping it is what makes the new ones observable on the next start.
    await BackgroundService.stop()
    await write(info)
  }

  export async function unset(key: string, nested?: string): Promise<void> {
    const selected = requireKey(key)
    const info = await read()
    if (selected === "env" && nested !== undefined) {
      if (info.env) delete info.env[nested]
    } else {
      delete info[selected]
    }
    await BackgroundService.stop()
    await write(info)
  }
}
