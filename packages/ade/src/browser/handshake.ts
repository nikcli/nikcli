/**
 * Fidelity state machine and handshake reducer for the browser pane.
 *
 * An inspected page can run in three fidelity tiers:
 *
 * 1. "native": The page loaded on its own origin and announced the bridge within
 *    the handshake window. Relative assets and client-side routing work identically
 *    to a standalone browser tab.
 * 2. "mirror": The page did not announce the bridge before timeout, so the pane
 *    fetched the HTML and injected the bridge into an `about:srcdoc` iframe.
 * 3. "none": Neither native nor mirror inspection is available (e.g. cross-origin
 *    server with no CORS headers, or server unreachable). The frame is either
 *    browse-only without element inspection or in an error state.
 *
 * Modeling this as a pure reducer over discrete events allows testing the full
 * lifecycle and edge cases without mounting a DOM or running asynchronous timers.
 */

export type Fidelity = "pending" | "native" | "mirror" | "none"

/**
 * How long (in ms) to wait for a page to announce the bridge before falling back
 * to a mirrored copy. 1500ms provides enough time for a cold dev server to compile
 * and execute the bridge script without delaying fallback too long.
 */
export const HANDSHAKE_TIMEOUT_MS = 1500

export type HandshakeEvent =
  | { type: "navigate"; url?: string }
  | { type: "ready"; mode?: "native" | "mirror" }
  | { type: "timeout" }
  | { type: "no-bridge" }
  | { type: "load-error"; error?: string }

export interface HandshakeState {
  fidelity: Fidelity
  error?: string
}

export const INITIAL_HANDSHAKE_STATE: HandshakeState = {
  fidelity: "pending",
}

/**
 * Pure state reducer managing the fidelity handshake lifecycle.
 */
export function handshakeReducer(
  state: HandshakeState,
  event: HandshakeEvent,
): HandshakeState {
  switch (event.type) {
    case "navigate": {
      // Navigating to a new target always restarts the handshake from scratch.
      return {
        fidelity: "pending",
        error: undefined,
      }
    }

    case "ready": {
      // If the bridge announces itself, promote to native (or mirror if explicitly flagged).
      const nextFidelity: Fidelity = event.mode ?? (state.fidelity === "mirror" ? "mirror" : "native")
      return {
        fidelity: nextFidelity,
        error: undefined,
      }
    }

    case "timeout": {
      // A timeout only demotes a pending state to mirror fallback.
      // Once already native or resolved, a late timer trigger is a no-op.
      if (state.fidelity === "pending") {
        return {
          fidelity: "mirror",
          error: undefined,
        }
      }
      return state
    }

    case "no-bridge": {
      // The real page is on screen and stays there, without inspection.
      // Like a timeout, it only settles a pending state.
      if (state.fidelity === "pending") {
        return {
          fidelity: "none",
          error: undefined,
        }
      }
      return state
    }

    case "load-error": {
      // When fetching or loading fails completely, inspection is unavailable.
      return {
        fidelity: "none",
        error: event.error,
      }
    }

    default:
      return state
  }
}

/**
 * Convenience helper reducing just the fidelity enum value.
 */
export function reduceFidelity(fidelity: Fidelity, event: HandshakeEvent): Fidelity {
  return handshakeReducer({ fidelity }, event).fidelity
}

/**
 * Whether the page's own headers forbid showing it inside ADE's frame.
 *
 * `X-Frame-Options` of any value and a `frame-ancestors` directive without
 * `*` both exclude ADE: the frame's parent is never the page's own origin.
 * These headers are readable only when the server exposes them to CORS, so
 * `false` means "not known to be blocked", not "known to be allowed".
 */
export function framingBlocked(header: (name: string) => string | null): boolean {
  const frameOptions = header("x-frame-options")?.trim().toLowerCase()
  if (frameOptions === "deny" || frameOptions === "sameorigin") return true

  const policy = header("content-security-policy")
  if (!policy) return false
  for (const directive of policy.split(";")) {
    const [name, ...sources] = directive.trim().toLowerCase().split(/\s+/)
    if (name === "frame-ancestors") return !sources.includes("*")
  }
  return false
}

export type BridgelessChoice = "keep-page" | "mirror"

/**
 * What to show once the handshake window closes with no bridge.
 *
 * The real page used to be swapped for the mirror every time. On a page
 * served from anywhere but ADE the mirror inherits ADE's content policy,
 * which blocks the page's own stylesheets and scripts, so a working page was
 * replaced by bare HTML 1.5 s after every load — and pressing Reload, the
 * only way to see the page again, started the same swap over.
 *
 * The mirror is now for two cases only: the page cannot be shown in the
 * frame, or the user asked to inspect it. Browsing keeps the real page.
 */
export function bridgelessChoice(input: { blocked: boolean; inspecting: boolean }): BridgelessChoice {
  return input.blocked || input.inspecting ? "mirror" : "keep-page"
}

/**
 * What the pane says over the frame when it has no copy of the page to fall back on.
 *
 * - `blocked`: the site refuses to be framed and cannot be copied either, so
 *   the frame is empty; the way to see it is the system browser.
 * - `no-copy`: the page is on screen, but Inspect needs a copy and the site
 *   does not allow one (no CORS).
 */
export type PaneNotice = "blocked" | "no-copy"

export function noticeWithoutCopy(input: { blocked: boolean; inspecting: boolean }): PaneNotice | undefined {
  if (input.blocked) return "blocked"
  return input.inspecting ? "no-copy" : undefined
}
