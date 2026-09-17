import { onMount, onCleanup, createSignal, type JSX } from "solid-js"

export interface NikChromeLogoProps {
  /** Logo size in pixels (both width and height square bounding box). Defaults to 30. */
  size?: number
  class?: string
}

/**
 * Concept 03: Molten Chrome Mercury (N) with Interactive Physics.
 *
 * Sculptural continuous liquid-metal ribbon twisted into the letter N.
 * Continuous turntable rotation is disabled. Instead, the logo features
 * real-time spring-damper physics, fluid surface tension wobble, inertia lag,
 * and orbital mercury micro-droplets that physically react to mouse interactions and clicks.
 */
export function NikChromeLogo(props: NikChromeLogoProps): JSX.Element {
  const size = () => props.size ?? 30
  let containerRef: HTMLSpanElement | undefined
  let turntableRef: HTMLDivElement | undefined
  let dropletARef: HTMLDivElement | undefined
  let dropletBRef: HTMLDivElement | undefined

  const [hovered, setHovered] = createSignal(false)

  // Fluid N ribbon SVG path
  const N_PATH =
    "M 11 34 C 10 24, 11 13, 12 8 C 13 4, 16.5 4, 18.5 8.5 L 26.5 27 C 28.5 31, 31.5 31, 32.5 27 C 33.5 21, 34 13.5, 34.5 8"

  // Whether the loop is running. It drives the sheen sweep too, so the CSS
  // animation and the rAF loop start and stop together.
  const [live, setLive] = createSignal(false)

  onMount(() => {
    // 0 means "no frame queued".
    let animId = 0
    let isMounted = true

    // ── Physics Simulation State ──────────────────────────────────────────
    // Base 3D isometric rest pose
    const BASE_ROTY = 20
    const BASE_ROTX = 6

    // Reduced motion check
    const reducedMotion =
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches

    // Angular orientation & spring dynamics
    let tiltX = 0
    let tiltY = 0
    let targetTiltX = 0
    let targetTiltY = 0
    let velX = 0
    let velY = 0

    // Liquid surface tension wobble (jello / fluid ripple)
    let wobbleAmp = 0
    let wobblePhase = 0

    // Droplets spring physics (mass & inertia trailing)
    let dropAX = 0
    let dropAY = 0
    let dropAZ = 16
    let dropAVelX = 0
    let dropAVelY = 0
    let dropAVelZ = 0

    let dropBX = 0
    let dropBY = 0
    let dropBZ = -14
    let dropBVelX = 0
    let dropBVelY = 0
    let dropBVelZ = 0

    let time = 0
    const SPRING_K = 0.14
    const DAMPING = 0.82

    // This mark sits in the title bar for the whole session, and a loop that
    // never ends there repaints the bar (drop-shadows, a blend layer) sixty
    // times a second while the user is doing nothing. So it moves only when
    // there is a reason: a short intro after mount, and while the pointer is
    // on it. When neither holds it winds down until the springs settle, then
    // stops and freezes on whatever frame it reached — which is a frame of
    // the animation, so the resting mark looks like the moving one.
    const INTRO_MS = 2000
    const introUntil = performance.now() + INTRO_MS
    let pointerInside = false

    const settled = () =>
      Math.abs(velX) < 0.01 &&
      Math.abs(velY) < 0.01 &&
      Math.abs(tiltX - targetTiltX) < 0.05 &&
      Math.abs(tiltY - targetTiltY) < 0.05 &&
      wobbleAmp < 0.01

    const start = () => {
      if (reducedMotion || !isMounted || animId !== 0) return
      setLive(true)
      animId = requestAnimationFrame(updatePhysics)
    }

    const placeDroplets = () => {
      if (dropletARef) {
        const dScale = 1 + (dropAZ / 30) * 0.35
        dropletARef.style.transform = `translate3d(${dropAX}px, ${dropAY}px, ${dropAZ}px) scale(${dScale})`
        dropletARef.style.opacity = `${Math.max(0.4, Math.min(1, 0.75 + dropAZ * 0.025))}`
      }
      if (dropletBRef) {
        const dScale = 1 + (dropBZ / 30) * 0.35
        dropletBRef.style.transform = `translate3d(${dropBX}px, ${dropBY}px, ${dropBZ}px) scale(${dScale})`
        dropletBRef.style.opacity = `${Math.max(0.4, Math.min(1, 0.75 + dropBZ * 0.025))}`
      }
    }

    if (reducedMotion) {
      // No motion at all, but not the collapsed pose either: put the droplets
      // where the orbit would have them a moment in, so the mark still reads
      // as the animated one caught mid-frame.
      const t = 1
      dropAX = Math.cos(t * 1.5) * 16
      dropAY = Math.sin(t * 1.2) * 5
      dropAZ = Math.sin(t * 1.5) * 12
      dropBX = Math.cos(t * 1.1 + Math.PI) * 14
      dropBY = Math.sin(t * 1.6 + Math.PI) * 6
      dropBZ = Math.sin(t * 1.1 + Math.PI) * 12
      placeDroplets()
      if (turntableRef) {
        turntableRef.style.transform = `rotateY(${BASE_ROTY}deg) rotateX(${BASE_ROTX}deg)`
      }
      return
    }

    const updatePhysics = () => {
      animId = 0
      if (!isMounted) return
      time += 0.02

      // Spring-damper integration for 3D tilt
      const forceX = -SPRING_K * (tiltX - targetTiltX) - (1 - DAMPING) * velX
      const forceY = -SPRING_K * (tiltY - targetTiltY) - (1 - DAMPING) * velY
      velX += forceX
      velY += forceY
      tiltX += velX
      tiltY += velY

      // Liquid mercury surface tension oscillation
      wobbleAmp *= 0.94
      wobblePhase += 0.4
      const wobble = Math.sin(wobblePhase) * wobbleAmp
      const scaleX = 1 + wobble * 0.015
      const scaleY = 1 - wobble * 0.015

      // Apply 3D transform to main turntable
      if (turntableRef) {
        turntableRef.style.transform = `rotateY(${BASE_ROTY + tiltY}deg) rotateX(${BASE_ROTX + tiltX}deg) scale3d(${scaleX}, ${scaleY}, 1)`
      }

      // Droplet A: Spring physics orbiting around upper loop
      const targetDropAX = Math.cos(time * 1.5) * 16 + tiltY * 0.3
      const targetDropAY = Math.sin(time * 1.2) * 5 + tiltX * 0.3
      const targetDropAZ = Math.sin(time * 1.5) * 12

      dropAVelX += -0.12 * (dropAX - targetDropAX) - 0.18 * dropAVelX
      dropAVelY += -0.12 * (dropAY - targetDropAY) - 0.18 * dropAVelY
      dropAVelZ += -0.12 * (dropAZ - targetDropAZ) - 0.18 * dropAVelZ
      dropAX += dropAVelX
      dropAY += dropAVelY
      dropAZ += dropAVelZ

      // Droplet B: Spring physics orbiting around lower loop
      const targetDropBX = Math.cos(time * 1.1 + Math.PI) * 14 - tiltY * 0.25
      const targetDropBY = Math.sin(time * 1.6 + Math.PI) * 6 - tiltX * 0.25
      const targetDropBZ = Math.sin(time * 1.1 + Math.PI) * 12

      dropBVelX += -0.1 * (dropBX - targetDropBX) - 0.2 * dropBVelX
      dropBVelY += -0.1 * (dropBY - targetDropBY) - 0.2 * dropBVelY
      dropBVelZ += -0.1 * (dropBZ - targetDropBZ) - 0.2 * dropBVelZ
      dropBX += dropBVelX
      dropBY += dropBVelY
      dropBZ += dropBVelZ

      placeDroplets()

      if (pointerInside || performance.now() < introUntil || !settled()) {
        animId = requestAnimationFrame(updatePhysics)
      } else {
        setLive(false)
      }
    }

    start()

    // ── Mouse & Interaction Handlers ─────────────────────────────────────
    const onMouseMove = (e: MouseEvent) => {
      if (!containerRef) return
      const rect = containerRef.getBoundingClientRect()
      const cx = rect.left + rect.width / 2
      const cy = rect.top + rect.height / 2
      const dx = (e.clientX - cx) / (rect.width * 1.2)
      const dy = (e.clientY - cy) / (rect.height * 1.2)

      // Clamp target tilt within +/- 30 degrees
      targetTiltY = Math.max(-30, Math.min(30, dx * 30))
      targetTiltX = Math.max(-25, Math.min(25, -dy * 25))
    }

    const onMouseEnter = () => {
      pointerInside = true
      setHovered(true)
      start()
      // Fluid impulse on hover
      velY += (Math.random() > 0.5 ? 1 : -1) * 6
      velX += 5
      wobbleAmp += 5
    }

    const onMouseLeave = () => {
      // The loop is not cancelled here: it keeps going until the tilt has
      // sprung back, and stops by itself once it has.
      pointerInside = false
      setHovered(false)
      targetTiltX = 0
      targetTiltY = 0
    }

    const onClick = () => {
      // Liquid splash recoil impulse
      wobbleAmp = 22
      velX += (Math.random() - 0.5) * 26
      velY += (Math.random() - 0.5) * 26
      dropAVelZ += 18
      dropBVelZ -= 18
      start()
    }

    const el = containerRef
    if (el) {
      el.addEventListener("mousemove", onMouseMove)
      el.addEventListener("mouseenter", onMouseEnter)
      el.addEventListener("mouseleave", onMouseLeave)
      el.addEventListener("click", onClick)
    }

    onCleanup(() => {
      isMounted = false
      if (animId !== 0) cancelAnimationFrame(animId)
      animId = 0
      if (el) {
        el.removeEventListener("mousemove", onMouseMove)
        el.removeEventListener("mouseenter", onMouseEnter)
        el.removeEventListener("mouseleave", onMouseLeave)
        el.removeEventListener("click", onClick)
      }
    })
  })

  return (
    <span
      ref={containerRef}
      data-component="nik-chrome-logo"
      data-live={live() ? "" : undefined}
      class={props.class}
      style={{
        display: "inline-flex",
        "align-items": "center",
        "justify-content": "center",
        width: `${size()}px`,
        height: `${size()}px`,
        position: "relative",
        perspective: "500px",
        cursor: "pointer",
      }}
      title="ADE — Molten Chrome Mercury with Physics (Click for liquid splash)"
      aria-label="ADE Logo — Concept 3 Molten Chrome"
    >
      <style>{`
        @keyframes chromeSheenFlow {
          0% { stroke-dashoffset: 160; opacity: 0.25; }
          50% { opacity: 0.95; }
          100% { stroke-dashoffset: -160; opacity: 0.25; }
        }

        .nik-physics-turntable {
          width: 100%;
          height: 100%;
          position: absolute;
          transform-style: preserve-3d;
          transform-origin: center center;
          will-change: transform;
        }

        /* Paused unless the physics loop is running. The negative delay
           starts it at its midpoint (offset 0, near full opacity), so the
           mark at rest shows the sheen across the ribbon rather than the
           dim start of a sweep; pausing and resuming keep the frame they
           reached, so neither end of a hover jumps. A paused animation
           asks for no frames. */
        .nik-sheen-sweep {
          stroke-dasharray: 45 110;
          animation: chromeSheenFlow 2.8s linear -1.4s infinite;
          animation-play-state: paused;
        }

        [data-component="nik-chrome-logo"][data-live] .nik-sheen-sweep {
          animation-play-state: running;
        }

        @media (prefers-reduced-motion: reduce) {
          .nik-sheen-sweep {
            animation: none;
            stroke-dashoffset: 0;
            opacity: 0.95;
          }
        }

        .nik-physics-droplet-a {
          position: absolute;
          width: 4px;
          height: 4px;
          border-radius: 50%;
          top: 18px;
          left: 18px;
          transform-style: preserve-3d;
          pointer-events: none;
          will-change: transform, opacity;
        }

        .nik-physics-droplet-b {
          position: absolute;
          width: 3.5px;
          height: 3.5px;
          border-radius: 50%;
          top: 22px;
          left: 20px;
          transform-style: preserve-3d;
          pointer-events: none;
          will-change: transform, opacity;
        }
      `}</style>

      {/* 3D Physics Turntable (Rotates via spring-damper physics, NOT constant rotation) */}
      <div ref={turntableRef} class="nik-physics-turntable">
        {/* Layer -3: Dark Specular Under-Extrusion */}
        <svg
          viewBox="0 0 44 44"
          width="100%"
          height="100%"
          style={{
            position: "absolute",
            inset: 0,
            transform: "translateZ(-4.5px)",
            filter: "drop-shadow(0 4px 6px rgba(0, 0, 0, 0.9))",
          }}
        >
          <path
            d={N_PATH}
            fill="none"
            stroke="#0a101d"
            stroke-width="5"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>

        {/* Layer -2: Deep Cobalt Base Extrusion */}
        <svg
          viewBox="0 0 44 44"
          width="100%"
          height="100%"
          style={{
            position: "absolute",
            inset: 0,
            transform: "translateZ(-3px)",
          }}
        >
          <path
            d={N_PATH}
            fill="none"
            stroke="#1b2c4e"
            stroke-width="4.6"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>

        {/* Layer -1: Mid Metallic Body */}
        <svg
          viewBox="0 0 44 44"
          width="100%"
          height="100%"
          style={{
            position: "absolute",
            inset: 0,
            transform: "translateZ(-1.5px)",
          }}
        >
          <path
            d={N_PATH}
            fill="none"
            stroke="#3a5a8c"
            stroke-width="4.2"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>

        {/* Layer 0: Front High-Reflectance Liquid Chrome */}
        <svg
          viewBox="0 0 44 44"
          width="100%"
          height="100%"
          style={{
            position: "absolute",
            inset: 0,
            transform: "translateZ(0px)",
          }}
        >
          <defs>
            {/* Liquid Chrome Linear Gradient */}
            <linearGradient id="nikLiquidChromeGrad" x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" stop-color="#ffffff" stop-opacity="1" />
              <stop offset="22%" stop-color="#d6e8ff" stop-opacity="1" />
              <stop offset="42%" stop-color="#58a6ff" stop-opacity="1" />
              <stop offset="55%" stop-color="#0e1726" stop-opacity="1" />
              <stop offset="72%" stop-color="#79c0ff" stop-opacity="1" />
              <stop offset="90%" stop-color="#e6edf3" stop-opacity="1" />
              <stop offset="100%" stop-color="#ffffff" stop-opacity="1" />
            </linearGradient>

            {/* Specular Sheen Gradient */}
            <linearGradient id="nikSheenGrad" x1="0%" y1="0%" x2="100%" y2="0%">
              <stop offset="0%" stop-color="#ffffff" stop-opacity="0" />
              <stop offset="45%" stop-color="#ffffff" stop-opacity="0.95" />
              <stop offset="55%" stop-color="#79c0ff" stop-opacity="1" />
              <stop offset="100%" stop-color="#58a6ff" stop-opacity="0" />
            </linearGradient>

            {/* Micro Droplet Radial Gradient */}
            <radialGradient id="nikDropletGrad" cx="35%" cy="35%" r="65%">
              <stop offset="0%" stop-color="#ffffff" />
              <stop offset="40%" stop-color="#79c0ff" />
              <stop offset="85%" stop-color="#1b2c4e" />
              <stop offset="100%" stop-color="#0a101d" />
            </radialGradient>
          </defs>

          {/* Liquid Core Ribbon */}
          <path
            d={N_PATH}
            fill="none"
            stroke="url(#nikLiquidChromeGrad)"
            stroke-width="3.8"
            stroke-linecap="round"
            stroke-linejoin="round"
          />

          {/* High-frequency liquid caustic spine */}
          <path
            d={N_PATH}
            fill="none"
            stroke="#ffffff"
            stroke-width="1.1"
            stroke-linecap="round"
            stroke-linejoin="round"
            stroke-opacity="0.8"
          />

          {/* Animated Sheen Sweep */}
          <path
            d={N_PATH}
            class="nik-sheen-sweep"
            fill="none"
            stroke="url(#nikSheenGrad)"
            stroke-width="2.2"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>

        {/* Layer +1: Floating Prismatic Caustic Overlay */}
        <svg
          viewBox="0 0 44 44"
          width="100%"
          height="100%"
          style={{
            position: "absolute",
            inset: 0,
            transform: "translateZ(2.2px)",
            "mix-blend-mode": "screen",
            opacity: hovered() ? 0.95 : 0.75,
            transition: "opacity 0.25s ease",
          }}
        >
          <path
            d={N_PATH}
            fill="none"
            stroke="#79c0ff"
            stroke-width="1.4"
            stroke-linecap="round"
            stroke-linejoin="round"
            filter="drop-shadow(0 0 3px #58a6ff)"
          />
        </svg>

        {/* Floating Mercury Droplet A (With Physics Lag) */}
        <div ref={dropletARef} class="nik-physics-droplet-a">
          <svg viewBox="0 0 8 8" width="8" height="8" style={{ display: "block" }}>
            <circle cx="4" cy="4" r="3.2" fill="url(#nikDropletGrad)" />
            <circle cx="2.8" cy="2.8" r="1.1" fill="#ffffff" opacity="0.9" />
          </svg>
        </div>

        {/* Floating Mercury Droplet B (With Physics Lag) */}
        <div ref={dropletBRef} class="nik-physics-droplet-b">
          <svg viewBox="0 0 8 8" width="8" height="8" style={{ display: "block" }}>
            <circle cx="4" cy="4" r="2.8" fill="url(#nikDropletGrad)" />
            <circle cx="2.8" cy="2.8" r="0.9" fill="#ffffff" opacity="0.9" />
          </svg>
        </div>
      </div>
    </span>
  )
}
