import { For, Show, createMemo, createSignal, onMount } from "solid-js"
import type { AgentOption } from "../session-new/agents"
import { Overlay, Surface } from "../ui/layout"
import {
  addedLabel,
  billingWarning,
  envProblem,
  nameProblem,
  suggestEnv,
  valueProblem,
  type KeyDraft,
  type KeyInfo,
} from "./keys"
import "./keys.css"
import { t } from "../i18n"

/** What the section and the request dialog need from the host. */
export interface KeysHost {
  list: () => Promise<KeyInfo[]>
  save: (draft: KeyDraft) => Promise<void>
  remove: (name: string) => Promise<void>
  copy: (name: string) => Promise<number>
}

const message = (failure: unknown) => (failure instanceof Error ? failure.message : String(failure))

/**
 * Impostazioni › Chiavi API.
 *
 * Every key the user keeps: its name, the variable it becomes, the agents it
 * goes to, and the last four characters. Adding one takes the value once, in
 * a password field that is emptied as soon as the keychain has it; after that
 * the page can only copy it (the host writes the clipboard) or delete it.
 */
export function KeysSection(props: { host: KeysHost | undefined; agents: readonly AgentOption[] }) {
  const [keys, setKeys] = createSignal<KeyInfo[]>([])
  const [loadProblem, setLoadProblem] = createSignal<string>()
  const [editing, setEditing] = createSignal<string | "new">()
  const [notice, setNotice] = createSignal<string>()
  const [confirming, setConfirming] = createSignal<string>()

  const refresh = async () => {
    if (!props.host) return
    try {
      setKeys(await props.host.list())
      setLoadProblem(undefined)
    } catch (failure) {
      setLoadProblem(message(failure))
    }
  }
  onMount(() => void refresh())

  const agentLabel = (id: string) => props.agents.find((agent) => agent.id === id)?.label ?? id

  return (
    <>
      <div data-slot="section-head">
        <h3 data-slot="section-title" tabIndex={-1}>
          {t("settings.keys")}
        </h3>
        <p data-slot="section-desc">{t("keys.desc")}</p>
      </div>

      <Show when={!props.host}>
        <p data-slot="section-desc">{t("keys.noKeychain")}</p>
      </Show>
      <Show when={loadProblem()}>
        <p data-slot="keys-problem" role="alert">
          {loadProblem()}
        </p>
      </Show>
      <Show when={notice()}>
        <p data-slot="keys-notice" role="status">
          {notice()}
        </p>
      </Show>

      <Show when={props.host}>
        <Show when={keys().length > 0} fallback={<p data-slot="settings-meta">{t("keys.none")}</p>}>
          <ul data-slot="settings-list">
            <For each={keys()}>
              {(key) => (
                <li data-slot="keys-row">
                  <Show
                    when={editing() === key.name}
                    fallback={
                      <>
                        <div data-slot="keys-head">
                          <span data-slot="settings-name">{key.name}</span>
                          <code data-slot="keys-env">{key.env}</code>
                          <span data-slot="keys-masked" aria-label={t("keys.hidden")}>
                            {key.masked ?? t("keys.missingValue")}
                          </span>
                        </div>
                        <div data-slot="keys-meta">
                          <span>
                            {key.agents.length > 0
                              ? t("keys.agents", key.agents.map(agentLabel).join(", "))
                              : t("keys.agents.none")}
                          </span>
                          <span>{addedLabel(key.createdMs, Date.now())}</span>
                        </div>
                        <For each={key.agents}>
                          {(agent) => (
                            <Show when={billingWarning(key.env, agent)}>
                              <span data-slot="keys-warning">{billingWarning(key.env, agent)}</span>
                            </Show>
                          )}
                        </For>
                        <div data-slot="keys-actions">
                          <button
                            type="button"
                            data-slot="settings-choice"
                            disabled={!key.masked}
                            onClick={() =>
                              void props.host!.copy(key.name).then(
                                (seconds) => setNotice(t("keys.copied", key.name, seconds)),
                                (failure) => setNotice(message(failure)),
                              )
                            }
                          >
                            {t("keys.copy")}
                          </button>
                          <button type="button" data-slot="settings-choice" onClick={() => setEditing(key.name)}>
                            {t("keys.edit")}
                          </button>
                          <Show
                            when={confirming() === key.name}
                            fallback={
                              <button type="button" data-slot="settings-choice" onClick={() => setConfirming(key.name)}>
                                {t("keys.delete")}
                              </button>
                            }
                          >
                            <button
                              type="button"
                              data-slot="settings-choice"
                              data-danger="true"
                              onClick={() =>
                                void props.host!.remove(key.name).then(
                                  () => {
                                    setConfirming(undefined)
                                    setNotice(t("keys.deleted", key.name))
                                    void refresh()
                                  },
                                  (failure) => setNotice(message(failure)),
                                )
                              }
                            >
                              {t("keys.delete.confirm")}
                            </button>
                            <button type="button" data-slot="settings-choice" onClick={() => setConfirming(undefined)}>
                              {t("new.cancel")}
                            </button>
                          </Show>
                        </div>
                      </>
                    }
                  >
                    <KeyForm
                      host={props.host!}
                      agents={props.agents}
                      existing={key}
                      others={keys()}
                      onDone={(saved) => {
                        setEditing(undefined)
                        if (saved) {
                          setNotice(t("keys.updated", saved))
                          void refresh()
                        }
                      }}
                    />
                  </Show>
                </li>
              )}
            </For>
          </ul>
        </Show>

        <Show
          when={editing() === "new"}
          fallback={
            <div data-slot="settings-choices">
              <button type="button" data-slot="settings-choice" onClick={() => setEditing("new")}>
                {t("keys.add")}
              </button>
            </div>
          }
        >
          <div data-slot="keys-row">
            <KeyForm
              host={props.host!}
              agents={props.agents}
              others={keys()}
              onDone={(saved) => {
                setEditing(undefined)
                if (saved) {
                  setNotice(t("keys.saved", saved))
                  void refresh()
                }
              }}
            />
          </div>
        </Show>
      </Show>
    </>
  )
}

/**
 * Adding or editing one key. Editing leaves the value alone unless a new one
 * is pasted; the field is cleared the moment the save returns.
 */
export function KeyForm(props: {
  host: KeysHost
  agents: readonly AgentOption[]
  existing?: KeyInfo
  others: readonly KeyInfo[]
  initialEnv?: string
  initialAgents?: readonly string[]
  onDone: (savedName: string | undefined) => void
}) {
  const [name, setName] = createSignal(props.existing?.name ?? "")
  const [env, setEnv] = createSignal(props.existing?.env ?? props.initialEnv ?? "")
  const [envTouched, setEnvTouched] = createSignal(Boolean(props.existing || props.initialEnv))
  const [agents, setAgents] = createSignal<readonly string[]>(props.existing?.agents ?? props.initialAgents ?? [])
  const [busy, setBusy] = createSignal(false)
  const [problem, setProblem] = createSignal<string>()
  let valueField: HTMLInputElement | undefined
  let nameField: HTMLInputElement | undefined

  onMount(() => (props.existing ? valueField : nameField)?.focus())

  const effectiveEnv = () => (envTouched() ? env() : suggestEnv(name()))
  const toggle = (id: string) =>
    setAgents((current) => (current.includes(id) ? current.filter((agent) => agent !== id) : [...current, id]))
  const warnings = createMemo(() =>
    agents()
      .map((agent) => billingWarning(effectiveEnv(), agent))
      .filter(Boolean),
  )

  const submit = async (event: Event) => {
    event.preventDefault()
    const value = valueField?.value ?? ""
    const problems = [
      props.existing ? undefined : nameProblem(name()),
      envProblem(effectiveEnv(), props.others, props.existing?.name ?? name()),
      props.existing && value === "" ? undefined : valueProblem(value),
    ].filter(Boolean)
    if (problems.length > 0) {
      setProblem(problems[0])
      return
    }
    setBusy(true)
    setProblem(undefined)
    try {
      const saved = (props.existing?.name ?? name()).trim()
      await props.host.save({
        name: saved,
        env: effectiveEnv().trim(),
        agents: agents(),
        ...(value ? { value } : {}),
      })
      if (valueField) valueField.value = ""
      props.onDone(saved)
    } catch (failure) {
      setProblem(message(failure))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form data-slot="keys-form" onSubmit={(event) => void submit(event)} autocomplete="off">
      <label data-slot="keys-field">
        <span>{t("keys.field.name")}</span>
        <input
          ref={nameField}
          type="text"
          value={name()}
          disabled={Boolean(props.existing)}
          placeholder={t("keys.field.name.example")}
          spellcheck={false}
          onInput={(event) => setName(event.currentTarget.value)}
        />
      </label>
      <label data-slot="keys-field">
        <span>{t("keys.field.env")}</span>
        <input
          type="text"
          value={effectiveEnv()}
          placeholder="OPENAI_API_KEY"
          spellcheck={false}
          onInput={(event) => {
            setEnvTouched(true)
            setEnv(event.currentTarget.value.toUpperCase())
          }}
        />
      </label>
      <label data-slot="keys-field">
        <span>{props.existing ? t("keys.field.newValue") : t("keys.field.value")}</span>
        <input
          ref={valueField}
          type="password"
          placeholder={props.existing ? (props.existing.masked ?? "") : t("keys.field.paste")}
          spellcheck={false}
          autocomplete="new-password"
        />
      </label>
      <fieldset data-slot="keys-agents">
        <legend>{t("keys.field.agents")}</legend>
        <For each={props.agents}>
          {(agent) => (
            <label data-slot="keys-agent">
              <input type="checkbox" checked={agents().includes(agent.id)} onChange={() => toggle(agent.id)} />
              {agent.label}
            </label>
          )}
        </For>
      </fieldset>
      <For each={warnings()}>{(warning) => <span data-slot="keys-warning">{warning}</span>}</For>
      <Show when={problem()}>
        <p data-slot="keys-problem" role="alert">
          {problem()}
        </p>
      </Show>
      <div data-slot="keys-actions">
        <button type="submit" data-slot="settings-choice" data-active="true" disabled={busy()}>
          {busy() ? t("keys.saving") : t("keys.save")}
        </button>
        <button type="button" data-slot="settings-choice" disabled={busy()} onClick={() => props.onDone(undefined)}>
          {t("new.cancel")}
        </button>
      </div>
    </form>
  )
}

/**
 * An agent asked for a key (`@ade keys ask ENV motivo`): the same form, with
 * the variable filled in and the reason shown. Never opens a second time for
 * the same request while one is on screen.
 */
export function KeyRequestDialog(props: {
  host: KeysHost
  agents: readonly AgentOption[]
  env: string
  reason: string
  onClose: (savedName: string | undefined) => void
}) {
  const [keys, setKeys] = createSignal<KeyInfo[]>([])
  onMount(() => void props.host.list().then(setKeys, () => undefined))
  const existing = () => keys().find((key) => key.env === props.env)

  return (
    <Overlay data-component="key-request" onClose={() => props.onClose(undefined)}>
      <Surface
        size="md"
        role="dialog"
        aria-modal="true"
        aria-label={t("keys.request")}
        onKeyDown={(event: KeyboardEvent) => {
          if (event.key === "Escape") props.onClose(undefined)
        }}
      >
        <header data-slot="keys-dialog-head">
          <strong>{t("keys.request.title", props.env)}</strong>
          <Show when={props.reason}>
            <span>«{props.reason}»</span>
          </Show>
          <span>{t("keys.request.hint")}</span>
        </header>
        <div data-slot="keys-dialog-body">
          <Show
            when={existing()}
            keyed
            fallback={
              <KeyForm
                host={props.host}
                agents={props.agents}
                others={keys()}
                initialEnv={props.env}
                onDone={props.onClose}
              />
            }
          >
            {(key) => (
              <KeyForm host={props.host} agents={props.agents} existing={key} others={keys()} onDone={props.onClose} />
            )}
          </Show>
        </div>
      </Surface>
    </Overlay>
  )
}
