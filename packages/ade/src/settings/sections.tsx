import { For, Show, createMemo, createSignal, onMount } from "solid-js"
import type { AgentFile } from "../bots/nikcli"
import { providerState, type ProviderState } from "../bots/providers"
import { RUNNERS, type Runner } from "../bots/runners"
import { listBots, resolveRoots } from "../bots/store"
import { MAX_PARALLEL_TURNS } from "../bots/terms"
import {
  LOCALE_PREFERENCES,
  locale,
  localePreference,
  setLocalePreference,
  t,
  type LocalePreference,
} from "../i18n"
import "./sections.css"

/**
 * ADE's own screens inside the settings panel.
 *
 * The panel itself is `VoiceSettingsPanel`, which owns the shell, the rail
 * and the modal chrome. It began as the voice panel and grew a slot for the
 * host's screens; these are those screens. The voice sections keep their own
 * heading in the rail, so "Voce" reads as one part of the list rather than
 * as the list with six strangers appended.
 *
 * Two of these are real and four are not yet, and the ones that are not say
 * so in as many words. A settings screen that shows plausible-looking
 * controls doing nothing is worse than an empty one: the user changes a
 * setting, nothing happens, and they have no way to tell whether the feature
 * is broken or absent.
 */

/**
 * A section whose feature does not exist yet.
 *
 * Kept deliberately plain — no disabled toggles, no greyed-out fields. It
 * names what belongs here and where the nearest working thing is, and that
 * is the whole content.
 */
export function NotBuiltYet(props: { title: string; what: string; instead?: string }) {
  return (
    <>
      <div data-slot="section-head">
        <h3 data-slot="section-title" tabIndex={-1}>
          {props.title}
        </h3>
        <p data-slot="section-desc">{props.what}</p>
      </div>
      <p data-slot="settings-empty">
        {t("settings.notBuilt")}
        <Show when={props.instead}>{(instead) => <> {instead()}</>}</Show>
      </p>
    </>
  )
}

/** Automations: a thing ADE runs on its own, on a schedule or on an event. */
export function RoutineSection() {
  return (
    <NotBuiltYet
      title={t("settings.routine")}
      what={t("settings.routine.desc")}
      instead={t("settings.routine.instead")}
    />
  )
}

export interface BotSectionProps {
  /** The open project, so project bots are listed as well as global ones. */
  projectRoot?: string
}

/**
 * The bots, as configuration rather than as a place to talk to them.
 *
 * Read-only on purpose, and read from the same place nikcli reads: a bot is an
 * agent file under `.nikcli/agent/` or in nikcli's global configuration, so
 * this is a view of that directory rather than of a roster ADE keeps. They are
 * created and edited in the Bot view.
 */
export function BotSection(props: BotSectionProps) {
  const [roster, setRoster] = createSignal<AgentFile[]>([])
  const [ready, setReady] = createSignal(false)

  /*
   * Read once, when the section mounts.
   *
   * Two directories and a file read each, which is not something to repeat on
   * every unrelated redraw — and the panel is opened fresh each time, so once
   * is also current.
   */
  onMount(() => {
    void resolveRoots(props.projectRoot)
      .then(listBots)
      .then(setRoster)
      .finally(() => setReady(true))
  })

  return (
    <>
      <div data-slot="section-head">
        <h3 data-slot="section-title" tabIndex={-1}>
          Bot
        </h3>
        <p data-slot="section-desc">
          Gli agenti di nikcli che questa macchina conosce: con quale modello girano, e se
          appartengono al progetto o a tutti. Si creano e si modificano nella vista Bot.
        </p>
      </div>

      <Show
        when={roster().length > 0}
        fallback={
          <p data-slot="settings-empty">
            {ready()
              ? "Nessun agente nikcli. Se ne crea uno dalla vista Bot."
              : "Lettura delle cartelle di nikcli…"}
          </p>
        }
      >
        <ul data-slot="settings-list">
          <For each={roster()}>
            {(bot) => (
              <li data-slot="settings-row">
                <span data-slot="settings-glyph" aria-hidden="true">
                  {bot.identifier.slice(0, 1).toUpperCase()}
                </span>
                <span data-slot="settings-name">{bot.identifier}</span>
                <span data-slot="settings-meta">{bot.model ?? "modello di nikcli"}</span>
                <span data-slot="settings-meta">
                  {bot.scope === "project" ? "progetto" : "globale"}
                </span>
              </li>
            )}
          </For>
        </ul>
      </Show>
    </>
  )
}

export interface SkillsSectionProps {
  projectRoot?: string
}

/**
 * The tools the bots are allowed, seen from the side of who uses them.
 *
 * nikcli's agents do not carry "skills"; they carry a tool list, and what a
 * file records is the tools that have been switched *off*. So the honest
 * reading is per-bot: which ones each has given up. A catalogue of everything
 * nikcli can do belongs to nikcli, and inventing one here would be a list ADE
 * cannot keep in step.
 */
export function SkillsSection(props: SkillsSectionProps) {
  const [roster, setRoster] = createSignal<AgentFile[]>([])
  onMount(() => {
    void resolveRoots(props.projectRoot).then(listBots).then(setRoster)
  })

  const restricted = createMemo(() => roster().filter((bot) => bot.disabledTools.length > 0))

  return (
    <>
      <div data-slot="section-head">
        <h3 data-slot="section-title" tabIndex={-1}>
          Strumenti
        </h3>
        <p data-slot="section-desc">
          Quali strumenti sono stati tolti a un bot. Chi non compare qui li ha tutti: nikcli
          registra nel file solo le rinunce.
        </p>
      </div>

      <Show
        when={restricted().length > 0}
        fallback={
          <p data-slot="settings-empty">
            Nessun bot ha limitazioni: tutti possono usare ogni strumento di nikcli.
          </p>
        }
      >
        <ul data-slot="settings-list">
          <For each={restricted()}>
            {(bot) => (
              <li data-slot="settings-row">
                <span data-slot="settings-name">{bot.identifier}</span>
                <span data-slot="settings-meta">senza {bot.disabledTools.join(", ")}</span>
              </li>
            )}
          </For>
        </ul>
      </Show>
    </>
  )
}

export interface LanguageSectionProps {
  /** Defaults to the app's own state; a test passes its own to watch the choice. */
  value?: () => LocalePreference
  onChange?: (next: LocalePreference) => void
}

/**
 * Which language ADE's interface speaks (S41).
 *
 * Three choices rather than two: "System" is what a fresh install uses, and
 * showing it with the language it resolves to answers "why is this English?"
 * without a trip to the OS settings. Each language is named in itself, so a
 * person who cannot read the current one still finds their own.
 */
export function LanguageSection(props: LanguageSectionProps) {
  const value = () => (props.value ?? localePreference)()
  const choose = (next: LocalePreference) => (props.onChange ?? setLocalePreference)(next)
  const label = (choice: LocalePreference) =>
    choice === "system"
      ? t("settings.language.systemNow", t(locale() === "it" ? "settings.language.it" : "settings.language.en"))
      : t(choice === "it" ? "settings.language.it" : "settings.language.en")

  return (
    <>
      <div data-slot="section-head">
        <h3 data-slot="section-title" tabIndex={-1}>
          {t("settings.language.title")}
        </h3>
        <p data-slot="section-desc">{t("settings.language.desc")}</p>
      </div>

      <div data-slot="settings-choices" role="group" aria-label={t("settings.language.group")}>
        <For each={LOCALE_PREFERENCES}>
          {(choice) => (
            <button
              type="button"
              data-slot="settings-choice"
              data-locale={choice}
              data-active={value() === choice ? "true" : undefined}
              aria-pressed={value() === choice}
              lang={choice === "system" ? undefined : choice}
              onClick={() => choose(choice)}
            >
              {label(choice)}
            </button>
          )}
        </For>
      </div>
    </>
  )
}

/** The pinned column count, and `undefined` for "let the grid decide". */
export const GRID_COLUMN_CHOICES: readonly (number | undefined)[] = [undefined, 1, 2, 3, 4]

export interface GridSectionProps {
  /** What the workbench has pinned, or `undefined` for automatic. */
  columns: number | undefined
  onChange: (columns: number | undefined) => void
}

/**
 * How the session grid is laid out.
 *
 * This used to be five chips on the right of the top bar, shown only in the
 * `code` view. It is configuration — a thing set once and then left alone —
 * and the bar is where the verbs live, so it kept a permanent seat beside
 * them for a decision nobody makes twice a session. Here it costs nothing
 * when it is not wanted, and it says what "auto" actually does, which five
 * chips in a toolbar had no room to.
 */
export function GridSection(props: GridSectionProps) {
  return (
    <>
      <div data-slot="section-head">
        <h3 data-slot="section-title" tabIndex={-1}>
          {t("settings.grid.title")}
        </h3>
        <p data-slot="section-desc">
          {t("settings.grid.desc")}
        </p>
      </div>

      <div data-slot="settings-choices" role="group" aria-label={t("settings.grid.columns")}>
        <For each={GRID_COLUMN_CHOICES}>
          {(value) => (
            <button
              type="button"
              data-slot="settings-choice"
              data-active={props.columns === value ? "true" : undefined}
              aria-pressed={props.columns === value}
              onClick={() => props.onChange(value)}
            >
              {value === undefined ? t("settings.grid.auto") : value}
            </button>
          )}
        </For>
      </div>
    </>
  )
}

export interface ProviderSectionProps {
  /** Opens the runner's sign-in in a terminal pane. Absent: no button. */
  onLogin?: (runner: Runner) => void
}

/**
 * The programs a bot can run on, and whether each is signed in.
 *
 * ADE keeps no keys of its own for bots. Each runner uses the account its CLI
 * already has — an Anthropic subscription through Claude Code, ChatGPT through
 * Codex, the providers `nikcli auth` holds — so this screen only reports what
 * each CLI says, and "Accedi" opens that CLI's own sign-in in a terminal.
 */
export function ProviderSection(props: ProviderSectionProps) {
  const [states, setStates] = createSignal<Record<string, ProviderState>>({})
  const [checking, setChecking] = createSignal(false)

  const check = () => {
    if (checking()) return
    setChecking(true)
    setStates({})
    void Promise.all(
      RUNNERS.map((runner) =>
        providerState(runner).then((state) => setStates((prev) => ({ ...prev, [runner.id]: state }))),
      ),
    ).finally(() => setChecking(false))
  }
  onMount(check)

  const label = (state: ProviderState | undefined) => {
    if (!state) return "Controllo…"
    if (!state.installed) return "Non installato"
    if (state.login.state === "in") return "Collegato"
    if (state.login.state === "out") return "Non collegato"
    return "Da verificare"
  }

  return (
    <>
      <div data-slot="section-head">
        <h3 data-slot="section-title" tabIndex={-1}>
          Provider
        </h3>
        <p data-slot="section-desc">
          I programmi su cui può girare un bot, ognuno con l'account della propria CLI: l'abbonamento
          Anthropic passa da Claude Code, quello ChatGPT da Codex, le chiavi e gli altri abbonamenti
          da nikcli. Il motore, il modello e lo sforzo si scelgono nella scheda di ogni bot.
        </p>
        <p data-slot="section-desc">
          ADE non chiede né legge le credenziali: l'accesso si fa nel flusso ufficiale di ogni CLI. Gli
          abbonamenti sono per uso personale e ADE tiene al massimo {MAX_PARALLEL_TURNS} turni insieme
          per ognuno; per automazioni intensive o non presidiate accedi alla CLI con una chiave API
          (Claude Code accetta la chiave della Console Anthropic, Codex la chiave OpenAI con{" "}
          <code>codex login --with-api-key</code>).
        </p>
      </div>

      <ul data-slot="settings-list">
        <For each={RUNNERS}>
          {(runner) => {
            const state = () => states()[runner.id]
            return (
              <li data-slot="provider-row" data-state={state()?.installed === false ? "missing" : state()?.login.state}>
                <div data-slot="provider-head">
                  <span data-slot="settings-name">{runner.label}</span>
                  <span data-slot="provider-badge">{label(state())}</span>
                  <Show when={props.onLogin && state()?.installed && runner.login.length > 0}>
                    <button
                      type="button"
                      data-slot="settings-choice"
                      onClick={() => props.onLogin?.(runner)}
                      title={`${runner.command} ${runner.login.join(" ")}`}
                    >
                      {state()?.login.state === "in" ? "Cambia account" : "Accedi"}
                    </button>
                  </Show>
                </div>
                <span data-slot="provider-detail">{runner.account}</span>
                <Show when={state()?.login.detail}>
                  <span data-slot="settings-meta">{state()!.login.detail}</span>
                </Show>
              </li>
            )
          }}
        </For>
      </ul>

      <div data-slot="settings-choices">
        <button type="button" data-slot="settings-choice" disabled={checking()} onClick={check}>
          {checking() ? "Controllo…" : "Controlla di nuovo"}
        </button>
      </div>
    </>
  )
}

/** Servers ADE would speak the Model Context Protocol to. */
export function McpSection() {
  return (
    <NotBuiltYet
      title="MCP"
      what={t("settings.mcp.desc")}
      instead={t("settings.mcp.instead")}
    />
  )
}
