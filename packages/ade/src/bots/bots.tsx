/**
 * The bot section: a contact list, a conversation, a card.
 *
 * A bot is a nikcli agent — a markdown file with frontmatter and a system
 * prompt under `.nikcli/agent/` in the project or in nikcli's global
 * configuration, created by `nikcli agent create` and started with
 * `nikcli --agent <name>`. The section used to be a roster and a form: a way
 * to write that file. It is now the way to *use* it, laid out as a
 * messaging app lays out its contacts:
 *
 *   - in the sidebar the bots, where the sessions and files are in the other
 *     views, each a shape and a colour rather than an initial, the three most
 *     recently active pinned large at the top, and under each name the last
 *     thing said or done and when — with the screenshots and the settings
 *     strip at the foot of the column, as everywhere else;
 *   - in the middle the conversation with the chosen one — what you wrote,
 *     what it answered, what it ran in between, and the question it is
 *     waiting on when it asks permission;
 *   - on the right its card: what it is for, what it runs on, its objectives,
 *     the file, and the form to change any of it.
 *
 * The conversation is `nikcli run --agent <name> --format json` one process
 * per turn, continued by session id — see `talk.ts` for the events and
 * `session.ts` for the process. "Terminale" still opens the full TUI in a
 * pane for whoever wants it.
 *
 * Everything with a rule in it is in the sibling `.ts` files. A `.tsx`
 * cannot be imported under `bun test` here, so nothing that matters lives in
 * this file.
 */

import { createEffect, createMemo, createResource, createRoot, createSignal, For, on, onMount, Show } from "solid-js"
import { every } from "../host/every"
import { avatarKey, COLORS, expressionFor, faceOf, SHAPES, type Color, type Expression, type Shape } from "./avatar"
import { COMMON_EFFORTS, OBJECTIVES_HEADING, splitPrompt, type AgentFile, type AgentScope } from "./nikcli"
import { applyRunnerLine, runnerById, RUNNERS, type Runner } from "./runners"
import { PLAN_RUNNERS, TERMS_NOTICE } from "./terms"
import { startTurn, type TurnHandle } from "./session"
import {
  createBot,
  deleteBot,
  listBots,
  listModels,
  resolveRoots,
  updateBot,
  type BotRoots,
} from "./store"
import {
  answerKeys,
  applyExit,
  applyProblem,
  emptyTalk,
  formatWhen,
  lastLine,
  mentionIn,
  noticePermission,
  parseTalk,
  permissionAnswered,
  sendMessage,
  serializeTalk,
  talkKey,
  type PermissionAnswer,
  type Talk,
  type TalkMessage,
} from "./talk"
import "./bots.css"

/*
 * The conversations, outside any component.
 *
 * A turn that takes a minute must not be lost because the user went to look
 * at a terminal meanwhile. So the threads and the running processes live
 * here, at module level, and the components only read them. Keyed by the
 * bot's path, because the identifier repeats across project and global scope.
 */
const [talks, setTalks] = createSignal<Record<string, Talk>>({})
const turns = new Map<string, TurnHandle>()

function readStored(path: string): Talk {
  try {
    return parseTalk(localStorage.getItem(talkKey(path)))
  } catch {
    return emptyTalk()
  }
}

function store(path: string, talk: Talk) {
  try {
    localStorage.setItem(talkKey(path), serializeTalk(talk))
  } catch {
    // Quota, or a browser set to block site data. The thread still works
    // for this session; only its survival across a reload is lost.
  }
}

function talkOf(path: string): Talk {
  return talks()[path] ?? emptyTalk()
}

function updateTalk(path: string, change: (talk: Talk) => Talk) {
  setTalks((all) => {
    const next = change(all[path] ?? emptyTalk())
    store(path, next)
    return { ...all, [path]: next }
  })
}

/** Brings a bot's stored thread in, once. A live one is never replaced by the disk copy. */
function ensureLoaded(paths: readonly string[]) {
  const missing = paths.filter((path) => talks()[path] === undefined)
  if (missing.length === 0) return
  setTalks((all) => {
    const next = { ...all }
    for (const path of missing) next[path] = readStored(path)
    return next
  })
}

/*
 * What the two halves share.
 *
 * The roster is drawn in the sidebar and the conversation in the main area,
 * by two components mounted in two different places, and both need the same
 * things: which bot is open, whether the form is up, the files on disk. So
 * the state lives here, in one root created once for the module, and each
 * half reads it. A section unmounts when the view changes; this does not,
 * which is also what keeps a turn alive while the user looks at a terminal.
 */
const shared = createRoot(() => {
  const [projectRoot, setProjectRoot] = createSignal<string>()
  const [roots, setRoots] = createSignal<BotRoots>({})
  const [openId, setOpenId] = createSignal<string>()
  const [composing, setComposing] = createSignal(false)
  const [reloads, setReloads] = createSignal(0)
  const [now, setNow] = createSignal(Date.now())

  createEffect(on(projectRoot, (root) => void resolveRoots(root).then(setRoots)))

  // The clocks in the roster: "ora" has to become "09:12" on its own. Paused
  // while the window is hidden, like every other timer in ADE.
  every(30_000, () => setNow(Date.now()))

  /*
   * The roster is the directory, re-read rather than remembered.
   *
   * A bot is a file the user can open in the editor two panes away, and nikcli
   * itself writes to the same place — a list held in memory would be a second
   * opinion about what exists. `reloads` is the handle for "something changed,
   * look again".
   */
  const [roster, { refetch }] = createResource(
    () => ({ roots: roots(), tick: reloads() }),
    (source) => listBots(source.roots),
  )

  createEffect(() => {
    const bots = roster()
    if (bots) ensureLoaded(bots.map((bot) => bot.path))
  })

  /* Asked of nikcli, once. These are the models a bot can be pinned to. */
  const [models] = createResource(
    () => projectRoot() ?? "",
    (cwd) => listModels(cwd || undefined),
  )

  /*
   * By activity, the way a contact list is ordered: whoever spoke last is
   * first. Bots that have never spoken keep their file order after them.
   */
  const ordered = createMemo(() => {
    const bots = roster() ?? []
    const all = talks()
    return [...bots].sort((a, b) => (all[b.path]?.updatedAt ?? 0) - (all[a.path]?.updatedAt ?? 0))
  })

  const reload = () => {
    setReloads((n) => n + 1)
    void refetch()
  }

  const current = () => (roster() ?? []).find((bot) => bot.path === openId())
  const identifiers = () => (roster() ?? []).map((bot) => bot.identifier)

  const open = (bot: AgentFile) => {
    setOpenId(bot.path)
    setComposing(false)
  }

  const expression = (bot: AgentFile): Expression => {
    if (bot.mode === "subagent") return "off"
    return expressionFor(talkOf(bot.path).status)
  }

  return {
    projectRoot,
    setProjectRoot,
    roots,
    roster,
    models,
    ordered,
    openId,
    setOpenId,
    composing,
    setComposing,
    now,
    reload,
    current,
    identifiers,
    open,
    expression,
  }
})

export interface BotsRosterProps {
  /** The open project, when there is one. Decides whether project bots exist. */
  projectRoot?: string
}

/**
 * The contact list, drawn in the sidebar.
 *
 * The three most recently active at the top, large; the rest in a list, each
 * with the last thing said or done and when. Sized to the sidebar it is in.
 */
export function BotsRoster(props: BotsRosterProps) {
  createEffect(() => shared.setProjectRoot(props.projectRoot))

  const { roster, ordered, openId, now, open, expression } = shared

  /* The three at the top, large, only when there are enough for the split to
     mean something: three portraits over an empty list is a list drawn twice. */
  const pinned = createMemo(() => (ordered().length >= 4 ? ordered().slice(0, 3) : []))
  const listed = createMemo(() => (ordered().length >= 4 ? ordered().slice(3) : ordered()))

  return (
    <div data-component="ade-bots-roster">
      <header data-slot="bots-roster-head">
        <span data-slot="bots-roster-title">bot</span>
        <button
          type="button"
          data-slot="bots-new"
          onClick={() => {
            shared.setComposing(true)
            shared.setOpenId(undefined)
          }}
          aria-label="Nuovo bot"
          title="Nuovo bot"
        >
          +
        </button>
      </header>

      <Show when={pinned().length > 0}>
        <div data-slot="bots-pinned">
          <For each={pinned()}>
            {(bot) => (
              <button
                type="button"
                data-slot="bots-pin"
                data-active={bot.path === openId() ? "true" : undefined}
                onClick={() => open(bot)}
                title={bot.description}
              >
                <Face identifier={bot.identifier} avatar={bot.avatar} expression={expression(bot)} size={56} />
                <span data-slot="bots-pin-name">{bot.identifier}</span>
              </button>
            )}
          </For>
        </div>
      </Show>

      <Show
        when={(roster() ?? []).length > 0}
        fallback={
          <p data-slot="bots-roster-empty">
            <Show when={!roster.loading} fallback={<>Lettura…</>}>
              Nessun agente nikcli. Creane uno.
            </Show>
          </p>
        }
      >
        <div data-slot="bots-list">
          <For each={listed()}>
            {(bot) => {
              const talk = () => talkOf(bot.path)
              return (
                <button
                  type="button"
                  data-slot="bots-row"
                  data-active={bot.path === openId() ? "true" : undefined}
                  data-status={talk().status}
                  onClick={() => open(bot)}
                >
                  <Face identifier={bot.identifier} avatar={bot.avatar} expression={expression(bot)} size={36} />
                  <span data-slot="bots-row-text">
                    <span data-slot="bots-row-name">{bot.identifier}</span>
                    <span data-slot="bots-row-line">{lastLine(talk(), bot.description || "Nessuna descrizione.")}</span>
                  </span>
                  <span data-slot="bots-row-when">{formatWhen(talk().updatedAt, now())}</span>
                </button>
              )
            }}
          </For>
        </div>
      </Show>
    </div>
  )
}

export interface BotsMainProps {
  /** The open project, when there is one. Decides whether project bots exist. */
  projectRoot?: string
  /** Opens a session running this bot in a pane, the TUI. Absent in the browser harness. */
  onLaunch?: (bot: AgentFile) => void
  /** Opens the bot's own file in the editor. */
  onOpenFile?: (path: string) => void
}

/** The conversation and the card, drawn in the main area. */
export function BotsMain(props: BotsMainProps) {
  createEffect(() => shared.setProjectRoot(props.projectRoot))

  const { roster, roots, models, composing, current, identifiers, expression, reload } = shared

  /*
   * One message, one process.
   *
   * `@nome` at the start hands the message to that bot instead: the thread
   * switches to it and the words go there without the mention. It is the
   * smallest version of "call another bot in", and the one that costs no
   * orchestration — the room in `room.ts` is the next step, not this one.
   */
  const send = (from: AgentFile, raw: string) => {
    const text = raw.trim()
    if (text.length === 0) return

    let bot = from
    let message = text
    const mention = mentionIn(text, identifiers())
    if (mention && mention.identifier !== from.identifier) {
      const target = (roster() ?? []).find((candidate) => candidate.identifier === mention.identifier)
      if (target) {
        bot = target
        message = mention.rest.length > 0 ? mention.rest : text
        shared.open(target)
      }
    }

    if (turns.has(bot.path)) return
    const path = bot.path
    const at = Date.now()
    const runner = runnerById(bot.runner)
    updateTalk(path, (talk) => sendMessage(talk, message, at))

    const cwd = props.projectRoot
    const sessionId = talkOf(path).sessionId
    void startTurn({
      bot,
      message,
      ...(sessionId ? { sessionId } : {}),
      ...(cwd ? { cwd } : {}),
      onLine: (line) => updateTalk(path, (talk) => applyRunnerLine(runner, talk, line, Date.now())),
      /* Only nikcli draws a permission menu; the others decide up front. */
      onData: (chunk) =>
        runner.id === "nikcli" && updateTalk(path, (talk) => noticePermission(talk, chunk, Date.now())),
      onExit: (code) => {
        turns.delete(path)
        updateTalk(path, (talk) => applyExit(talk, code, Date.now(), runner.label))
      },
    }).then((started) => {
      if (started.ok) {
        turns.set(path, started.handle)
      } else {
        updateTalk(path, (talk) => applyProblem(talk, started.problem, Date.now()))
      }
    })
  }

  const answer = (bot: AgentFile, choice: PermissionAnswer) => {
    turns.get(bot.path)?.write(answerKeys(choice))
    updateTalk(bot.path, (talk) => permissionAnswered(talk, Date.now()))
  }

  const stop = (bot: AgentFile) => {
    turns.get(bot.path)?.kill()
  }

  /** A fresh thread: the session id goes with it, so the model starts over too. */
  const forget = (bot: AgentFile) => {
    turns.get(bot.path)?.kill()
    updateTalk(bot.path, () => emptyTalk())
  }

  return (
    <section data-component="ade-bots">
      <div data-slot="bots-main">
        <Show when={composing()}>
          <div data-slot="bots-main-scroll">
            <BotForm
              roots={roots()}
              models={models() ?? []}
              hasProject={Boolean(props.projectRoot)}
              onCreated={(path) => {
                shared.setComposing(false)
                shared.setOpenId(path)
                reload()
              }}
              onCancel={() => shared.setComposing(false)}
            />
          </div>
        </Show>

        <Show when={!composing() && current()}>
          {(bot) => (
            <Thread
              bot={bot()}
              talk={talkOf(bot().path)}
              others={identifiers().filter((name) => name !== bot().identifier)}
              expression={expression(bot())}
              onSend={(text) => send(bot(), text)}
              onAnswer={(choice) => answer(bot(), choice)}
              onStop={() => stop(bot())}
            />
          )}
        </Show>

        <Show when={!composing() && !current()}>
          <p data-slot="bots-blank">
            <Show when={(roster() ?? []).length > 0} fallback={<>Nessun bot ancora. Premi + nella barra laterale per crearne uno.</>}>
              Scegli un bot nella barra laterale, o creane un altro.
            </Show>
          </p>
        </Show>
      </div>

      <Show when={!composing() && current()}>
        {(bot) => (
          <aside data-slot="bots-card">
            <BotCard
              bot={bot()}
              talk={talkOf(bot().path)}
              models={models() ?? []}
              expression={expression(bot())}
              {...(props.onLaunch ? { onLaunch: props.onLaunch } : {})}
              {...(props.onOpenFile ? { onOpenFile: props.onOpenFile } : {})}
              onForget={() => forget(bot())}
              onChanged={() => reload()}
              onDeleted={() => {
                shared.setOpenId(undefined)
                reload()
              }}
            />
          </aside>
        )}
      </Show>
    </section>
  )
}

/* ── the face ───────────────────────────────────────────────────────────── */

/**
 * A shape, a colour, two eyes. The shape and colour come from the identifier
 * (`avatar.ts`); the eyes from what the bot is doing. All of it is CSS on
 * `data-shape` and `data-expression`, so the same element is 18px in a
 * message and 64px at the top of the roster.
 */
function Face(props: { identifier: string; avatar?: string; expression?: Expression; size: number }) {
  const avatar = createMemo(() => faceOf(props.identifier, props.avatar))
  return (
    <span
      data-slot="bots-face"
      data-shape={avatar().shape}
      data-expression={props.expression ?? "still"}
      style={{ "--bot-color": `var(--ade-ansi-${avatar().color})`, "--bot-size": `${props.size}px` }}
      aria-hidden="true"
    >
      <b data-slot="bots-face-shape" />
    </span>
  )
}

/**
 * Choosing a face: a row of shapes, a row of colours, the result above them.
 *
 * Two rows of a few options rather than one grid of fifty-four, because the
 * choice is really two — and because the name already made one, shown until
 * the user makes their own. "Torna a quella del nome" clears the choice
 * rather than resetting to the default: an absent key is a different file
 * from a key that happens to equal the hash.
 */
function FacePicker(props: { identifier: string; value?: string; onChange: (value: string | undefined) => void }) {
  const chosen = createMemo(() => faceOf(props.identifier, props.value))
  const pick = (shape: Shape, color: Color) => props.onChange(avatarKey({ shape, color }))
  return (
    <div data-slot="bots-picker">
      <Face identifier={props.identifier} avatar={props.value} size={64} />
      <div data-slot="bots-picker-rows">
        <div data-slot="bots-picker-row" role="radiogroup" aria-label="Forma">
          <For each={SHAPES}>
            {(shape) => (
              <button
                type="button"
                role="radio"
                aria-checked={chosen().shape === shape}
                data-slot="bots-picker-option"
                data-on={chosen().shape === shape ? "true" : undefined}
                title={shape}
                onClick={() => pick(shape, chosen().color)}
              >
                <Face identifier={props.identifier} avatar={avatarKey({ shape, color: chosen().color })} size={26} />
              </button>
            )}
          </For>
        </div>
        <div data-slot="bots-picker-row" role="radiogroup" aria-label="Colore">
          <For each={COLORS}>
            {(color) => (
              <button
                type="button"
                role="radio"
                aria-checked={chosen().color === color}
                data-slot="bots-picker-swatch"
                data-on={chosen().color === color ? "true" : undefined}
                style={{ "--bot-color": `var(--ade-ansi-${color})` }}
                title={color}
                onClick={() => pick(chosen().shape, color)}
              />
            )}
          </For>
        </div>
        <span data-slot="bots-hint">
          <Show when={props.value} fallback={<>Forma e colore vengono dal nome finché non li scegli.</>}>
            Scelta tua.{" "}
            <button type="button" data-slot="bots-link" onClick={() => props.onChange(undefined)}>
              Torna a quella del nome
            </button>
          </Show>
        </span>
      </div>
    </div>
  )
}

/* ── the conversation ───────────────────────────────────────────────────── */

function Thread(props: {
  bot: AgentFile
  talk: Talk
  others: readonly string[]
  expression: Expression
  onSend: (text: string) => void
  onAnswer: (choice: PermissionAnswer) => void
  onStop: () => void
}) {
  const [draft, setDraft] = createSignal("")
  let scroller: HTMLDivElement | undefined
  let field: HTMLTextAreaElement | undefined

  // Kept at the bottom as it grows, the way a conversation is read.
  createEffect(
    on(
      () => [props.talk.messages.length, props.talk.permission, props.talk.status],
      () => {
        if (scroller) scroller.scrollTop = scroller.scrollHeight
      },
    ),
  )

  createEffect(on(() => props.bot.path, () => {
    setDraft("")
    field?.focus()
  }))

  const busy = () => props.talk.status === "working" || props.talk.status === "waiting"

  const submit = () => {
    const text = draft()
    if (text.trim().length === 0 || busy()) return
    setDraft("")
    props.onSend(text)
  }

  const subagent = () => props.bot.mode === "subagent"

  return (
    <div data-slot="bots-thread">
      <div data-slot="bots-messages" ref={(el) => (scroller = el)}>
        <Show when={props.talk.messages.length === 0 && !props.talk.problem}>
          <div data-slot="bots-thread-empty">
            <Face identifier={props.bot.identifier} avatar={props.bot.avatar} expression={props.expression} size={72} />
            <p data-slot="bots-thread-empty-name">{props.bot.identifier}</p>
            <p data-slot="bots-thread-empty-text">
              {props.bot.description || "Nessuna descrizione."}
            </p>
            <Show when={subagent()}>
              <p data-slot="bots-hint">
                È un <strong>subagente</strong>: non risponde da solo, lo chiama un altro agente. Puoi
                comunque scrivergli, ma nikcli userà l'agente predefinito al suo posto.
              </p>
            </Show>
          </div>
        </Show>

        <For each={props.talk.messages}>{(message) => <Message message={message} bot={props.bot} />}</For>

        <Show when={props.talk.permission}>
          {(asked) => (
            <div data-slot="bots-permission" role="group" aria-label="Richiesta di permesso">
              <Face identifier={props.bot.identifier} avatar={props.bot.avatar} expression="waiting" size={20} />
              <span data-slot="bots-permission-text">
                Vuole usare <code>{asked().permission}</code>
                <Show when={asked().patterns}>
                  {" "}
                  su <code>{asked().patterns}</code>
                </Show>
              </span>
              <span data-slot="bots-permission-actions">
                <button type="button" data-slot="bots-btn" onClick={() => props.onAnswer("reject")}>
                  Rifiuta
                </button>
                <button type="button" data-slot="bots-btn" onClick={() => props.onAnswer("always")}>
                  Sempre
                </button>
                <button type="button" data-slot="bots-btn" data-tone="primary" onClick={() => props.onAnswer("once")}>
                  Consenti
                </button>
              </span>
            </div>
          )}
        </Show>

        <Show when={props.talk.status === "working"}>
          <div data-slot="bots-typing">
            <Face identifier={props.bot.identifier} avatar={props.bot.avatar} expression="busy" size={20} />
            <span>sta rispondendo…</span>
            <button type="button" data-slot="bots-link" onClick={() => props.onStop()}>
              Ferma
            </button>
          </div>
        </Show>

        <Show when={props.talk.problem}>{(text) => <p data-slot="bots-problem">{text()}</p>}</Show>
      </div>

      <Show when={props.others.length > 0}>
        <div data-slot="bots-mentions">
          <For each={props.others}>
            {(name) => (
              <button
                type="button"
                data-slot="bots-mention"
                onClick={() => {
                  setDraft((text) => (text.trim().length > 0 ? `${text.trimEnd()} @${name} ` : `@${name} `))
                  field?.focus()
                }}
                title={`Passa il messaggio a ${name}`}
              >
                @{name}
              </button>
            )}
          </For>
        </div>
      </Show>

      <form
        data-slot="bots-composer"
        onSubmit={(event) => {
          event.preventDefault()
          submit()
        }}
      >
        <textarea
          ref={(el) => (field = el)}
          data-slot="bots-composer-field"
          rows="1"
          value={draft()}
          placeholder={
            props.others.length > 0
              ? `Scrivi a ${props.bot.identifier}, o @ per passare a un altro bot`
              : `Scrivi a ${props.bot.identifier}`
          }
          onInput={(event) => setDraft(event.currentTarget.value)}
          onKeyDown={(event) => {
            // Enter sends, Shift+Enter breaks the line: what every messenger does.
            if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
              event.preventDefault()
              submit()
            }
          }}
        />
        <span data-slot="bots-composer-cap">
          <Show when={props.talk.tokens > 0}>
            {formatCount(props.talk.tokens)} token
            <Show when={props.talk.costUsd > 0}> · {formatUsd(props.talk.costUsd)}</Show>
          </Show>
        </span>
        <button type="submit" data-slot="bots-btn" data-tone="primary" disabled={busy() || draft().trim().length === 0}>
          Invia
        </button>
      </form>
    </div>
  )
}

function Message(props: { message: TalkMessage; bot: AgentFile }) {
  return (
    <div data-slot="bots-msg" data-role={props.message.role}>
      <Show when={props.message.role !== "user"}>
        <Face identifier={props.bot.identifier} avatar={props.bot.avatar} size={24} />
      </Show>
      <div data-slot="bots-msg-body">
        <Show when={props.message.role === "tool"}>
          <details data-slot="bots-tool">
            <summary data-slot="bots-tool-head">
              <span data-slot="bots-tool-name">{props.message.tool}</span>
              <span data-slot="bots-tool-title">{props.message.text}</span>
            </summary>
            <Show when={props.message.output}>
              <pre data-slot="bots-tool-output">{props.message.output}</pre>
            </Show>
          </details>
        </Show>
        <Show when={props.message.role !== "tool"}>
          <p data-slot="bots-msg-text">{props.message.text}</p>
        </Show>
      </div>
    </div>
  )
}

function formatCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}k`
  return String(n)
}

function formatUsd(usd: number): string {
  return `$${usd < 0.01 ? usd.toFixed(3) : usd.toFixed(2)}`
}

/* ── the card ───────────────────────────────────────────────────────────── */

function BotCard(props: {
  bot: AgentFile
  talk: Talk
  models: readonly string[]
  expression: Expression
  onLaunch?: (bot: AgentFile) => void
  onOpenFile?: (path: string) => void
  onForget: () => void
  onChanged: () => void
  onDeleted: () => void
}) {
  const [editing, setEditing] = createSignal(false)
  const [confirming, setConfirming] = createSignal(false)
  const [problem, setProblem] = createSignal<string>()
  const parts = createMemo(() => splitPrompt(props.bot.prompt))

  createEffect(on(() => props.bot.path, () => {
    setEditing(false)
    setConfirming(false)
    setProblem(undefined)
  }))

  const remove = async () => {
    const failure = await deleteBot(props.bot)
    if (failure) {
      setProblem(failure)
      setConfirming(false)
      return
    }
    props.onDeleted()
  }

  return (
    <div data-slot="bots-card-body">
      <header data-slot="bots-card-head">
        <Face identifier={props.bot.identifier} avatar={props.bot.avatar} expression={props.expression} size={72} />
        <h2 data-slot="bots-card-name">{props.bot.identifier}</h2>
        <p data-slot="bots-card-desc">{props.bot.description || "Nessuna descrizione."}</p>
        <span data-slot="bots-card-meta">
          {runnerById(props.bot.runner).label} · {props.bot.model ?? "modello predefinito"}
          {props.bot.effort ? ` · ${props.bot.effort}` : ""} · {props.bot.mode} ·{" "}
          {props.bot.scope === "project" ? "progetto" : "globale"}
        </span>
      </header>

      <div data-slot="bots-card-actions">
        <Show when={props.onLaunch}>
          {(launch) => (
            <button
              type="button"
              data-slot="bots-btn"
              disabled={props.bot.mode === "subagent"}
              onClick={() => launch()(props.bot)}
              title={
                props.bot.mode === "subagent"
                  ? "Un subagente non si avvia da solo: lo chiama un altro agente"
                  : "Apre la TUI di nikcli con questo bot in un pannello"
              }
            >
              Terminale
            </button>
          )}
        </Show>
        <Show when={props.onOpenFile}>
          {(open) => (
            <button type="button" data-slot="bots-btn" onClick={() => open()(props.bot.path)}>
              Apri il file
            </button>
          )}
        </Show>
        <button type="button" data-slot="bots-btn" data-active={editing() ? "true" : undefined} onClick={() => setEditing((v) => !v)}>
          {editing() ? "Chiudi" : "Modifica"}
        </button>
      </div>

      <Show when={problem()}>{(text) => <p data-slot="bots-problem">{text()}</p>}</Show>

      <Show when={!editing()}>
        <Show when={parts().objectives.length > 0}>
          <section data-slot="bots-card-section">
            <span data-slot="bots-label">Obiettivi</span>
            <ul data-slot="bots-card-objectives">
              <For each={parts().objectives}>{(objective) => <li>{objective}</li>}</For>
            </ul>
          </section>
        </Show>

        <section data-slot="bots-card-section">
          <span data-slot="bots-label">Conversazione</span>
          <span data-slot="bots-card-stat">
            {props.talk.messages.length} messaggi
            <Show when={props.talk.tokens > 0}>
              {" "}
              · {formatCount(props.talk.tokens)} token
            </Show>
            <Show when={props.talk.costUsd > 0}> · {formatUsd(props.talk.costUsd)}</Show>
          </span>
          <Show when={props.talk.sessionId}>
            <span data-slot="bots-card-path" title={props.talk.sessionId}>
              sessione {props.talk.sessionId}
            </span>
          </Show>
          <Show when={props.talk.messages.length > 0}>
            <button type="button" data-slot="bots-link" onClick={() => props.onForget()}>
              Nuova conversazione
            </button>
          </Show>
        </section>

        <section data-slot="bots-card-section">
          <span data-slot="bots-label">File</span>
          <span data-slot="bots-card-path" title={props.bot.path}>
            {props.bot.path}
          </span>
        </section>

        <section data-slot="bots-card-section" data-slot-end="true">
          <Show
            when={confirming()}
            fallback={
              <button type="button" data-slot="bots-link" data-tone="danger" onClick={() => setConfirming(true)}>
                Elimina il bot
              </button>
            }
          >
            {/* Confirmed, because this deletes a file: the persona is the bot as
                much as the name is, and nothing else in ADE holds a copy. */}
            <span data-slot="bots-confirm">
              <span>Eliminare {props.bot.identifier}?</span>
              <button type="button" data-slot="bots-btn" onClick={() => setConfirming(false)}>
                No
              </button>
              <button type="button" data-slot="bots-btn" data-tone="danger" onClick={() => void remove()}>
                Elimina
              </button>
            </span>
          </Show>
        </section>
      </Show>

      <Show when={editing()}>
        <BotSettings
          bot={props.bot}
          models={props.models}
          onSaved={() => props.onChanged()}
        />
      </Show>
    </div>
  )
}

/* ── the form ───────────────────────────────────────────────────────────── */

/**
 * Two ways to make a bot, and the difference is one field. Leave the persona
 * empty and nikcli's own model writes it from the description — that is
 * `nikcli agent create`, the native route, and it also chooses the identifier
 * and the "when to use" line. Write a persona and the file is written
 * directly, byte-compatible with the generated one, because paying a model to
 * produce a prompt that is about to be thrown away is not a feature.
 *
 * The model list comes from nikcli, and "predefinito" is a real answer: a bot
 * with no `model` key runs on whatever nikcli is configured for, which is the
 * right default for someone who has not thought about it.
 */
function BotForm(props: {
  roots: BotRoots
  models: readonly string[]
  hasProject: boolean
  onCreated: (path: string) => void
  onCancel: () => void
}) {
  const [name, setName] = createSignal("")
  const [scope, setScope] = createSignal<AgentScope>(props.hasProject ? "project" : "global")
  const [description, setDescription] = createSignal("")
  const [persona, setPersona] = createSignal("")
  const [model, setModel] = createSignal("")
  const [effort, setEffort] = createSignal("")
  const [runner, setRunner] = createSignal<string>("nikcli")
  const [objectives, setObjectives] = createSignal("")
  const [avatar, setAvatar] = createSignal<string>()
  const [problem, setProblem] = createSignal<string>()
  const [busy, setBusy] = createSignal(false)

  let nameField: HTMLInputElement | undefined
  onMount(() => nameField?.focus())

  const generating = () => persona().trim().length === 0

  const submit = async (event: Event) => {
    event.preventDefault()
    if (busy()) return

    if (description().trim().length === 0) {
      setProblem("Serve una descrizione: è quello che nikcli usa per decidere quando chiamarlo.")
      return
    }
    if (!generating() && name().trim().length === 0) {
      setProblem("Serve un nome: diventa l'identificativo del file.")
      return
    }

    setProblem(undefined)
    setBusy(true)
    const result = await createBot(
      {
        name: name(),
        scope: scope(),
        description: description().trim(),
        ...(generating() ? {} : { persona: persona() }),
        ...(model() ? { model: model() } : {}),
        ...(effort().trim() ? { effort: effort().trim() } : {}),
        ...(avatar() ? { avatar: avatar() } : {}),
        ...(runner() !== "nikcli" ? { runner: runner() } : {}),
        objectives: objectives()
          .split("\n")
          .map((line) => line.replace(/^[-*•]\s*/, "").trim())
          .filter((line) => line.length > 0),
      },
      props.roots,
    )
    setBusy(false)

    if (!result.ok) {
      setProblem(result.problem)
      return
    }
    props.onCreated(result.path)
  }

  return (
    <form data-slot="bots-form" onSubmit={(e) => void submit(e)}>
      <h2 data-slot="bots-form-title">Nuovo bot</h2>

      <label data-slot="bots-field">
        <span data-slot="bots-label">Nome</span>
        <input
          ref={(el) => (nameField = el)}
          data-slot="bots-input"
          value={name()}
          onInput={(event) => {
            setName(event.currentTarget.value)
            setProblem(undefined)
          }}
          placeholder="Revisore"
        />
        <span data-slot="bots-hint">
          {/* Said plainly, because the two routes name the bot differently and
              a field that is sometimes ignored is worse than one that says so. */}
          {generating()
            ? "Con la persona vuota è nikcli a scegliere l'identificativo: questo nome è solo un promemoria."
            : "Diventa il nome del file e l'identificativo passato a --agent."}
        </span>
      </label>

      <div data-slot="bots-field">
        <span data-slot="bots-label">Logo</span>
        <FacePicker identifier={name() || "?"} value={avatar()} onChange={setAvatar} />
      </div>

      <label data-slot="bots-field">
        <span data-slot="bots-label">A cosa serve</span>
        <input
          data-slot="bots-input"
          value={description()}
          onInput={(event) => {
            setDescription(event.currentTarget.value)
            setProblem(undefined)
          }}
          placeholder="Revisiona le pull request e segnala i rischi"
        />
      </label>

      <EngineFields
        listId="bots-new"
        runner={runner()}
        model={model()}
        effort={effort()}
        nikcliModels={props.models}
        onRunner={(id) => {
          setRunner(id)
          setModel("")
          setEffort("")
        }}
        onModel={setModel}
        onEffort={setEffort}
      />

      <label data-slot="bots-field">
        <span data-slot="bots-label">Dove</span>
        <select
          data-slot="bots-input"
          value={scope()}
          onChange={(event) => setScope(event.currentTarget.value === "project" ? "project" : "global")}
        >
          <option value="project" disabled={!props.hasProject}>
            Nel progetto (.nikcli/agent)
          </option>
          <option value="global">Globale (per tutti i progetti)</option>
        </select>
      </label>

      <label data-slot="bots-field">
        <span data-slot="bots-label">Obiettivi</span>
        <textarea
          data-slot="bots-input"
          data-multiline="true"
          rows="3"
          value={objectives()}
          placeholder="Uno per riga. Restano veri in ogni conversazione."
          onInput={(event) => setObjectives(event.currentTarget.value)}
        />
      </label>

      <label data-slot="bots-field">
        <span data-slot="bots-label">Persona</span>
        <textarea
          data-slot="bots-input"
          data-multiline="true"
          rows="6"
          value={persona()}
          onInput={(event) => setPersona(event.currentTarget.value)}
          placeholder="Lascia vuoto e la scrive nikcli dalla descrizione. Oppure scrivila tu: come deve comportarsi, e cosa non deve fare."
        />
      </label>

      <Show when={problem()}>{(text) => <p data-slot="bots-problem">{text()}</p>}</Show>

      <div data-slot="bots-form-actions">
        <button type="button" data-slot="bots-btn" onClick={() => props.onCancel()} disabled={busy()}>
          Annulla
        </button>
        <button type="submit" data-slot="bots-btn" data-tone="primary" disabled={busy()}>
          {busy() ? "Creazione…" : generating() ? "Genera con nikcli" : "Crea"}
        </button>
      </div>
      <Show when={busy() && generating()}>
        {/* The generation is a model call: several seconds with nothing on
            screen reads as a button that did nothing. */}
        <p data-slot="bots-hint">nikcli sta scrivendo l'agente. Ci vuole qualche secondo.</p>
      </Show>
    </form>
  )
}

/* ── the settings, in the card ──────────────────────────────────────────── */

/**
 * Which program, which model, how hard.
 *
 * nikcli's models are a closed list asked of nikcli, because a name it has no
 * provider for fails at launch. The other runners take free text with
 * suggestions: Claude Code and Codex accept aliases and new model names long
 * before a list here learns them, and refuse a wrong one in their own words.
 */
function EngineFields(props: {
  listId: string
  runner: string
  model: string
  effort: string
  nikcliModels: readonly string[]
  /** The model the file already names, kept selectable when a list lacks it. */
  pinned?: string
  onRunner: (id: string) => void
  onModel: (value: string) => void
  onEffort: (value: string) => void
}) {
  const runner = createMemo<Runner>(() => runnerById(props.runner))
  return (
    <>
      <label data-slot="bots-field">
        <span data-slot="bots-label">Motore</span>
        <select
          data-slot="bots-input"
          value={runner().id}
          onChange={(event) => props.onRunner(event.currentTarget.value)}
        >
          <For each={RUNNERS}>{(option) => <option value={option.id}>{option.label}</option>}</For>
        </select>
        <span data-slot="bots-hint">
          {runner().account} Gli accessi si controllano in Impostazioni › Provider.
        </span>
        <Show when={PLAN_RUNNERS.includes(runner().id)}>
          <span data-slot="bots-hint" data-terms="">
            {TERMS_NOTICE}
          </span>
        </Show>
      </label>

      <div data-slot="bots-row-fields">
        <label data-slot="bots-field">
          <span data-slot="bots-label">Modello</span>
          <Show
            when={runner().id === "nikcli"}
            fallback={
              <>
                <input
                  data-slot="bots-input"
                  list={`${props.listId}-models`}
                  value={props.model}
                  placeholder={`predefinito di ${runner().label}`}
                  onInput={(event) => props.onModel(event.currentTarget.value.trim())}
                />
                <datalist id={`${props.listId}-models`}>
                  <For each={runner().models}>{(id) => <option value={id} />}</For>
                </datalist>
              </>
            }
          >
            <select
              data-slot="bots-input"
              value={props.model}
              onChange={(event) => props.onModel(event.currentTarget.value)}
            >
              <option value="">Predefinito di nikcli</option>
              {/* The bot's own model stays offered when it is not in the list:
                  dropping the pin would silently move the bot to another model. */}
              <Show when={props.pinned && !props.nikcliModels.includes(props.pinned)}>
                <option value={props.pinned}>{props.pinned}</option>
              </Show>
              <For each={props.nikcliModels}>{(id) => <option value={id}>{id}</option>}</For>
            </select>
            <Show when={props.nikcliModels.length === 0}>
              <span data-slot="bots-hint">
                Elenco dei modelli non disponibile: serve nikcli nel PATH. Il bot userà il modello
                predefinito.
              </span>
            </Show>
          </Show>
        </label>

        <label data-slot="bots-field">
          <span data-slot="bots-label">Sforzo</span>
          <Show
            when={runner().efforts.length > 0}
            fallback={<input data-slot="bots-input" value="" placeholder="non previsto" disabled />}
          >
            <select
              data-slot="bots-input"
              value={props.effort}
              onChange={(event) => props.onEffort(event.currentTarget.value)}
            >
              <option value="">predefinito</option>
              <Show when={props.effort && !runner().efforts.includes(props.effort)}>
                <option value={props.effort}>{props.effort}</option>
              </Show>
              <For each={runner().efforts}>{(value) => <option value={value}>{value}</option>}</For>
            </select>
          </Show>
        </label>
      </div>
    </>
  )
}

function BotSettings(props: {
  bot: AgentFile
  models: readonly string[]
  onSaved: () => void
}) {
  const parts = createMemo(() => splitPrompt(props.bot.prompt))

  const [description, setDescription] = createSignal(props.bot.description)
  const [model, setModel] = createSignal(props.bot.model ?? "")
  const [effort, setEffort] = createSignal(props.bot.effort ?? "")
  const [runner, setRunner] = createSignal<string>(runnerById(props.bot.runner).id)
  const [objectives, setObjectives] = createSignal(parts().objectives.join("\n"))
  const [persona, setPersona] = createSignal(parts().persona)
  const [avatar, setAvatar] = createSignal(props.bot.avatar)
  const [busy, setBusy] = createSignal(false)
  const [failure, setFailure] = createSignal<string>()
  const [saved, setSaved] = createSignal(false)

  /* Re-read when the file changes under the form: these are fields over a
     file, and the file is the truth. */
  createEffect(
    on(
      () =>
        props.bot.path + props.bot.prompt + (props.bot.model ?? "") + (props.bot.effort ?? "") + (props.bot.runner ?? ""),
      () => {
        setRunner(runnerById(props.bot.runner).id)
        setDescription(props.bot.description)
        setModel(props.bot.model ?? "")
        setEffort(props.bot.effort ?? "")
        setObjectives(parts().objectives.join("\n"))
        setPersona(parts().persona)
        setAvatar(props.bot.avatar)
        setSaved(false)
      },
      { defer: true },
    ),
  )

  const dirty = createMemo(
    () =>
      description() !== props.bot.description ||
      model() !== (props.bot.model ?? "") ||
      effort() !== (props.bot.effort ?? "") ||
      runner() !== runnerById(props.bot.runner).id ||
      persona() !== parts().persona ||
      objectives() !== parts().objectives.join("\n") ||
      avatar() !== props.bot.avatar,
  )

  const save = async (event: Event) => {
    event.preventDefault()
    if (busy()) return
    setBusy(true)
    setFailure(undefined)

    const problem = await updateBot(props.bot, {
      description: description().trim(),
      model: model() || undefined,
      effort: effort().trim() || undefined,
      runner: runner() === "nikcli" ? undefined : runner(),
      persona: persona(),
      avatar: avatar(),
      objectives: objectives()
        .split("\n")
        .map((line) => line.replace(/^[-*•]\s*/, "").trim())
        .filter((line) => line.length > 0),
    })

    setBusy(false)
    if (problem) {
      setFailure(problem)
      return
    }
    setSaved(true)
    props.onSaved()
  }

  return (
    <form data-slot="bots-form" data-compact="true" onSubmit={(e) => void save(e)}>
      <div data-slot="bots-field">
        <span data-slot="bots-label">Logo</span>
        <FacePicker identifier={props.bot.identifier} value={avatar()} onChange={setAvatar} />
      </div>

      <label data-slot="bots-field">
        <span data-slot="bots-label">Quando usarlo</span>
        <input
          data-slot="bots-input"
          value={description()}
          onInput={(event) => setDescription(event.currentTarget.value)}
        />
        <span data-slot="bots-hint">
          È il <code>description</code> del file: nikcli lo legge per decidere quando chiamare questo
          bot come subagente.
        </span>
      </label>

      <EngineFields
        listId={`bots-${props.bot.identifier}`}
        runner={runner()}
        model={model()}
        effort={effort()}
        nikcliModels={props.models}
        {...(props.bot.model ? { pinned: props.bot.model } : {})}
        onRunner={(id) => {
          setRunner(id)
          if (id !== runnerById(props.bot.runner).id) {
            setModel("")
            setEffort("")
          } else {
            setModel(props.bot.model ?? "")
            setEffort(props.bot.effort ?? "")
          }
        }}
        onModel={setModel}
        onEffort={setEffort}
      />

      <label data-slot="bots-field">
        <span data-slot="bots-label">Obiettivi</span>
        <textarea
          data-slot="bots-input"
          data-multiline="true"
          rows="4"
          value={objectives()}
          placeholder={"Uno per riga.\nEs. Segnala i rischi prima delle opinioni"}
          onInput={(event) => setObjectives(event.currentTarget.value)}
        />
        <span data-slot="bots-hint">
          Uno per riga. Finiscono nel prompt sotto <code>{OBJECTIVES_HEADING}</code>.
        </span>
      </label>

      <label data-slot="bots-field">
        <span data-slot="bots-label">Persona</span>
        <textarea
          data-slot="bots-input"
          data-multiline="true"
          rows="8"
          value={persona()}
          onInput={(event) => setPersona(event.currentTarget.value)}
        />
      </label>

      <Show when={failure()}>{(text) => <p data-slot="bots-problem">{text()}</p>}</Show>

      <div data-slot="bots-form-actions">
        <span data-slot="bots-hint" data-state={saved() && !dirty() ? "saved" : undefined}>
          {saved() && !dirty() ? "Salvato." : dirty() ? "Modifiche non salvate." : ""}
        </span>
        <button type="submit" data-slot="bots-btn" data-tone="primary" disabled={busy() || !dirty()}>
          {busy() ? "Salvataggio…" : "Salva"}
        </button>
      </div>
    </form>
  )
}
