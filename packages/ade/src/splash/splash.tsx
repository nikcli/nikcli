import { Show, createEffect, createSignal, onCleanup, onMount } from "solid-js"
// Types only. The library itself is loaded inside `startScene`, so a launch
// that never shows the splash never parses three.js either.
import type * as THREE from "three"
import "./splash.css"

export interface SplashProps {
  /** Hidden when this goes false. The fade is handled here. */
  visible: boolean
  /** What it says it is doing, under the scene. */
  status?: string
  /** Optional callback to dismiss or skip the splash early. */
  onDismiss?: () => void
}

const FADE_MS = 600
const NUM_PARTICLES = 2000
const ASCII_CHARS = [" ", ".", ":", "-", "=", "+", "*", "%", "#", "@", "N", "i", "K"]

/**
 * Concept 04: Fullscreen 3D ASCII Typography (NiK).
 *
 * Perfectly centered typography in 3D and 2D.
 * All mouse interaction with the text is disabled: the typography stays steady,
 * exhibiting only its natural organic breathing.
 *
 * The workbench keeps this component mounted for the whole session and only
 * flips `visible`. So nothing expensive may live at this level: the scene
 * belongs to `SplashView`, which exists exactly as long as the `<Show>` does.
 * When the fade ends the view unmounts, and its cleanup stops the loop, drops
 * the listeners and hands the WebGL context back. If `visible` comes back,
 * a fresh view starts a fresh scene.
 */
export function Splash(props: SplashProps) {
  const [gone, setGone] = createSignal(false)

  // Fade out smoothly when props.visible flips to false
  createEffect(() => {
    if (!props.visible) {
      const t = setTimeout(() => setGone(true), FADE_MS)
      onCleanup(() => clearTimeout(t))
    } else {
      setGone(false)
    }
  })

  return (
    <Show when={!gone()}>
      <SplashView visible={props.visible} onDismiss={props.onDismiss} />
    </Show>
  )
}

function SplashView(props: { visible: boolean; onDismiss?: () => void }) {
  let canvasContainerRef: HTMLDivElement | undefined
  let asciiLayerRef: HTMLPreElement | undefined

  // Only while it is actually on screen: during the fade-out the splash is
  // still mounted, and Enter or Space there belongs to the workbench.
  const dismiss = () => {
    if (props.visible) props.onDismiss?.()
  }

  onMount(() => {
    const container = canvasContainerRef
    const asciiLayer = asciiLayerRef
    if (!container || !asciiLayer) return

    // Set by the async start once there is something to tear down. Cleanup can
    // run before `import("three")` resolves (a boot faster than the fade), so
    // `disposed` tells the start path to give up instead of building a scene
    // nobody will ever stop.
    let teardown: (() => void) | undefined
    let disposed = false
    onCleanup(() => {
      disposed = true
      teardown?.()
    })

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" || e.key === "Enter" || e.key === " " || e.key === "Spacebar") {
        dismiss()
      }
    }
    window.addEventListener("keydown", handleKeyDown)
    onCleanup(() => window.removeEventListener("keydown", handleKeyDown))

    if (!hasWebGL()) {
      // Graceful fallback for non-WebGL test environments
      asciiLayer.textContent = "   N   i   K   \n [ADE READY]"
      return
    }

    void startScene(container, asciiLayer).then((stop) => {
      if (disposed) stop?.()
      else teardown = stop
    })
  })

  return (
    <div
      data-component="ade-splash"
      data-slot="ade-splash-root"
      data-leaving={!props.visible ? "" : undefined}
      onClick={dismiss}
      role="dialog"
      aria-label="ADE Onboarding — 3D ASCII Typography"
      aria-modal="true"
    >
      {/* Three.js Canvas Container (Offscreen WebGL source) */}
      <div ref={canvasContainerRef} data-slot="splash-canvas-container" aria-hidden="true" />

      {/* Real-time Centered 3D ASCII Typography */}
      <pre ref={asciiLayerRef} data-slot="ascii-layer" aria-hidden="true" />

      {/* CRT Scanlines & Vignette */}
      <div data-slot="splash-crt" aria-hidden="true" />
    </div>
  )
}

/**
 * Check if WebGL is supported (avoids crashes in headless HappyDOM test runners).
 * The probe context is released on the spot: a context that is only waiting
 * for garbage collection still counts against the GPU process.
 */
function hasWebGL(): boolean {
  try {
    if (!window.WebGLRenderingContext) return false
    const testCanvas = document.createElement("canvas")
    const gl = (testCanvas.getContext("webgl") ||
      testCanvas.getContext("experimental-webgl")) as WebGLRenderingContext | null
    if (!gl) return false
    gl.getExtension("WEBGL_lose_context")?.loseContext()
    return true
  } catch {
    return false
  }
}

/** Builds the scene and runs it. Resolves to the function that undoes all of it. */
async function startScene(container: HTMLDivElement, asciiLayer: HTMLPreElement): Promise<(() => void) | undefined> {
  let three: typeof THREE
  try {
    three = await import("three")
  } catch {
    return undefined
  }

  // ── Three.js Scene Setup ────────────────────────────────────────────────
  const scene = new three.Scene()
  scene.background = new three.Color(0x07090e)

  const width = window.innerWidth || 800
  const height = window.innerHeight || 600

  const camera = new three.PerspectiveCamera(45, width / height, 0.1, 100)
  camera.position.set(0, 0, 15)

  let renderer: THREE.WebGLRenderer
  try {
    renderer = new three.WebGLRenderer({
      antialias: true,
      preserveDrawingBuffer: true,
      powerPreference: "high-performance",
    })
  } catch {
    return undefined
  }

  renderer.setSize(width, height)
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
  container.appendChild(renderer.domElement)

  // ── Swarm Target Positions: Perfectly Symmetrical Typography "NiK" ──────
  const swarmTargets: THREE.Vector3[] = []
  const swarmPositions: THREE.Vector3[] = []

  function sampleLine(x1: number, y1: number, z1: number, x2: number, y2: number, z2: number, count: number) {
    for (let i = 0; i < count; i++) {
      const t = i / count
      swarmTargets.push(
        new three.Vector3(
          x1 + (x2 - x1) * t + (Math.random() - 0.5) * 0.25,
          y1 + (y2 - y1) * t + (Math.random() - 0.5) * 0.25,
          z1 + (z2 - z1) * t + (Math.random() - 0.5) * 0.4,
        ),
      )
    }
  }

  // Letter N strokes (880 points) - centered around x = -2.9
  sampleLine(-4.2, -3.5, 0, -4.2, 3.5, 0, 280)
  sampleLine(-4.2, 3.5, 0, -1.6, -3.5, 0, 340)
  sampleLine(-1.6, -3.5, 0, -1.6, 3.5, 0, 260)

  // Letter I strokes (360 points) - centered at x = 0.0
  sampleLine(0.0, -2.5, 0, 0.0, 2.0, 0, 260)
  sampleLine(0.0, 3.0, 0, 0.0, 3.5, 0, 100)

  // Letter K strokes (760 points) - centered around x = +2.9
  sampleLine(1.6, -3.5, 0, 1.6, 3.5, 0, 280)
  sampleLine(1.6, 0.2, 0, 4.2, 3.5, 0, 240)
  sampleLine(1.6, 0.2, 0, 4.2, -3.5, 0, 240)

  // Points Buffer Geometry
  const pGeo = new three.BufferGeometry()
  const posArray = new Float32Array(NUM_PARTICLES * 3)
  for (let i = 0; i < NUM_PARTICLES; i++) {
    const tgt = swarmTargets[i] || new three.Vector3(0, 0, 0)
    posArray[i * 3] = tgt.x + (Math.random() - 0.5) * 0.4
    posArray[i * 3 + 1] = tgt.y + (Math.random() - 0.5) * 0.4
    posArray[i * 3 + 2] = tgt.z + (Math.random() - 0.5) * 0.4
    swarmPositions.push(new three.Vector3(posArray[i * 3], posArray[i * 3 + 1], posArray[i * 3 + 2]))
  }
  pGeo.setAttribute("position", new three.BufferAttribute(posArray, 3))

  const pMat = new three.PointsMaterial({
    size: 0.28,
    color: 0x58a6ff,
    transparent: true,
    opacity: 1.0,
    blending: three.AdditiveBlending,
  })
  const particleSystem = new three.Points(pGeo, pMat)

  // Root Group: Locked at (0, 0, 0) - Dead center, zero rotation
  const activeGroup = new three.Group()
  activeGroup.add(particleSystem)
  activeGroup.position.set(0, 0, 0)
  activeGroup.rotation.set(0, 0, 0)
  scene.add(activeGroup)

  // ── Measure Monospace Font Dimensions for Exact Cell Alignment ─────────
  const measureSpan = document.createElement("span")
  measureSpan.style.fontFamily = "var(--ade-mono, 'Fira Code', 'JetBrains Mono', Consolas, monospace)"
  measureSpan.style.fontSize = "10px"
  measureSpan.style.letterSpacing = "1px"
  measureSpan.style.lineHeight = "10px"
  measureSpan.style.visibility = "hidden"
  measureSpan.style.position = "absolute"
  measureSpan.textContent = "M"
  document.body.appendChild(measureSpan)
  const measuredRect = measureSpan.getBoundingClientRect()
  const charW = measuredRect.width || 7
  const charH = measuredRect.height || 10
  document.body.removeChild(measureSpan)

  // ── ASCII Post-Processing Filter ────────────────────────────────────────
  const offscreenCanvas = document.createElement("canvas")
  const offscreenCtx = offscreenCanvas.getContext("2d", { willReadFrequently: true })

  const updateAsciiRender = () => {
    if (!offscreenCtx) return

    const w = window.innerWidth
    const h = window.innerHeight

    const cols = Math.max(20, Math.floor(w / charW))
    const rows = Math.max(10, Math.floor(h / charH))

    offscreenCanvas.width = cols
    offscreenCanvas.height = rows

    offscreenCtx.drawImage(renderer.domElement, 0, 0, cols, rows)
    const imgData = offscreenCtx.getImageData(0, 0, cols, rows).data

    let str = ""
    const charCount = ASCII_CHARS.length - 1
    for (let y = 0; y < rows; y++) {
      const rowOffset = y * cols
      for (let x = 0; x < cols; x++) {
        const idx = (rowOffset + x) * 4
        const r = imgData[idx]!
        const g = imgData[idx + 1]!
        const b = imgData[idx + 2]!
        const brightness = (0.299 * r + 0.587 * g + 0.114 * b) / 255
        const charIndex = Math.floor(brightness * charCount)
        str += ASCII_CHARS[charIndex]
      }
      str += "\n"
    }
    asciiLayer.textContent = str
  }

  // ── Animation Loop (NO MOUSE DEFLECTION) ─────────────────────────────────
  const clock = new three.Clock()
  const displacement = 0.25

  // 0 means "no frame queued". Every path that queues one goes through
  // `schedule`, so there is never more than one loop running.
  let animId = 0
  let stopped = false

  const animate = () => {
    animId = 0
    if (stopped) return

    const time = clock.getElapsedTime()

    // Locked position and rotation (centered, no rotation)
    activeGroup.position.set(0, 0, 0)
    activeGroup.rotation.set(0, 0, 0)

    const positions = particleSystem.geometry.attributes.position!.array as Float32Array

    for (let i = 0; i < NUM_PARTICLES; i++) {
      const cur = swarmPositions[i]!
      const target = swarmTargets[i]!

      // Pure organic breathing: NO mouse interaction
      const breathe = 1 + Math.sin(time * 2.0 + i * 0.02) * (0.05 + displacement * 0.3)
      const tx = target.x * breathe + Math.sin(time * 3 + i) * 0.08
      const ty = target.y * breathe + Math.cos(time * 2.5 + i) * 0.08
      const tz = target.z * breathe

      cur.x += (tx - cur.x) * 0.08
      cur.y += (ty - cur.y) * 0.08
      cur.z += (tz - cur.z) * 0.08

      positions[i * 3] = cur.x
      positions[i * 3 + 1] = cur.y
      positions[i * 3 + 2] = cur.z
    }

    particleSystem.geometry.attributes.position!.needsUpdate = true

    renderer.render(scene, camera)
    updateAsciiRender()

    schedule()
  }

  const schedule = () => {
    if (stopped || animId !== 0 || document.hidden) return
    animId = requestAnimationFrame(animate)
  }

  // Whether a hidden webview throttles rAF is the host's decision, not ours,
  // and the GPU readback in every frame is the expensive part. Stop outright
  // while hidden and pick up where the clock says we are when it comes back.
  const onVisibility = () => {
    if (document.hidden) {
      if (animId !== 0) cancelAnimationFrame(animId)
      animId = 0
    } else {
      schedule()
    }
  }

  // ── Window Resize Handling ──────────────────────────────────────────────
  const onResize = () => {
    const w = window.innerWidth
    const h = window.innerHeight
    camera.aspect = w / h
    camera.updateProjectionMatrix()
    renderer.setSize(w, h)
  }

  window.addEventListener("resize", onResize)
  document.addEventListener("visibilitychange", onVisibility)
  schedule()

  // ── Cleanup ─────────────────────────────────────────────────────────────
  return () => {
    if (stopped) return
    stopped = true
    if (animId !== 0) cancelAnimationFrame(animId)
    animId = 0
    window.removeEventListener("resize", onResize)
    document.removeEventListener("visibilitychange", onVisibility)

    scene.remove(activeGroup)
    pGeo.dispose()
    pMat.dispose()
    renderer.dispose()
    // `dispose` frees three's own resources but leaves the context alive until
    // the canvas is collected, and WebView2 keeps its GPU memory until then.
    // Losing it explicitly gives the memory back now.
    renderer.forceContextLoss()

    if (renderer.domElement.parentElement) {
      renderer.domElement.parentElement.removeChild(renderer.domElement)
    }
    // The last ~30k-character frame would otherwise sit in the (now detached) <pre>.
    asciiLayer.textContent = ""
    offscreenCanvas.width = 0
    offscreenCanvas.height = 0
  }
}
