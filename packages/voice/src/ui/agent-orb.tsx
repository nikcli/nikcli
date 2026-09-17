/**
 * The voice agent's own widget: a sphere of particles that speaks.
 *
 * S33, proposal B. The user did not want the assistant to talk through the
 * dictation pill — «un widget suo grande a forma di orb animato quando parla».
 * So while the agent thinks or speaks, the sphere flies out of the orb in the
 * bar to the middle of the workspace, 280 px across, and the panels behind it
 * dim; when it is done it flies back and is gone. Listening stays in the bar,
 * where the orb already shows it.
 *
 * Light by construction: nothing is mounted at rest, so there is no canvas and
 * no animation frame while the agent is quiet. While it is up, the drawing is
 * a thousand 2D rectangles a frame. The motion follows the loudness of the
 * voice actually playing (`PlaybackMeter`), and with reduced motion the sphere
 * neither flies nor turns: it fades in place and only swells with the voice.
 */

import { createEffect, createMemo, createSignal, on, onCleanup, Show } from "solid-js"
import type { VoiceEngine } from "../engine"
import type { PlaybackMeter } from "../tts/playback-level"
import {
  ORB_CENTER_SIZE,
  ORB_DOCK_SIZE,
  escapeStopsOrb,
  orbCentered,
  orbPhase,
  projectPoint,
  spherePoints,
  type OrbPhase,
} from "./agent-orb-state"
import "./agent-orb.css"
import { t } from "@nikcli-ai/ade/i18n"

export interface AgentOrbProps {
  engine: VoiceEngine
  meter: PlaybackMeter
  /** The area the sphere centres on and dims. Defaults to the whole window. */
  stage?: () => Element | null | undefined
  /** The control it flies from and back to. Defaults to the bar's voice orb. */
  dock?: () => Element | null | undefined
}

/*
 * Between two sentences the voice is briefly silent, and between a plan and
 * its reply nothing is running at all. Flying home in each of those gaps would
 * make the sphere bounce; it waits this long before deciding the turn is over.
 */
const LINGER_MS = 1500
const FLIGHT_MS = 550
const POINTS = spherePoints(1000)

interface Box {
  left: number
  top: number
  size: number
}

export function AgentOrb(props: AgentOrbProps) {
  const reduced = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches

  const phase = createMemo<OrbPhase>(() =>
    orbPhase({
      running: props.engine.isRunning(),
      mode: props.engine.activeMode(),
      status: props.engine.status(),
      speaking: props.meter.speaking(),
      replying: props.meter.replying(),
    }),
  )

  /** The phase the sphere is drawn in: the last centred one, held while it lingers or flies home. */
  const [shown, setShown] = createSignal<OrbPhase>("idle")
  const [mounted, setMounted] = createSignal(false)
  const [centered, setCentered] = createSignal(false)
  const [box, setBox] = createSignal<Box>({ left: 0, top: 0, size: ORB_DOCK_SIZE })

  const dockBox = (): Box => {
    const rect = (props.dock?.() ?? document.querySelector('[data-component="voice-orb"]'))?.getBoundingClientRect()
    if (!rect || rect.width === 0) return { left: window.innerWidth - 60, top: 12, size: ORB_DOCK_SIZE }
    const size = Math.min(rect.width, rect.height) || ORB_DOCK_SIZE
    return { left: rect.left + rect.width / 2 - size / 2, top: rect.top + rect.height / 2 - size / 2, size }
  }

  const stageRect = () => {
    const rect = props.stage?.()?.getBoundingClientRect()
    return rect && rect.width > 0 ? rect : new DOMRect(0, 0, window.innerWidth, window.innerHeight)
  }

  const centerBox = (): Box => {
    const rect = stageRect()
    const size = Math.min(ORB_CENTER_SIZE, rect.width * 0.6, rect.height * 0.6)
    return { left: rect.left + rect.width / 2 - size / 2, top: rect.top + rect.height / 2 - size / 2 - 24, size }
  }

  let linger: ReturnType<typeof setTimeout> | undefined
  let unmount: ReturnType<typeof setTimeout> | undefined

  createEffect(
    on(phase, (next) => {
      if (orbCentered(next)) {
        clearTimeout(linger)
        clearTimeout(unmount)
        setShown(next)
        if (!mounted()) {
          setBox(reduced ? centerBox() : dockBox())
          setMounted(true)
          // Two frames: the element must exist at the dock before it can fly from it.
          requestAnimationFrame(() =>
            requestAnimationFrame(() => {
              setBox(centerBox())
              setCentered(true)
            }),
          )
        } else {
          setBox(centerBox())
          setCentered(true)
        }
        return
      }
      if (!mounted()) return
      clearTimeout(linger)
      linger = setTimeout(() => {
        setCentered(false)
        if (!reduced) setBox(dockBox())
        unmount = setTimeout(() => {
          setMounted(false)
          setShown("idle")
        }, FLIGHT_MS)
      }, LINGER_MS)
    }),
  )

  onCleanup(() => {
    clearTimeout(linger)
    clearTimeout(unmount)
  })

  /* The window can change under a centred sphere; it follows. */
  createEffect(() => {
    if (!centered()) return
    const onResize = () => setBox(centerBox())
    window.addEventListener("resize", onResize)
    onCleanup(() => window.removeEventListener("resize", onResize))
  })

  /* Escape stops the reply, as the pill did — unless a field or a dialog has it. */
  createEffect(() => {
    if (!centered()) return
    const onKey = (event: KeyboardEvent) => {
      const target = event.target instanceof Element ? event.target : document.activeElement
      const modalOpen = document.querySelector('[aria-modal="true"], dialog[open]') !== null
      if (!escapeStopsOrb({ key: event.key, defaultPrevented: event.defaultPrevented, target, modalOpen })) return
      event.preventDefault()
      void props.engine.cancel()
    }
    window.addEventListener("keydown", onKey)
    onCleanup(() => window.removeEventListener("keydown", onKey))
  })

  const caption = createMemo(() => {
    if (shown() === "speak") return props.engine.lastSpoken() ?? ""
    const history = props.engine.history()
    for (let i = history.length - 1; i >= 0; i--) {
      const entry = history[i]
      if (entry?.kind === "user") return `«${entry.text}»`
    }
    return ""
  })

  /*
   * The element always has the centred size and place; the flight is a
   * transform onto the dock. Animating left/width instead would lay out the
   * page and resize the canvas on every frame of it.
   */
  const flightStyle = () => {
    const center = centerBox()
    const at = box()
    const dx = at.left + at.size / 2 - (center.left + center.size / 2)
    const dy = at.top + at.size / 2 - (center.top + center.size / 2)
    const scale = at.size / center.size
    return {
      left: `${center.left}px`,
      top: `${center.top}px`,
      width: `${center.size}px`,
      height: `${center.size}px`,
      transform: `translate(${dx}px, ${dy}px) scale(${scale})`,
    }
  }

  const dim = () => {
    const rect = stageRect()
    return { left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px` }
  }

  return (
    <Show when={mounted()}>
      <div data-component="agent-orb-dim" data-on={centered() ? "true" : undefined} style={dim()} aria-hidden="true" />
      <div
        data-component="agent-orb"
        data-phase={shown()}
        data-centered={centered() ? "true" : undefined}
        data-reduced={reduced ? "true" : undefined}
        style={flightStyle()}
      >
        <button
          type="button"
          data-slot="agent-orb-sphere"
          aria-label={shown() === "speak" ? t("vui.agentOrb.speaking") : t("vui.agentOrb.working")}
          onClick={() => void props.engine.interrupt()}
        >
          <Sphere phase={shown} level={() => props.meter.level()} reduced={reduced} />
        </button>
        <Show when={centered() && caption()}>
          <p data-slot="agent-orb-caption" role="status" aria-live="polite">
            {caption()}
          </p>
        </Show>
      </div>
    </Show>
  )
}

function Sphere(props: { phase: () => OrbPhase; level: () => number; reduced: boolean }) {
  let canvas: HTMLCanvasElement | undefined
  let frame = 0
  /*
   * The theme's accent and waiting colours, read from the tokens rather than
   * copied: the light theme's are darker, and a sphere drawn in the dark
   * theme's mint vanishes against a light workspace.
   */
  let palette: { speak: string; think: string } | undefined
  const readPalette = (node: HTMLElement) => {
    const style = getComputedStyle(node)
    const rgb = (name: string, fallback: string) => {
      const probe = document.createElement("span")
      probe.style.color = style.getPropertyValue(name).trim() || fallback
      node.appendChild(probe)
      const value = getComputedStyle(probe).color
      probe.remove()
      const parts = value.match(/[\d.]+/g)
      return parts ? parts.slice(0, 3).join(",") : fallback
    }
    return { speak: rgb("--ade-accent", "127,214,196"), think: rgb("--ade-waiting", "125,169,228") }
  }
  let smoothed = 0
  const started = performance.now()

  const draw = (now: number) => {
    frame = requestAnimationFrame(draw)
    const node = canvas
    const ctx = node?.getContext("2d")
    if (!node || !ctx) return

    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    const w = Math.max(1, Math.round(node.clientWidth * dpr))
    const h = Math.max(1, Math.round(node.clientHeight * dpr))
    if (node.width !== w || node.height !== h) {
      node.width = w
      node.height = h
    }

    const raw = props.level()
    // Quick to rise, slower to fall: syllables read as beats, not flicker.
    smoothed += (raw - smoothed) * (raw > smoothed ? 0.45 : 0.12)
    const phase = props.phase()
    const seconds = (now - started) / 1000
    palette ??= readPalette(node)
    const color = phase === "think" ? palette.think : palette.speak
    const cx = w / 2
    const cy = h / 2
    const radius = Math.min(w, h) * 0.36

    ctx.clearRect(0, 0, w, h)
    const glow = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius * (1.3 + smoothed * 0.3))
    glow.addColorStop(0, `rgba(${color},${0.1 + smoothed * 0.14})`)
    glow.addColorStop(1, `rgba(${color},0)`)
    ctx.fillStyle = glow
    ctx.fillRect(0, 0, w, h)

    const dot = Math.max(1, (w / 380) * 1.6)
    for (const point of POINTS) {
      const p = projectPoint(point, seconds, phase, smoothed, props.reduced)
      const size = dot * (0.6 + p.depth * 1.6)
      ctx.fillStyle = `rgba(${color},${0.12 + p.depth * 0.78})`
      ctx.fillRect(cx + p.x * radius - size / 2, cy + p.y * radius - size / 2, size, size)
    }
  }

  frame = requestAnimationFrame(draw)
  onCleanup(() => cancelAnimationFrame(frame))

  return <canvas ref={canvas} data-slot="agent-orb-canvas" aria-hidden="true" />
}
