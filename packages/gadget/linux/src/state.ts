/**
 * Where a gadget keeps its pairing.
 *
 * One JSON file, mode 0600, under the XDG state directory — or `/var/lib/nikcli-gadget`
 * when `install.sh` set the gadget up as a system service (it exports
 * `NIKCLI_GADGET_STATE`). The token inside is the device's identity on the
 * bridge; losing the file means pairing again, which is the intended recovery.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs"
import { createHash, randomBytes } from "node:crypto"
import { hostname, networkInterfaces, homedir } from "node:os"
import path from "node:path"

export interface PairingState {
  readonly server: string
  readonly id: string
  readonly token: string
  readonly name: string
  readonly confirmed: boolean
  readonly pairedAt: number
}

export function stateDirectory(): string {
  const override = process.env.NIKCLI_GADGET_STATE
  if (override) return override
  const xdg = process.env.XDG_STATE_HOME || path.join(homedir(), ".local", "state")
  return path.join(xdg, "nikcli-gadget")
}

export function stateFile(): string {
  return path.join(stateDirectory(), "pairing.json")
}

export function readPairing(): PairingState | undefined {
  const file = stateFile()
  if (!existsSync(file)) return undefined
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as Partial<PairingState>
    if (typeof raw.server !== "string" || typeof raw.id !== "string" || typeof raw.token !== "string") return undefined
    return {
      server: raw.server,
      id: raw.id,
      token: raw.token,
      name: typeof raw.name === "string" ? raw.name : raw.id,
      confirmed: raw.confirmed !== false,
      pairedAt: typeof raw.pairedAt === "number" ? raw.pairedAt : 0,
    }
  } catch {
    return undefined
  }
}

export function writePairing(state: PairingState): void {
  const dir = stateDirectory()
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const file = stateFile()
  writeFileSync(file, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 })
  chmodSync(file, 0o600)
}

export function clearPairing(): void {
  const file = stateFile()
  if (existsSync(file)) unlinkSync(file)
}

/**
 * This install's identity: a random value written once to the state directory
 * (mode 0600) and kept with the pairing it belongs to.
 *
 * Not the OS machine id. Cloned SD cards share a machine id, and so do two
 * gadgets on one host; the bridge treats an equal fingerprint as "the same
 * device pairing again", so a shared value would make the second pairing revoke
 * the first. A per-install value is distinct for each clone that pairs on its
 * own, stable across reboots and interface changes, and survives `unpair`
 * (which removes only the pairing). If the state directory cannot be written,
 * it falls back to a hash of the machine's own identifiers, so a read-only
 * system still has a stable value.
 *
 * It identifies; it does not authenticate. The bridge binds a token to it so a
 * token copied to another machine is noticed, but anyone who can read the
 * token can also read this file, and on a LAN a MAC-derived value is guessable.
 */
export function fingerprint(): string {
  const file = path.join(stateDirectory(), "identity")
  try {
    const existing = readFileSync(file, "utf8").trim()
    if (/^[0-9a-f]{32}$/.test(existing)) return existing
  } catch {
    // First run, or unreadable: make one below.
  }
  const fresh = randomBytes(16).toString("hex")
  try {
    mkdirSync(stateDirectory(), { recursive: true, mode: 0o700 })
    writeFileSync(file, fresh + "\n", { mode: 0o600 })
    return fresh
  } catch {
    return hostFallback()
  }
}

function hostFallback(): string {
  const id = machineID()
  const parts = id ? ["machine-id", id] : physicalMACs().length ? ["mac", ...physicalMACs()] : ["host", hostname()]
  return createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 32)
}

/** Names of physical network interfaces on Linux and macOS; docker0, veth*, br-*, tun*, wg* and the like do not match. */
const PHYSICAL = /^(en|eth|wl|ww)/

function machineID(): string | undefined {
  for (const file of ["/etc/machine-id", "/var/lib/dbus/machine-id"]) {
    try {
      const id = readFileSync(file, "utf8").trim()
      if (id.length >= 16) return id
    } catch {
      // Not a systemd or dbus host.
    }
  }
  return undefined
}

function physicalMACs(): string[] {
  const macs: string[] = []
  for (const [name, list] of Object.entries(networkInterfaces())) {
    if (!PHYSICAL.test(name)) continue
    for (const iface of list ?? []) {
      if (!iface.internal && iface.mac && iface.mac !== "00:00:00:00:00:00") macs.push(iface.mac)
    }
  }
  return macs.sort()
}
