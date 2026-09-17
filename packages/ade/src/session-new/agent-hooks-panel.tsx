import { For, Show, createSignal } from "solid-js"
import { HOOK_TARGETS, type HookStatus, type HookHost, setHook } from "./agent-hooks"
import { t } from "../i18n"

/**
 * The settings section for "let the CLI tell ADE which conversation it opened".
 *
 * This is the one feature in ADE that writes into files belonging to another
 * program, so the panel is the feature: nothing is installed until the user
 * presses the button, both paths that will change are printed in full before
 * they change, and removal is one press away and puts the file back exactly
 * as it was.
 *
 * What it buys is in `agent-link.ts`. The short version, and the version the
 * panel tells the user: codex has no way to be told which conversation to
 * open, so without this a restored codex pane can only ask for "the last
 * conversation" — which is the wrong one as soon as there are two panes.
 */

export interface AgentHooksSectionProps {
  /** The host, for the two commands that touch the files. */
  host: HookHost
  /** Current state per agent id, from the workbench. */
  states: Record<string, HookStatus>
  /** Called after a change, so the workbench can re-read. */
  onChanged: () => void
}

export function AgentHooksSection(props: AgentHooksSectionProps) {
  /* Which row has a command in flight, so its buttons can go quiet. */
  const [busy, setBusy] = createSignal<string | undefined>()
  const [failure, setFailure] = createSignal<string | undefined>()

  const apply = async (id: string, install: boolean) => {
    const target = HOOK_TARGETS.find((entry) => entry.id === id)
    if (!target) return
    setBusy(id)
    setFailure(undefined)
    try {
      await setHook(props.host, target, install)
      props.onChanged()
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(undefined)
    }
  }

  return (
    <>
      <div data-slot="section-head">
        <h3 data-slot="section-title" tabIndex={-1}>
          {t("hooks.title")}
        </h3>
        <p data-slot="section-desc">{t("hooks.desc")}</p>
      </div>

      <p data-slot="section-desc">{t("hooks.files")}</p>

      <ul data-slot="hook-list">
        <For each={HOOK_TARGETS}>
          {(target) => {
            const state = () => props.states[target.id]
            const working = () => busy() === target.id
            return (
              <li data-slot="hook-row">
                <div data-slot="hook-row-head">
                  <span data-slot="hook-name">{target.label}</span>
                  <span
                    data-slot="hook-state"
                    data-on={state()?.installed ? "true" : undefined}
                    data-broken={state()?.broken ? "true" : undefined}
                  >
                    {state()?.error
                      ? t("hooks.state.unavailable")
                      : state()?.installed
                        ? t("hooks.state.on")
                        : state()?.broken
                          ? t("hooks.state.broken")
                          : t("hooks.state.off")}
                  </span>
                </div>

                <Show when={state()?.broken}>
                  <p data-slot="hook-note">{t("hooks.broken")}</p>
                </Show>

                <Show when={state() && !state()?.error}>
                  <p data-slot="hook-paths">
                    <code>{state()?.configPath}</code>
                    <code>{state()?.scriptPath}</code>
                  </p>
                </Show>

                <Show when={state()?.error}>
                  <p data-slot="hook-note">{state()?.error}</p>
                </Show>

                <div data-slot="hook-actions">
                  <button
                    type="button"
                    data-slot="hook-action"
                    disabled={working() || Boolean(state()?.error)}
                    onClick={() => void apply(target.id, true)}
                  >
                    {state()?.installed ? t("hooks.reinstall") : t("hooks.install")}
                  </button>
                  <Show when={state()?.installed || state()?.broken}>
                    <button
                      type="button"
                      data-slot="hook-action"
                      disabled={working()}
                      onClick={() => void apply(target.id, false)}
                    >
                      {t("hooks.remove")}
                    </button>
                  </Show>
                </div>
              </li>
            )
          }}
        </For>
      </ul>

      <Show when={failure()}>
        <p data-slot="hook-note">{failure()}</p>
      </Show>

      <p data-slot="section-desc">{t("hooks.outside")}</p>
    </>
  )
}
