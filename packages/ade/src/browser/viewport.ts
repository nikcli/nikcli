/**
 * Device presets and viewport scaling for the embedded browser pane.
 *
 * An embedded browser pane lives inside a tiled grid whose dimensions vary as
 * panes are added, closed, or resized. Device emulation requires two things:
 *
 * 1. The iframe must be sized to the unscaled target viewport dimensions so that
 *    media queries and layout breakpoints inside the page fire accurately.
 * 2. The rendered iframe must be scaled down to fit inside the available pane box
 *    without distorting its aspect ratio, but NEVER scaled up beyond 1.0 (scaling
 *    up blurs text and misrepresents how the page looks on the target device).
 */

export type DevicePreset = "responsive" | "desktop" | "tablet" | "mobile"

export interface DeviceSpec {
  id: DevicePreset
  label: string
  width: number
  height: number
}

export const DEVICE_PRESETS: Record<DevicePreset, DeviceSpec> = {
  responsive: { id: "responsive", label: "Responsive", width: 0, height: 0 },
  desktop: { id: "desktop", label: "Desktop", width: 1280, height: 800 },
  tablet: { id: "tablet", label: "Tablet", width: 768, height: 1024 },
  mobile: { id: "mobile", label: "Mobile", width: 375, height: 812 },
}

export interface FitViewportInput {
  preset: DevicePreset
  containerWidth: number
  containerHeight: number
  landscape?: boolean
}

export interface ViewportFit {
  preset: DevicePreset
  /** The unscaled iframe width that media queries evaluate against. */
  viewportWidth: number
  /** The unscaled iframe height that media queries evaluate against. */
  viewportHeight: number
  /** Uniform scale factor to fit inside container. Always clamped to [0, 1]. */
  scale: number
  /** The final rendered width occupied in the pane layout (viewportWidth * scale). */
  renderedWidth: number
  /** The final rendered height occupied in the pane layout (viewportHeight * scale). */
  renderedHeight: number
  isResponsive: boolean
  landscape: boolean
}

/**
 * Calculates the viewport dimensions and uniform scale factor for a given device
 * preset inside an available container box.
 */
export function fitViewport(input: FitViewportInput): ViewportFit {
  const containerW = Math.max(0, input.containerWidth)
  const containerH = Math.max(0, input.containerHeight)
  const isLandscape = Boolean(input.landscape)

  if (input.preset === "responsive") {
    return {
      preset: "responsive",
      viewportWidth: containerW,
      viewportHeight: containerH,
      scale: 1,
      renderedWidth: containerW,
      renderedHeight: containerH,
      isResponsive: true,
      landscape: false,
    }
  }

  const spec = DEVICE_PRESETS[input.preset] ?? DEVICE_PRESETS.desktop
  const baseW = spec.width
  const baseH = spec.height

  // When landscape is true, dimensions are swapped (e.g. tablet 768x1024 -> 1024x768)
  const viewportW = isLandscape ? baseH : baseW
  const viewportH = isLandscape ? baseW : baseH

  if (containerW <= 0 || containerH <= 0 || viewportW <= 0 || viewportH <= 0) {
    return {
      preset: input.preset,
      viewportWidth: viewportW,
      viewportHeight: viewportH,
      scale: 0,
      renderedWidth: 0,
      renderedHeight: 0,
      isResponsive: false,
      landscape: isLandscape,
    }
  }

  const scaleW = containerW / viewportW
  const scaleH = containerH / viewportH

  // Uniform scale to preserve aspect ratio, strictly capped at 1.0.
  // Never scale above 1: blowing a 375px mobile viewport up on a 4K display
  // produces an unnaturally huge phone layout rather than a readable preview.
  const scale = Math.min(1, scaleW, scaleH)
  const renderedWidth = Math.round(viewportW * scale)
  const renderedHeight = Math.round(viewportH * scale)

  return {
    preset: input.preset,
    viewportWidth: viewportW,
    viewportHeight: viewportH,
    scale,
    renderedWidth,
    renderedHeight,
    isResponsive: false,
    landscape: isLandscape,
  }
}
