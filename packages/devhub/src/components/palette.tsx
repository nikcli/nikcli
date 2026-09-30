import { shortcut } from "../lib/platform"
import { For, Show, createEffect, createMemo, createSignal } from "solid-js"
import { Icon, type IconProps } from "@nikcli-ai/ui/icon"
import { assistant } from "../lib/assistant"
import { app } from "../lib/store"
import type { PageId } from "../lib/actions"

export type Command = { id: string; label: string; hint?: string; icon: IconProps["name"]; run: () => void }

const score = (q: string, text: string) => {
  if (!q) return 1
  const t = text.toLowerCase()
  const i = t.indexOf(q)
  if (i >= 0) return 100 - i
  let p = 0
  for (const ch of q) {
    p = t.indexOf(ch, p)
    if (p < 0) return 0
    p++
  }
  return 10
}

export function Palette(props: { open: boolean; onClose: () => void; go: (p: PageId) => void }) {
  const [q, setQ] = createSignal("")
  const [idx, setIdx] = createSignal(0)
  let input: HTMLInputElement | undefined
  const PAGES: [PageId, string, IconProps["name"]][] = [
    ["overview", "Overview", "layout-left"],
    ["processes", "Processes", "server"],
    ["tests", "Tests", "checklist"],
    ["benchmarks", "Benchmarks", "task"],
    ["playground", "Playground", "models"],
    ["telemetry", "Telemetry", "dot-grid"],
    ["manage", "Manage", "sliders"],
    ["api", "API console", "code"],
    ["activity", "Activity", "bubble-5"],
    ["system", "System", "server"],
    ["settings", "Settings", "settings-gear"],
  ]
  const commands = createMemo<Command[]>(() => [
    ...PAGES.map(
      ([id, label, icon], i): Command => ({
        id: `go:${id}`,
        label: `Go to ${label}`,
        hint: id === "settings" ? shortcut(",") : i < 9 ? shortcut(String(i + 1)) : undefined,
        icon,
        run: () => props.go(id),
      }),
    ),
    {
      id: "assistant",
      label: "Toggle assistant",
      hint: shortcut("J"),
      icon: "speech-bubble",
      run: () => assistant.toggle(),
    },
    {
      id: "new-chat",
      label: "New assistant chat",
      icon: "plus-small",
      run: () => (assistant.reset(), assistant.setOpen(true)),
    },
    {
      id: "sample",
      label: "Sample system now",
      hint: shortcut("R"),
      icon: "arrow-right",
      run: () => void app.refreshNow(),
    },
    {
      id: "pause",
      label: app.paused() ? "Resume live sampling" : "Pause live sampling",
      icon: "stop",
      run: () => app.setPaused(!app.paused()),
    },
    ...app.services().map(
      (s): Command => ({
        id: `svc:${s.url}`,
        label: `Use service ${s.channel} · ${s.url}${s.alive ? "" : " (stopped)"}`,
        icon: "server",
        run: () => app.select(s.url),
      }),
    ),
  ])
  const list = createMemo(() => {
    const needle = q().trim().toLowerCase()
    return commands()
      .map((c) => ({ c, s: score(needle, c.label) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s)
      .map((x) => x.c)
  })
  createEffect(() => {
    if (props.open) {
      setQ("")
      setIdx(0)
      queueMicrotask(() => input?.focus())
    }
  })
  createEffect(() => list().length < idx() + 1 && setIdx(0))
  const exec = (c?: Command) => {
    if (!c) return
    props.onClose()
    c.run()
  }
  return (
    <Show when={props.open}>
      <div class="dh-palette-scrim" onMouseDown={props.onClose}>
        <div class="dh-palette" role="dialog" aria-label="Command palette" onMouseDown={(e) => e.stopPropagation()}>
          <input
            ref={input}
            placeholder="Type a command or page…"
            value={q()}
            onInput={(e) => (setQ(e.currentTarget.value), setIdx(0))}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") (e.preventDefault(), setIdx((i) => Math.min(i + 1, list().length - 1)))
              else if (e.key === "ArrowUp") (e.preventDefault(), setIdx((i) => Math.max(i - 1, 0)))
              else if (e.key === "Enter") exec(list()[idx()])
              else if (e.key === "Escape") props.onClose()
            }}
          />
          <div class="dh-palette__list">
            <For each={list()} fallback={<div class="dh-empty">No matching command</div>}>
              {(c, i) => (
                <button data-active={i() === idx()} onMouseEnter={() => setIdx(i())} onClick={() => exec(c)}>
                  <Icon name={c.icon} size="small" />
                  <span>{c.label}</span>
                  <Show when={c.hint}>
                    <kbd>{c.hint}</kbd>
                  </Show>
                </button>
              )}
            </For>
          </div>
        </div>
      </div>
    </Show>
  )
}
