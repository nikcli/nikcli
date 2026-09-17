import { t } from "@nikcli-ai/ade/i18n"
/**
 * Which microphones and speakers this machine has, and what they are called.
 *
 * Two facts shape everything here, and both are browser rules rather than
 * choices:
 *
 *   - **Labels need permission.** Before the user has granted microphone
 *     access, `enumerateDevices` still returns the devices but every `label` is
 *     an empty string — the list exists and is unreadable. So a picker opened
 *     on a cold profile shows "Microfono 1", "Microfono 2", which is useless,
 *     and the honest thing is to say that permission is what is missing rather
 *     than to draw a list of numbers.
 *   - **Ids are opaque and origin-scoped.** A `deviceId` is a hash, not a name.
 *     It is meaningless on another machine, it changes when the user revokes
 *     and re-grants permission, and it names a device that may be unplugged.
 *     Everything downstream treats a stored id as a hint — see the `ideal`
 *     constraint in `capture.ts`.
 *
 * Pure functions take the raw list and shape it; the one impure function asks
 * the browser. Split that way because the shaping is where the decisions are —
 * what counts as the default entry, what a device with no label is called, how
 * duplicates are folded — and those are worth testing without a browser.
 */

/** What the picker needs to draw one row. */
export interface AudioDevice {
  /** The opaque `MediaDeviceInfo.deviceId`. Empty string means "system default". */
  readonly id: string
  /** What to show. Never empty: a fallback is generated when the label is. */
  readonly label: string
  /** Whether the browser gave a real name, or this label was invented. */
  readonly named: boolean
}

export interface AudioDevices {
  readonly inputs: readonly AudioDevice[]
  readonly outputs: readonly AudioDevice[]
  /**
   * Whether the browser is willing to name them.
   *
   * False means the list is real but anonymous, which is what you get before
   * microphone permission has ever been granted. The panel says so instead of
   * showing numbered rows nobody can choose between.
   */
  readonly labelled: boolean
}

/** The row that means "whatever the system is set to". */
export const SYSTEM_DEFAULT: AudioDevice = Object.freeze({
  id: "",
  get label() {
    return t("vui.device.system")
  },
  named: true,
})

/**
 * Shapes a raw `enumerateDevices()` answer into two lists.
 *
 * The system-default row is always first and always present, because it is the
 * only choice that keeps working when the hardware changes — and because a
 * picker with no way back to the default traps whoever tries a headset once.
 *
 * Chromium also reports its own synthetic `default` and `communications`
 * entries, which are aliases for whatever the OS has selected rather than
 * devices. They are dropped: keeping them puts three rows in the list that all
 * mean the same microphone, and a user who picks the alias gets a pinned id
 * that silently follows the system anyway.
 */
export function shapeDevices(raw: readonly MediaDeviceInfo[]): AudioDevices {
  const inputs: AudioDevice[] = [SYSTEM_DEFAULT]
  const outputs: AudioDevice[] = [SYSTEM_DEFAULT]
  let labelled = false
  let inputCount = 0
  let outputCount = 0

  for (const device of raw) {
    if (device.kind !== "audioinput" && device.kind !== "audiooutput") continue
    if (device.deviceId === "default" || device.deviceId === "communications") continue
    if (device.deviceId.length === 0) continue

    const isInput = device.kind === "audioinput"
    const position = isInput ? ++inputCount : ++outputCount
    const label = device.label?.trim() ?? ""
    if (label.length > 0) labelled = true

    const entry: AudioDevice = {
      id: device.deviceId,
      label: label.length > 0 ? label : t(isInput ? "vui.device.mic" : "vui.device.output", position),
      named: label.length > 0,
    }
    if (isInput) inputs.push(entry)
    else outputs.push(entry)
  }

  return { inputs, outputs, labelled }
}

/**
 * The label to show for a stored id, even when that device is gone.
 *
 * A picker that silently falls back to "Dispositivo di sistema" when the
 * chosen headset is unplugged is a picker that appears to have forgotten the
 * choice — and the choice *is* still stored, and will apply again when the
 * headset comes back. Saying so is the difference between a setting that looks
 * broken and one that looks patient.
 */
export function describeChoice(id: string | undefined, devices: readonly AudioDevice[]): string {
  if (!id) return SYSTEM_DEFAULT.label
  const found = devices.find((device) => device.id === id)
  if (found) return found.label
  return t("vui.device.missing")
}

export interface EnumerateOptions {
  /** Test seam. Defaults to `navigator.mediaDevices.enumerateDevices`. */
  readonly enumerate?: () => Promise<MediaDeviceInfo[]>
}

/**
 * Asks the browser what it has, or says it cannot.
 *
 * Never throws: a settings panel that fails to open because device enumeration
 * was refused is worse than one that opens with the default row and an
 * explanation. An empty answer and `labelled: false` is a working state, not
 * an error.
 */
export async function listAudioDevices(options: EnumerateOptions = {}): Promise<AudioDevices> {
  const enumerate =
    options.enumerate ??
    (typeof navigator !== "undefined" && navigator.mediaDevices?.enumerateDevices
      ? navigator.mediaDevices.enumerateDevices.bind(navigator.mediaDevices)
      : undefined)

  if (!enumerate) return { inputs: [SYSTEM_DEFAULT], outputs: [SYSTEM_DEFAULT], labelled: false }

  try {
    return shapeDevices(await enumerate())
  } catch {
    return { inputs: [SYSTEM_DEFAULT], outputs: [SYSTEM_DEFAULT], labelled: false }
  }
}

/**
 * Runs `listen` whenever the machine's audio hardware changes.
 *
 * Devices are hot-pluggable and the list goes stale the moment someone plugs
 * in a headset — a panel that enumerated once at mount shows the old hardware
 * until it is closed and reopened. Returns the unsubscribe, or a no-op where
 * the event does not exist.
 */
export function onDeviceChange(listen: () => void): () => void {
  const media = typeof navigator !== "undefined" ? navigator.mediaDevices : undefined
  if (!media || typeof media.addEventListener !== "function") return () => {}
  media.addEventListener("devicechange", listen)
  return () => media.removeEventListener("devicechange", listen)
}
