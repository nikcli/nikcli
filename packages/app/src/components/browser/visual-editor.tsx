import { createSignal, createEffect, createMemo, onCleanup, onMount, on, Show, For, type JSX } from "solid-js"
import { createStore } from "solid-js/store"
import { useNavigate, useParams } from "@solidjs/router"
import { appendTextToPrompt } from "@/context/prompt-append"
import { IconButton } from "@nikcli-ai/ui/icon-button"
import { Icon } from "@nikcli-ai/ui/icon"
import { Select } from "@nikcli-ai/ui/select"
import { useCommand } from "@/context/command"
import { useLanguage } from "@/context/language"
import { useLayout } from "@/context/layout"
import { useGlobalSync } from "@/context/global-sync"
import { usePrompt } from "@/context/prompt"
import { useServer } from "@/context/server"
import { showToast } from "@nikcli-ai/ui/toast"
import { getFilename } from "@nikcli-ai/util/path"
import { base64Encode } from "@nikcli-ai/util/encode"
import { persisted } from "@/utils/persist"
import { decode64 } from "@/utils/base64"
import { digestConsoleErrors } from "./console-digest"
import { PointPromptPopover } from "./point-prompt-popover"
import { VisualControlsSidebar } from "./visual-controls-sidebar"
import {
  type InspectedElement,
  type ConsoleEntry,
  type BridgeMessage,
  INSPECTOR_BRIDGE_SCRIPT,
} from "./inspector-bridge"

export const VISUAL_EDITOR_PROMPT_EVENT = "nikcli:prompt-append"

export interface BrowserVisualEditorProps {
  initialUrl?: string
  onClose?: () => void
}

/** The desktop workbench mounts the editor outside any session, so no prompt context. */
function optionalPrompt() {
  try {
    return usePrompt()
  } catch {
    return undefined
  }
}

type DevicePreset = "responsive" | "desktop" | "tablet" | "mobile"
type LoadState = "idle" | "loading" | "ready" | "unreachable"
type Fidelity = "pending" | "native" | "mirror" | "none"

/** How long to wait for a page to announce the bridge before mirroring it. */
const HANDSHAKE_MS = 1500

const DEVICES: Record<DevicePreset, { width: number; height: number; label: string }> = {
  responsive: { width: 0, height: 0, label: "Full" },
  desktop: { width: 1280, height: 800, label: "Desktop" },
  tablet: { width: 768, height: 1024, label: "Tablet" },
  mobile: { width: 375, height: 812, label: "Mobile" },
}

const COMMON_PORTS = ["3000", "5173", "4321", "8080"]

const QUICK_ACTION_PROMPTS: Record<string, string> = {
  "make-bigger": "Make this element noticeably larger while keeping the layout balanced.",
  "center-content": "Center this element's content both horizontally and vertically.",
  "add-rounded": "Give this element rounded corners consistent with the rest of the design.",
  "add-padding": "Add comfortable internal padding to this element.",
  "swap-color": "Change this element's colors to a variant that fits the existing palette.",
  delete: "Remove this element and clean up any styles or markup left behind.",
}

/** One selected element rendered as compact, agent-readable context. */
function describeElement(element: InspectedElement, index: number) {
  const id = element.id ? `#${element.id}` : ""
  const classes = element.className
    ? `.${element.className.split(/\s+/).filter(Boolean).slice(0, 3).join(".")}`
    : ""
  const styles = element.styles
  const lines = [
    `${index + 1}. <${element.tagName}${id}${classes}> (${element.detectedLanguage})`,
    `   selector: ${element.selector}`,
    `   box: ${element.rect.width}×${element.rect.height} · display: ${styles.display} · padding: ${styles.padding} · margin: ${styles.margin}`,
    `   text: ${styles.color} ${styles.fontSize}/${styles.fontWeight} · background: ${styles.backgroundColor} · radius: ${styles.borderRadius}`,
  ]
  if (element.innerText) lines.push(`   content: "${element.innerText}"`)
  return lines.join("\n")
}

export function BrowserVisualEditor(props: BrowserVisualEditorProps): JSX.Element {
  const command = useCommand()
  const language = useLanguage()
  const prompt = optionalPrompt()
  const server = useServer()
  const layout = useLayout()
  const globalSync = useGlobalSync()
  const params = useParams()
  const navigateRoute = useNavigate()
  const [preview, setPreview, , previewReady] = persisted(
    "visual-editor.preview.v1",
    createStore({ urls: {} as Record<string, string> }),
  )

  const bridgeTag = () =>
    `<script src="${(server.url || window.location.origin).replace(/\/+$/, "")}/visual-editor/bridge.js"></script>`

  const currentDirectory = createMemo(() => decode64(params.dir) ?? "")

  const [url, setUrl] = createSignal(
    preview.urls[currentDirectory()] || props.initialUrl || "http://localhost:3000",
  )
  const [inputUrl, setInputUrl] = createSignal(url())
  const [srcdoc, setSrcdoc] = createSignal<string | null>(null)
  // Bumped on every load so the iframe is recreated; reassigning an identical
  // `src`/`srcdoc` does not make the browser refetch.
  const [loadToken, setLoadToken] = createSignal(1)
  const [state, setState] = createSignal<LoadState>("idle")
  const [loadError, setLoadError] = createSignal<string>()
  // "native": the page loaded on its own origin and answered the handshake.
  // "mirror": we had to rebuild it as a srcdoc copy. "none": neither worked.
  const [fidelity, setFidelity] = createSignal<Fidelity>("pending")

  const [device, setDevice] = createSignal<DevicePreset>("responsive")
  const [landscape, setLandscape] = createSignal(false)

  const [designMode, setDesignMode] = createSignal(false)
  const [selection, setSelection] = createSignal<InspectedElement[]>([])
  const [popoverFor, setPopoverFor] = createSignal<InspectedElement | null>(null)
  const [inspectorOpen, setInspectorOpen] = createSignal(false)

  const [logs, setLogs] = createSignal<ConsoleEntry[]>([])
  const [consoleOpen, setConsoleOpen] = createSignal(false)
  const [logFilter, setLogFilter] = createSignal<"all" | "error" | "warn">("all")

  let iframeRef: HTMLIFrameElement | undefined
  let handshake: ReturnType<typeof setTimeout> | undefined
  /** Bumped per load so a superseded target cannot report its verdict. */
  let loadGeneration = 0

  const post = (message: unknown) => iframeRef?.contentWindow?.postMessage(message, "*")

  const address = createMemo(() => {
    try {
      const parsed = new URL(url())
      return { port: parsed.port || (parsed.protocol === "https:" ? "443" : "80") }
    } catch {
      return undefined
    }
  })

  // The port actually in use is always offered, even when it is not a common one.
  const ports = createMemo(() => {
    const current = address()?.port
    if (current && !COMMON_PORTS.includes(current) && current !== "80" && current !== "443") {
      return [current, ...COMMON_PORTS]
    }
    return COMMON_PORTS
  })

  const project = createMemo(() => {
    const dir = currentDirectory()
    if (!dir) return
    const projects = layout.projects.list()
    const sandbox = projects.find((item) => item.sandboxes?.includes(dir))
    if (sandbox) return sandbox
    return projects.find((item) => item.worktree === dir)
  })
  const worktreeOptions = createMemo(() => {
    const current = project()
    if (!current) return []
    const [main] = globalSync.child(current.worktree, { bootstrap: false })
    const branch = main.vcs?.branch
    const options = [
      {
        value: current.worktree,
        label: branch
          ? language.t("session.new.worktree.mainWithBranch", { branch })
          : language.t("session.new.worktree.main"),
      },
    ]
    for (const sandbox of current.sandboxes ?? []) {
      options.push({ value: sandbox, label: getFilename(sandbox) })
    }
    return options
  })
  const currentWorktree = createMemo(() => {
    const dir = currentDirectory()
    const options = worktreeOptions()
    if (options.some((item) => item.value === dir)) return dir
    return options[0]?.value
  })

  const rememberUrl = (next: string) => {
    const dir = currentDirectory()
    if (!dir) return
    setPreview("urls", dir, next)
  }

  /**
   * Rebuild the page as a srcdoc copy with the bridge inlined. This is the only
   * way to inspect a page that does not carry the bridge itself, but the copy
   * runs at `about:srcdoc`, so anything reading `location` — client-side routers
   * above all — sees the wrong path.
   */
  const loadMirror = async (target: string, generation: number) => {
    // Every await here can outlive the load that started it: navigating away
    // leaves the previous target's fetches in flight, and they used to write
    // their verdict over the current page. The first mount makes this the normal
    // case, since the default localhost:3000 is usually not running.
    const current = () => generation === loadGeneration

    try {
      const res = await fetch(target, { mode: "cors" })
      if (!current()) return
      if (res.ok) {
        const html = await res.text()
        // Reading the body is a second await, and a slow server means it can
        // land after the user has already navigated somewhere else.
        if (!current()) return
        // The charset declaration must stay inside the browser's 1024-byte
        // sniffing window; the bridge script alone is far bigger than that, so
        // it goes first and the script follows.
        const head = `<meta charset="utf-8"><base href="${target.endsWith("/") ? target : `${target}/`}">`
        const bridge = `<script>${INSPECTOR_BRIDGE_SCRIPT}<\/script>`
        let injected = html
        if (injected.includes("<head>")) injected = injected.replace("<head>", `<head>${head}\n${bridge}\n`)
        else if (injected.includes("<html>"))
          injected = injected.replace("<html>", `<html>\n<head>${head}\n${bridge}\n</head>\n`)
        else injected = `${head}\n${bridge}\n${injected}`

        setFidelity("mirror")
        setSrcdoc(injected)
        setLoadToken((value) => value + 1)
        return
      }
      setLoadError(`${res.status} ${res.statusText}`)
    } catch (error) {
      if (!current()) return
      setLoadError(error instanceof Error ? error.message : String(error))
    }

    // A failed CORS fetch does not mean the site is down — it usually means the
    // dev server simply does not allow us to read it. An opaque no-cors probe
    // separates "nothing is listening" from "listening, just not readable", so
    // a running app keeps rendering instead of being hidden behind an error.
    try {
      await fetch(target, { mode: "no-cors" })
      if (!current()) return
      // The site answered — it just would not let us read it. Browse-only, and
      // the CORS message from above is not an error the user needs to see.
      setLoadError(undefined)
      setFidelity("none")
      setState("ready")
    } catch {
      if (!current()) return
      setFidelity("none")
      setState("unreachable")
    }
  }

  /**
   * Load the real URL first. When the page already carries the bridge — via the
   * one-line script tag the server hosts — the frame stays on its own origin and
   * everything, routing included, behaves exactly as it does outside the editor.
   * Only when no handshake arrives do we fall back to the mirror.
   */
  const load = (target: string) => {
    loadGeneration += 1
    const generation = loadGeneration
    if (handshake) clearTimeout(handshake)
    setState("loading")
    setLoadError(undefined)
    setSelection([])
    setPopoverFor(null)
    setFidelity("pending")
    setSrcdoc(null)
    setLoadToken((value) => value + 1)

    startHandshake(target, generation)
  }

  /**
   * Give the bridge a window to announce itself, then mirror the page instead.
   *
   * Started twice on purpose. The first run covers the case the mirror exists
   * for — nothing is listening on the port, so the frame never loads and no
   * later event would ever start it. The second, from `onFrameLoad`, resets the
   * clock once the document is actually there: a cold dev server routinely takes
   * longer than this budget to answer, and counting that time against the
   * handshake demoted correctly configured pages to a mirrored copy.
   */
  function startHandshake(target: string, generation: number) {
    if (handshake) clearTimeout(handshake)
    handshake = setTimeout(() => {
      if (generation !== loadGeneration) return
      if (fidelity() === "pending") void loadMirror(target, generation)
    }, HANDSHAKE_MS)
  }

  onCleanup(() => {
    if (handshake) clearTimeout(handshake)
  })

  const navigate = (next: string) => {
    const trimmed = next.trim()
    if (!trimmed) return
    const formatted = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`
    setUrl(formatted)
    setInputUrl(formatted)
    rememberUrl(formatted)
    void load(formatted)
  }

  const switchPort = (port: string) => {
    try {
      const next = new URL(url())
      next.port = port
      navigate(next.toString())
    } catch {
      navigate(`http://localhost:${port}`)
    }
  }

  onMount(() => load(url()))

  // Each project remembers its own preview URL. Also re-run once the persisted
  // store has hydrated: on desktop it is read asynchronously, after the first load.
  createEffect(
    on([currentDirectory, previewReady], ([dir, ready]) => {
      if (!dir || !ready) return
      const saved = preview.urls[dir]
      if (!saved || saved === url()) return
      setUrl(saved)
      setInputUrl(saved)
      load(saved)
    }),
  )

  const switchWorktree = (directory: string) => {
    if (!directory || directory === currentDirectory()) return
    rememberUrl(url())
    navigateRoute(`/${base64Encode(directory)}/session`)
  }

  const onFrameLoad = () => {
    if (srcdoc() !== null) setState("ready")
    // The document arrived; only now does the bridge get its budget.
    if (srcdoc() === null && fidelity() === "pending") startHandshake(url(), loadGeneration)
    // Cross-origin frames reject script injection; the srcdoc path already has
    // the bridge inlined, so this only matters for same-origin direct loads.
    try {
      const doc = iframeRef?.contentDocument
      if (doc && !doc.getElementById("__nikcli_hover_outline")) {
        const script = doc.createElement("script")
        script.textContent = INSPECTOR_BRIDGE_SCRIPT
        ;(doc.head ?? doc.body)?.appendChild(script)
      }
    } catch {
      // Cross-origin: the frame stays browse-only.
    }
    syncMode()
  }

  const syncMode = () => post({ type: "visual-editor:set-mode", mode: designMode() ? "edit" : "browse" })

  /** Iframe-local rect translated into host viewport coordinates. */
  const toHostSpace = (element: InspectedElement): InspectedElement => {
    const frame = iframeRef?.getBoundingClientRect()
    if (!frame) return element
    return {
      ...element,
      rect: {
        ...element.rect,
        top: element.rect.top + frame.top,
        left: element.rect.left + frame.left,
      },
    }
  }

  const handleMessage = (event: MessageEvent) => {
    // The listener is on `window`, so without this any frame or opened window can
    // forge bridge traffic — including `element-reordered`, which writes straight
    // into the session prompt the agent then acts on.
    if (!iframeRef?.contentWindow || event.source !== iframeRef.contentWindow) return

    const data = event.data as BridgeMessage
    if (!data || typeof data !== "object" || typeof data.type !== "string") return
    if (!data.type.startsWith("visual-editor:")) return

    if (data.type === "visual-editor:ready") {
      if (handshake) clearTimeout(handshake)
      setFidelity(srcdoc() === null ? "native" : "mirror")
      setState("ready")
      syncMode()
      return
    }

    if (data.type === "visual-editor:console-log") {
      setLogs((previous) => [...previous.slice(-200), data.log])
      return
    }

    if (data.type === "visual-editor:element-selected") {
      const element = data.element
      setSelection((previous) =>
        previous.some((item) => item.selector === element.selector) ? previous : [...previous, element],
      )
      setPopoverFor(element)
      return
    }

    if (data.type === "visual-editor:element-reordered") {
      appendToPrompt(
        `[Design Mode · layout] Moved ${data.selector} from index ${data.oldIndex} to ${data.newIndex} inside ${data.parentSelector}. Apply the same order in the source.\n`,
      )
      showToast({ variant: "success", title: "Reorder captured", description: "Added to the session prompt." })
    }
  }

  onMount(() => {
    window.addEventListener("message", handleMessage)
    onCleanup(() => window.removeEventListener("message", handleMessage))
  })

  createEffect(() => {
    designMode()
    syncMode()
  })

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return
    // The session composer is a contenteditable, not an input, so the checks
    // above let this fire in the middle of writing a prompt.
    if (event.target instanceof HTMLElement && event.target.isContentEditable) return
    if (event.key === "Escape") {
      if (popoverFor()) return setPopoverFor(null)
      if (designMode()) return setDesignMode(false)
    }
  }

  onMount(() => {
    window.addEventListener("keydown", onKeyDown)
    onCleanup(() => window.removeEventListener("keydown", onKeyDown))
  })

  // Registered rather than bound to `window` directly: a raw listener runs
  // alongside the command keymap instead of competing with it, so the chord it
  // took was also still cycling the model variant on every press.
  command.register("browser-visual-editor", () => [
    {
      id: "browser.designMode",
      title: language.t("command.browser.designMode"),
      description: language.t(
        designMode() ? "command.browser.designMode.on" : "command.browser.designMode.off",
      ),
      category: language.t("command.category.view"),
      keybind: "mod+shift+e",
      onSelect: () => setDesignMode((value) => !value),
    },
  ])

  /**
   * Inside a session the text is appended in place, keeping file, agent and image
   * parts. Without a prompt context (the desktop workbench) it is handed to
   * whichever composer is listening for the event.
   */
  const appendToPrompt = (text: string) => {
    if (prompt) return prompt.set(appendTextToPrompt(prompt.current(), text))
    window.dispatchEvent(new CustomEvent(VISUAL_EDITOR_PROMPT_EVENT, { detail: text }))
  }

  const sendSelection = (instruction?: string) => {
    const elements = selection()
    if (elements.length === 0) return
    const header = `[Design Mode · ${elements.length} element${elements.length > 1 ? "s" : ""} on ${url()}]`
    const body = elements.map(describeElement).join("\n")
    appendToPrompt(instruction ? `${header}\n${body}\n\n${instruction}\n` : `${header}\n${body}\n`)
    clearSelection()
    setDesignMode(false)
    showToast({
      variant: "success",
      title: "Sent to chat",
      description: `${elements.length} element${elements.length > 1 ? "s" : ""} attached to the session prompt.`,
    })
  }

  const clearSelection = () => {
    setSelection([])
    setPopoverFor(null)
    post({ type: "visual-editor:clear-selection" })
  }

  const removeSelected = (selector: string) => {
    const next = selection().filter((item) => item.selector !== selector)
    setSelection(next)
    if (popoverFor()?.selector === selector) setPopoverFor(null)
    post({ type: "visual-editor:clear-selection", selectors: next.map((item) => item.selector) })
  }

  const applyStyle = (property: string, value: string) => {
    const element = popoverFor() ?? selection().at(-1)
    if (!element) return
    post({ type: "visual-editor:apply-style", selector: element.selector, property, value })
  }

  const sendConsoleError = (log: ConsoleEntry) => {
    appendToPrompt(`[Browser console error on ${url()}]\n${log.message}\n\nFind the cause and fix it.\n`)
    showToast({ variant: "success", title: "Error sent to chat" })
  }

  /** Every error at once. The dedup and counting live in `console-digest`. */
  const sendAllConsoleErrors = () => {
    const digest = digestConsoleErrors(logs())
    if (!digest) return
    const plural = digest.distinct === 1 ? "" : "s"
    // Says what was left out. A truncated log presented as complete is how an
    // agent ends up confidently explaining an error that was not the cause.
    const omitted = digest.omitted > 0 ? ` (${digest.omitted} more not shown)` : ""
    appendToPrompt(
      `[Browser console — ${digest.distinct} distinct error${plural} on ${url()}${omitted}]\n` +
        `${digest.body}\n\n${language.t("browser.console.findCause")}\n`,
    )
    showToast({
      variant: "success",
      icon: "circle-check",
      title:
        digest.distinct === 1
          ? language.t("browser.console.sent.one")
          : language.t("browser.console.sent", { count: String(digest.distinct) }),
    })
  }

  const filteredLogs = () => {
    const filter = logFilter()
    if (filter === "error") return logs().filter((log) => log.level === "error")
    if (filter === "warn") return logs().filter((log) => log.level === "warn" || log.level === "error")
    return logs()
  }
  const errorCount = () => logs().filter((log) => log.level === "error").length

  const frameSize = () => {
    const preset = device()
    if (preset === "responsive") return undefined
    const { width, height } = DEVICES[preset]
    return landscape() ? { width: `${height}px`, height: `${width}px` } : { width: `${width}px`, height: `${height}px` }
  }

  // Wrapped in a keyed <Show> at the call site: reassigning an identical
  // `src`/`srcdoc` does not refetch, so reload has to recreate the node.
  const frame = () => (
    <iframe
      ref={iframeRef}
      src={srcdoc() ? undefined : url()}
      srcdoc={srcdoc() ?? undefined}
      class="w-full h-full flex-1 min-h-0 border-0 block bg-white"
      onLoad={onFrameLoad}
      sandbox="allow-same-origin allow-scripts allow-forms allow-popups allow-modals"
      title="Visual editor preview"
    />
  )

  const portButtons = (size: "inline" | "row") => (
    <For each={ports()}>
      {(port) => (
        <button
          type="button"
          class="px-1.5 text-10-medium rounded cursor-pointer shrink-0"
          classList={{
            "h-5": size === "inline",
            "h-6": size === "row",
            "bg-surface-base-active text-text-strong": address()?.port === port,
            "text-text-weak hover:text-text-strong": address()?.port !== port,
          }}
          onClick={() => switchPort(port)}
        >
          {port}
        </button>
      )}
    </For>
  )

  return (
    <div class="@container size-full flex flex-col flex-1 min-h-0 bg-background-base overflow-hidden">
      <div class="shrink-0 bg-surface-base border-b border-border-weak-base select-none">
        <div class="flex items-center gap-1 px-1.5 pt-1.5">
          <div class="flex items-center gap-0.5 shrink-0">
            <IconButton
              icon="arrow-left"
              variant="ghost"
              class="h-7 w-7"
              onClick={() => iframeRef?.contentWindow?.history.back()}
              aria-label="Back"
            />
            <IconButton
              icon="arrow-right"
              variant="ghost"
              class="h-7 w-7"
              onClick={() => iframeRef?.contentWindow?.history.forward()}
              aria-label="Forward"
            />
            <IconButton
              icon="arrow-down-to-line"
              variant="ghost"
              class="h-7 w-7"
              onClick={() => void load(url())}
              aria-label="Reload"
            />
          </div>

          <form
            class="flex-1 min-w-0 h-7 flex items-center bg-background-base border border-border-weak-base rounded-md px-2 gap-2 focus-within:border-border-base"
            onSubmit={(event) => {
              event.preventDefault()
              navigate(inputUrl())
            }}
          >
            <span
              class="size-1.5 rounded-full shrink-0"
              classList={{
                "bg-icon-success-base": state() === "ready",
                "bg-icon-warning-base": state() === "loading",
                "bg-icon-critical-base": state() === "unreachable",
                "bg-border-base": state() === "idle",
              }}
            />
            <input
              type="text"
              class="flex-1 min-w-0 bg-transparent text-13-regular text-text-strong focus:outline-none"
              value={inputUrl()}
              onInput={(event) => setInputUrl(event.currentTarget.value)}
              placeholder="localhost:3000"
              aria-label="Preview URL"
              spellcheck={false}
            />
            <div class="hidden @[22rem]:flex items-center gap-0.5 min-w-0 max-w-[42%] overflow-x-auto no-scrollbar border-l border-border-weak-base pl-1.5">
              {portButtons("inline")}
            </div>
          </form>

          <Show when={props.onClose}>
            <IconButton
              icon="close-small"
              variant="ghost"
              class="h-7 w-7 shrink-0"
              onClick={props.onClose}
              aria-label="Close"
            />
          </Show>
        </div>

        <div class="flex items-center gap-1 px-1.5 py-1.5 min-w-0 overflow-x-auto no-scrollbar">
          <button
            type="button"
            class="h-6 px-2 rounded-md text-11-medium flex items-center gap-1.5 cursor-pointer border transition-colors shrink-0"
            classList={{
              "bg-surface-brand-base text-text-on-brand-strong border-surface-brand-base": designMode(),
              "bg-surface-base text-text-weak border-border-weak-base hover:text-text-strong": !designMode(),
            }}
            aria-pressed={designMode()}
            onClick={() => setDesignMode((value) => !value)}
            title="Design mode — click elements to attach them to the chat (Ctrl+Shift+E)"
          >
            <Icon name="window-cursor" size="small" />
            <span>Design</span>
          </button>

          <IconButton
            icon="sliders"
            variant="ghost"
            class="h-6 w-6 shrink-0"
            classList={{ "text-text-strong": inspectorOpen() }}
            onClick={() => setInspectorOpen((value) => !value)}
            aria-label="Toggle inspector"
            aria-pressed={inspectorOpen()}
          />

          <Show when={worktreeOptions().length > 0}>
            <Select
              options={worktreeOptions()}
              current={worktreeOptions().find((item) => item.value === currentWorktree())}
              value={(item) => item.value}
              label={(item) => item.label}
              onSelect={(item) => item && switchWorktree(item.value)}
              variant="secondary"
              size="small"
              placeholder={language.t("visualEditor.worktree.label")}
              class="shrink-0 max-w-[11rem]"
            />
          </Show>

          {/* Narrow panes have no room for ports inside the URL bar. */}
          <div class="@[22rem]:hidden flex-1 min-w-0 overflow-x-auto no-scrollbar">
            <div class="flex items-center gap-0.5 w-max">{portButtons("row")}</div>
          </div>

          <div class="ml-auto flex items-center gap-1 min-w-0">
            <div class="flex items-center bg-surface-base rounded-md border border-border-weak-base p-0.5">
              <For each={["responsive", "tablet", "mobile"] as const}>
                {(preset) => (
                  <button
                    type="button"
                    class="px-1.5 h-5 rounded text-10-medium cursor-pointer transition-colors"
                    classList={{
                      "bg-surface-base-active text-text-strong": device() === preset,
                      "text-text-weak hover:text-text-strong": device() !== preset,
                    }}
                    onClick={() => setDevice(preset)}
                  >
                    {DEVICES[preset].label}
                  </button>
                )}
              </For>
              <Show when={device() !== "responsive"}>
                <button
                  type="button"
                  class="h-5 w-5 grid place-items-center rounded text-text-weak hover:text-text-strong cursor-pointer"
                  onClick={() => setLandscape((value) => !value)}
                  title="Rotate orientation"
                  aria-label="Rotate orientation"
                >
                  <Icon name="chevron-grabber-vertical" size="small" />
                </button>
              </Show>
            </div>

            <button
              type="button"
              class="h-6 px-2 rounded-md text-11-medium flex items-center gap-1 cursor-pointer border border-border-weak-base transition-colors shrink-0"
              classList={{
                "bg-surface-base-active text-text-strong": consoleOpen(),
                "bg-surface-base text-text-weak hover:text-text-strong": !consoleOpen(),
              }}
              onClick={() => setConsoleOpen((value) => !value)}
              title="Console"
              aria-pressed={consoleOpen()}
            >
              <Icon name="console" size="small" />
              <span class="hidden @[28rem]:inline">Logs</span>
              <Show when={errorCount() > 0}>
                <span class="px-1 rounded-full bg-surface-critical-strong text-text-critical-base font-mono text-10-bold">
                  {errorCount()}
                </span>
              </Show>
            </button>
          </div>
        </div>
      </div>

      {/* Only surfaced when fidelity is degraded: the fix is one script tag, and
          the user has no other way to discover it. */}
      <Show when={state() !== "unreachable" && (fidelity() === "mirror" || fidelity() === "none")}>
        <div class="px-2.5 py-1.5 bg-surface-base border-b border-border-weak-base flex items-center gap-2 shrink-0 text-11-regular text-text-weak min-w-0">
          <Icon name="window-cursor" size="small" class="shrink-0" />
          <span class="shrink-0 text-text-strong">
            {fidelity() === "mirror" ? "Mirrored copy" : "Not inspectable"}
          </span>
          <span class="min-w-0 truncate">
            {fidelity() === "mirror"
              ? "Client-side routing may misbehave. Add the bridge to inspect the page on its own origin."
              : "This page can't be read from here. Add the bridge to inspect it."}
          </span>
          <code class="hidden @md:block ml-auto shrink-0 max-w-72 truncate font-mono text-10-regular text-text-weak">
            {bridgeTag()}
          </code>
          <button
            type="button"
            class="ml-auto @md:ml-0 shrink-0 h-5 px-2 rounded border border-border-weak-base bg-surface-base text-10-medium text-text-strong cursor-pointer"
            onClick={() => {
              void navigator.clipboard?.writeText(bridgeTag())
              showToast({ variant: "success", title: "Snippet copied", description: "Paste it into your app's HTML." })
            }}
          >
            Copy
          </button>
        </div>
      </Show>

      <Show when={designMode() || selection().length > 0}>
        <div class="min-h-8 px-2 py-1 bg-surface-brand-base/25 border-b border-surface-brand-base flex items-center gap-2 shrink-0 flex-wrap">
          <Show
            when={selection().length > 0}
            fallback={
              <span class="text-11-regular text-text-weak min-w-0 truncate">
                <span class="hidden @md:inline">Click elements to attach them to the chat. Drag to reorder. Esc to exit.</span>
                <span class="@md:hidden">Click to attach, drag to reorder.</span>
              </span>
            }
          >
            <For each={selection()}>
              {(element) => (
                <span class="h-5 pl-1.5 pr-1 rounded bg-surface-base border border-border-weak-base flex items-center gap-1 font-mono text-10-medium text-text-strong">
                  {element.tagName}
                  <Show when={element.className}>
                    <span class="text-text-weak">.{element.className.split(/\s+/)[0]}</span>
                  </Show>
                  <IconButton
                    icon="close-small"
                    variant="ghost"
                    class="h-3.5 w-3.5"
                    onClick={() => removeSelected(element.selector)}
                    aria-label={`Remove ${element.tagName}`}
                  />
                </span>
              )}
            </For>
            <div class="ml-auto flex items-center gap-1.5">
              <button
                type="button"
                class="text-11-regular text-text-weak hover:text-text-strong cursor-pointer"
                onClick={clearSelection}
              >
                Clear
              </button>
              <button
                type="button"
                class="h-5 px-2 rounded bg-surface-brand-base text-text-on-brand-strong text-11-medium cursor-pointer"
                onClick={() => sendSelection()}
              >
                Send {selection().length} to chat
              </button>
            </div>
          </Show>
        </div>
      </Show>

      <div class="flex-1 min-h-0 flex overflow-hidden">
        <div class="flex-1 min-w-0 min-h-0 relative flex flex-col overflow-hidden">
          <Show when={loadToken()} keyed>
            {(_token: number) => (
              <Show
                when={device() === "responsive"}
                fallback={
                  <div class="flex-1 min-h-0 flex items-center justify-center p-3 overflow-auto bg-surface-base">
                    <div
                      class="bg-white rounded-lg border border-border-weak-base overflow-hidden shadow-md flex flex-col shrink-0 max-w-full max-h-full"
                      style={frameSize()}
                    >
                      {frame()}
                    </div>
                  </div>
                }
              >
                {frame()}
              </Show>
            )}
          </Show>

          <Show when={state() === "unreachable"}>
            <div class="absolute inset-0 bg-background-base flex flex-col items-center justify-center gap-3 text-center px-6">
              <Icon name="window-cursor" size="large" />
              <div class="text-14-medium text-text-strong">Can't reach {url()}</div>
              <div class="text-13-regular text-text-weak max-w-80">
                {loadError()}. Start your dev server, then reload. Design mode needs a same-origin page to inspect
                elements.
              </div>
              <div class="flex items-center gap-1.5 flex-wrap justify-center">
                <For each={COMMON_PORTS}>
                  {(port) => (
                    <button
                      type="button"
                      class="h-6 px-2 rounded-md border border-border-weak-base bg-surface-base text-11-medium text-text-weak hover:text-text-strong cursor-pointer"
                      onClick={() => switchPort(port)}
                    >
                      :{port}
                    </button>
                  )}
                </For>
                <button
                  type="button"
                  class="h-6 px-2 rounded-md bg-surface-brand-base text-text-on-brand-strong text-11-medium cursor-pointer"
                  onClick={() => void load(url())}
                >
                  Reload
                </button>
              </div>
            </div>
          </Show>

          <Show when={popoverFor()}>
            {(element) => (
              <PointPromptPopover
                element={toHostSpace(element())}
                onClose={() => setPopoverFor(null)}
                onSubmitPrompt={(text) => sendSelection(text)}
                onQuickAction={(action) => sendSelection(QUICK_ACTION_PROMPTS[action] ?? action)}
              />
            )}
          </Show>
        </div>

        <Show when={inspectorOpen()}>
          <VisualControlsSidebar
            element={popoverFor() ?? selection().at(-1) ?? null}
            onApplyStyle={applyStyle}
            onReorderElement={(direction) =>
              appendToPrompt(`[Design Mode · layout] Move the selected element one position ${direction}.\n`)
            }
            onApplyToCode={(element, changes) => {
              const patch = Object.entries(changes)
                .map(([property, value]) => `   ${property}: ${value}`)
                .join("\n")
              if (!patch) return
              // The changes were staged against this one element, so describe
              // only it. Routing them through `sendSelection` attached them to
              // every element in the multi-select instead.
              appendToPrompt(
                `[Design Mode · ${url()}]\n${describeElement(element, 0)}\n` +
                  `Apply these style changes to the source:\n${patch}\n`,
              )
              showToast({ variant: "success", title: "Style changes sent to chat" })
            }}
            onClose={() => setInspectorOpen(false)}
          />
        </Show>
      </div>

      <Show when={consoleOpen()}>
        <div class="h-36 @md:h-44 max-h-[38%] min-h-28 bg-surface-base border-t border-border-weak-base flex flex-col shrink-0 overflow-hidden">
          <div class="h-7 px-2 @md:px-3 bg-surface-base border-b border-border-weak-base flex items-center justify-between gap-2 min-w-0 shrink-0">
            <div class="flex items-center gap-2 min-w-0">
              <span class="text-11-semibold text-text-strong shrink-0">Console</span>
              <Show when={errorCount() > 0}>
                <button
                  type="button"
                  class="px-2 rounded cursor-pointer text-10-medium text-text-base hover:text-text-strong underline underline-offset-2 shrink-0"
                  onClick={sendAllConsoleErrors}
                >
                  {language.t("browser.console.sendAll")}
                </button>
              </Show>
              <div class="flex gap-0.5">
                <For each={["all", "error", "warn"] as const}>
                  {(filter) => (
                    <button
                      type="button"
                      class="px-1.5 h-5 rounded capitalize cursor-pointer text-10-medium"
                      classList={{
                        "bg-surface-base-active text-text-strong": logFilter() === filter,
                        "text-text-weak hover:text-text-strong": logFilter() !== filter,
                      }}
                      onClick={() => setLogFilter(filter)}
                    >
                      {filter}
                    </button>
                  )}
                </For>
              </div>
            </div>
            <div class="flex items-center gap-1 shrink-0">
              <button
                type="button"
                class="text-10-regular text-text-weak hover:text-text-strong cursor-pointer px-1"
                onClick={() => setLogs([])}
              >
                Clear
              </button>
              <IconButton
                icon="close-small"
                variant="ghost"
                class="h-5 w-5"
                onClick={() => setConsoleOpen(false)}
                aria-label="Close console"
              />
            </div>
          </div>

          <div class="flex-1 overflow-y-auto p-2 font-mono text-11-regular flex flex-col gap-1">
            <Show
              when={filteredLogs().length > 0}
              fallback={<div class="text-text-weak p-2 text-11-regular">No console output captured yet.</div>}
            >
              <For each={filteredLogs()}>
                {(log) => (
                  <div
                    class="px-2 py-1 rounded flex items-start justify-between gap-2"
                    classList={{
                      "bg-surface-critical-base text-text-critical-base": log.level === "error",
                      "bg-surface-warning-base text-text-warning-base": log.level === "warn",
                      "bg-surface-base text-text-strong": log.level === "log" || log.level === "info",
                    }}
                  >
                    <div class="flex items-start gap-2 min-w-0 flex-1">
                      <span class="uppercase text-10-bold opacity-75 shrink-0">[{log.level}]</span>
                      <span class="break-all whitespace-pre-wrap">{log.message}</span>
                    </div>
                    <Show when={log.level === "error"}>
                      <button
                        type="button"
                        class="px-1.5 rounded bg-icon-critical-hover text-white text-10-medium shrink-0 hover:bg-icon-critical-active cursor-pointer"
                        onClick={() => sendConsoleError(log)}
                        title="Send this error to the agent"
                      >
                        <span class="hidden @md:inline">Ask agent</span>
                        <span class="@md:hidden">Fix</span>
                      </button>
                    </Show>
                  </div>
                )}
              </For>
            </Show>
          </div>
        </div>
      </Show>
    </div>
  )
}
