/**
 * Finding the ssh hosts this machine already knows.
 *
 * Read, never written: `~/.ssh/config` (and what it includes, one level of
 * wildcards deep) and `~/.ssh/known_hosts`. Nothing is connected to here; a
 * host appears because the user has configured it or reached it before.
 */
import type { Host } from "../host/shell"
import { mergeHosts, parseKnownHosts, parseSshConfig, type SshHost } from "./ssh"

export interface SshDiscovery {
  /** Where the OpenSSH client is, or undefined when there is none on PATH. */
  client?: string
  hosts: SshHost[]
}

const MAX_INCLUDES = 16

function join(dir: string, name: string): string {
  const sep = dir.includes("\\") ? "\\" : "/"
  return `${dir.replace(/[\\/]+$/, "")}${sep}${name}`
}

/** An `Include` path as ssh resolves it: `~` is home, relative is under `~/.ssh`. */
export function resolveInclude(pattern: string, home: string): string {
  if (pattern.startsWith("~/") || pattern.startsWith("~\\")) return join(home, pattern.slice(2))
  if (/^([A-Za-z]:)?[\\/]/.test(pattern)) return pattern
  return join(join(home, ".ssh"), pattern)
}

/** A glob segment (`*`, `?`) as a whole-name test. */
export function globMatcher(segment: string): (name: string) => boolean {
  const source = segment.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")
  const re = new RegExp(`^${source}$`, "i")
  return (name) => re.test(name)
}

export async function discoverSshHosts(host: Host): Promise<SshDiscovery> {
  const client = (await host.probe("ssh", "").catch(() => null)) ?? undefined
  if (!host.homeDir || !host.readTextFile) return { client, hosts: [] }
  const home = await host.homeDir().catch(() => "")
  if (!home) return { client, hosts: [] }
  const read = host.readTextFile

  const readText = async (path: string) => (await read(path, 512_000).catch(() => undefined))?.text

  const configHosts: SshHost[] = []
  const visited = new Set<string>()
  const queue = [join(join(home, ".ssh"), "config")]
  while (queue.length > 0 && visited.size < MAX_INCLUDES) {
    const path = queue.shift()!
    if (visited.has(path.toLowerCase())) continue
    visited.add(path.toLowerCase())
    const text = await readText(path)
    if (text === undefined) continue
    const parsed = parseSshConfig(text)
    configHosts.push(...parsed.hosts)
    for (const pattern of parsed.includes) {
      const resolved = resolveInclude(pattern, home)
      const cut = Math.max(resolved.lastIndexOf("/"), resolved.lastIndexOf("\\"))
      const name = resolved.slice(cut + 1)
      if (!/[*?]/.test(name)) {
        queue.push(resolved)
        continue
      }
      const dir = resolved.slice(0, cut)
      if (/[*?]/.test(dir) || !host.readDir) continue
      const matches = globMatcher(name)
      const entries = await host.readDir(dir).catch(() => [])
      for (const entry of entries) {
        if (!entry.is_dir && matches(entry.name)) queue.push(entry.path)
      }
    }
  }

  const known = parseKnownHosts((await readText(join(join(home, ".ssh"), "known_hosts"))) ?? "")
  return { client, hosts: mergeHosts(configHosts, known) }
}
