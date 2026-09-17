/**
 * The two things the browser pane asks of the desktop host.
 *
 * Both resolve to nothing outside the desktop app (the browser harness,
 * tests): the pane then behaves as it did before they existed.
 */

export interface FramingHeaders {
  xFrameOptions?: string | null
  csp?: string | null
}

/** The probe's answer in the shape `framingBlocked` reads. */
export function readHeaders(headers: FramingHeaders | undefined): (name: string) => string | null {
  return (name) => {
    if (!headers) return null
    if (name === "x-frame-options") return headers.xFrameOptions ?? null
    if (name === "content-security-policy") return headers.csp ?? null
    return null
  }
}

const isDesktop = () =>
  typeof window !== "undefined" && ("__TAURI_INTERNALS__" in window || "__TAURI__" in window)

/** The page's framing headers as the host reads them, outside CORS; undefined when unknown. */
export async function probeFraming(url: string): Promise<FramingHeaders | undefined> {
  if (!isDesktop()) return undefined
  try {
    const { invoke } = await import("@tauri-apps/api/core")
    return await invoke<FramingHeaders>("ade_browser_framing", { url })
  } catch {
    return undefined
  }
}

export function canOpenExternally(): boolean {
  return isDesktop()
}

/** Opens the page in the system browser; the error text when that failed. */
export async function openExternally(url: string): Promise<string | undefined> {
  try {
    const { invoke } = await import("@tauri-apps/api/core")
    await invoke("ade_open_in_browser", { url })
    return undefined
  } catch (error) {
    return String(error)
  }
}
