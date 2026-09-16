import { networkInterfaces } from "os"

/**
 * Pairing a phone with a nikcli server: where the server is reachable, and the link that carries
 * that address plus a token to the app.
 *
 * Pure string and interface work, extracted from the `mobile` CLI command. The TUI's pairing
 * dialog wanted exactly these three helpers and was importing the command module for them, which
 * pulled in `Server` and `MobileAuth` — the whole server — to build a URL.
 */
export function normalizePublicUrl(input?: string) {
  if (!input) return
  const url = new URL(input)
  return url.toString().replace(/\/$/, "")
}

/**
 * An address the phone can never reach, reported exactly like a real one.
 *
 * Windows gives a 169.254.x.x APIPA address to every adapter without a DHCP lease — an unplugged
 * Ethernet port, the Hyper-V/WSL switch, a VPN that is down — and `networkInterfaces()` lists it
 * alongside the Wi-Fi address with nothing to tell them apart. When one came first it won the
 * pairing QR, and the app failed with `ConnectException: Failed to connect to /169.254.x.x`.
 */
function isLinkLocal(address: string) {
  return address.startsWith("169.254.")
}

function isPrivateLAN(address: string) {
  if (address.startsWith("10.") || address.startsWith("192.168.")) return true
  const second = Number(address.split(".")[1])
  return address.startsWith("172.") && second >= 16 && second <= 31
}

/**
 * Adapters that hold a routable address which is almost never the one the phone sits on: VM
 * switches and container bridges. They stay in the list — `tab` in the pairing dialog cycles
 * through it — but they never go first.
 */
const VIRTUAL_INTERFACE = /^(vEthernet|Hyper-V|VirtualBox|VMware|docker|veth|virbr|br-|utun|tun\d|tap\d)/i

/**
 * Tailscale gives every node an address in 100.64.0.0/10, on every platform. The interface name
 * does not travel — macOS calls it `utun3`, Windows `Tailscale`, Linux `tailscale0` — so the name
 * is only a fallback for the overlays that have no address range of their own.
 */
function isTailscale(address: string) {
  const octets = address.split(".").map(Number)
  return octets[0] === 100 && octets[1]! >= 64 && octets[1]! <= 127
}

const OVERLAY_INTERFACE = /^(Tailscale|tailscale|ZeroTier|zt)/i

/**
 * Pairing candidates, best first.
 *
 * An overlay VPN sits between a real LAN address and everything else, rather than last with the VM
 * switches it used to share a rank with. The distinction is whether the phone can be on the other
 * end: a tailnet address reaches a phone running Tailscale from any network, including one where
 * the LAN itself is blocked by AP isolation, while a Hyper-V switch reaches nothing. It stays
 * *behind* the LAN because same-network pairing needs no tailnet on the phone and is faster — `tab`
 * makes it one keypress away, with its own QR.
 */
export function rankLocalAddress(input: { name: string; address: string }): number {
  if (isTailscale(input.address) || OVERLAY_INTERFACE.test(input.name)) return 1
  if (VIRTUAL_INTERFACE.test(input.name)) return 3
  return isPrivateLAN(input.address) ? 0 : 2
}

export type LocalInterfaceAddress = {
  name: string
  address: string
  family: string
  internal: boolean
}

/**
 * The pairing candidates hidden in a `networkInterfaces()` snapshot, best first.
 *
 * Split out from `getLocalIPs` so the rules above can be checked against a fixed interface list:
 * read straight from the OS they are only ever exercised with whatever adapters the machine
 * running the test happens to have, which is never the broken Windows shape they exist for.
 */
export function selectPairingAddresses(entries: readonly LocalInterfaceAddress[]): string[] {
  return entries
    .filter((entry) => entry.family === "IPv4" && !entry.internal && !isLinkLocal(entry.address))
    .sort((a, b) => rankLocalAddress(a) - rankLocalAddress(b))
    .map((entry) => entry.address)
}

export function getLocalIPs(): string[] {
  const entries: LocalInterfaceAddress[] = []
  for (const [name, iface] of Object.entries(networkInterfaces())) {
    if (!iface) continue
    for (const addr of iface) {
      entries.push({ name, address: addr.address, family: addr.family, internal: addr.internal })
    }
  }
  return selectPairingAddresses(entries)
}

export function isLoopbackHostname(hostname: string) {
  return hostname === "127.0.0.1" || hostname === "::1" || hostname === "localhost"
}

export function resolveServerUrl(input: { publicUrl?: string; hostname: string; port: number }) {
  if (input.publicUrl) {
    const value = normalizePublicUrl(input.publicUrl)
    if (!value) throw new Error("Invalid public URL")
    return value
  }
  const isAllInterfaces = input.hostname === "0.0.0.0" || input.hostname === "::"
  const host = isAllInterfaces ? (getLocalIPs()[0] ?? input.hostname) : input.hostname
  return `http://${host}:${input.port}`
}

export function buildMobilePairingDeepLink(info: { serverUrl: string; token: string; directory?: string }) {
  const deepLink = new URL("nikcli://connect")
  deepLink.searchParams.set("server", info.serverUrl)
  deepLink.searchParams.set("token", info.token)
  if (info.directory) deepLink.searchParams.set("directory", info.directory)
  return deepLink.toString()
}
