/**
 * The sidebar block: paired gadgets and whether each is online.
 *
 * It reads the bridge's `/admin/devices` every few seconds and draws nothing
 * until a gadget is paired, so a user who never pairs one never sees it. Colours
 * are fixed: an external plugin has no handle on the host's theme, so the text
 * that matters inherits the terminal's default and only the status dot and the
 * secondary words are coloured.
 */
import { createSignal, For, onCleanup, Show } from "solid-js"
import { ROUTES, type GadgetInfo } from "@nikcli-ai/gadget/protocol"

const GREEN = "#4caf50"
const AMBER = "#e0a030"
const MUTED = "#8a8a8a"

export async function fetchDevices(base: string, fetcher: typeof globalThis.fetch = fetch): Promise<GadgetInfo[]> {
  const response = await fetcher(base + ROUTES.admin.devices, { signal: AbortSignal.timeout(4_000) })
  if (!response.ok) throw new Error(`bridge answered ${response.status}`)
  return (await response.json()) as GadgetInfo[]
}

export function stateOf(device: GadgetInfo): string {
  if (!device.confirmed) return "press button"
  return device.online ? "online" : "offline"
}

export function Gadgets(props: { url: string; intervalMs?: number; fetcher?: typeof globalThis.fetch }) {
  const [devices, setDevices] = createSignal<GadgetInfo[]>([])

  let alive = true
  const refresh = () => {
    fetchDevices(props.url, props.fetcher)
      .then((list) => alive && setDevices(list))
      // The bridge may not be up yet, or the plugin is not enabled on the server: show nothing rather than an error in the sidebar.
      .catch(() => alive && setDevices([]))
  }
  refresh()
  const timer = setInterval(refresh, props.intervalMs ?? 5_000)
  onCleanup(() => {
    alive = false
    clearInterval(timer)
  })

  const online = () => devices().filter((device) => device.online).length

  return (
    <Show when={devices().length > 0}>
      <box>
        <text>
          <b>Gadgets</b>
          <span style={{ fg: MUTED }}>{` (${online()} online)`}</span>
        </text>
        <For each={devices()}>
          {(device) => (
            <box flexDirection="row" gap={1}>
              <text flexShrink={0} fg={device.online ? GREEN : device.confirmed ? MUTED : AMBER}>
                •
              </text>
              <text wrapMode="word">
                {device.id} <span style={{ fg: MUTED }}>{stateOf(device)}</span>
              </text>
            </box>
          )}
        </For>
      </box>
    </Show>
  )
}
