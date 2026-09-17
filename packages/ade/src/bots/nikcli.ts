/**
 * A bot is a nikcli agent. This file is the translation.
 *
 * The bot section used to keep its own roster in `localStorage`: a name, a
 * model and a persona that existed only inside ADE and that nothing could run.
 * nikcli already has the same object, on disk and executable — an *agent*: a
 * markdown file with frontmatter (`description`, `mode`, `model`, `tools`) and
 * a body that is its system prompt, discovered by nikcli under
 * `.nikcli/agent/**\/*.md` in the project or under its global config
 * directory, creatable with `nikcli agent create` and runnable with
 * `nikcli --agent <name>`.
 *
 * So there is nothing to invent and no plugin to write. A bot created here is
 * a file nikcli reads; a bot listed here is a file nikcli wrote or the user
 * hand-edited; starting one is the same command the user would type. The
 * alternative — ADE keeping a parallel roster and pretending — is how you end
 * up with two lists of bots that disagree.
 *
 * Note what `nikcli bot` is *not*: that subcommand manages chat-platform
 * connectors (Discord, Slack, Teams…), which is a different thing wearing the
 * same word. The native creation function for what this section calls a bot is
 * `nikcli agent create`.
 *
 * Pure, in a `.ts`, because every rule below fails silently when wrong: an
 * argument list that is one flag short makes `agent create` interactive and it
 * hangs forever waiting on a prompt nobody can see; a frontmatter writer that
 * mis-indents produces a file nikcli refuses to load and never says so here.
 */

import { basename, joinPath } from "../host/path"

/** The executable. Same name `session-new/agents.ts` resolves on PATH. */
export const NIKCLI_COMMAND = "nikcli"

/** Where nikcli keeps a project's own configuration. */
export const PROJECT_CONFIG_DIR = ".nikcli"

/**
 * The directory `--path` gets `agent` appended to.
 *
 * `nikcli agent create --path X` writes `X/agent/<identifier>.md` — the flag
 * names the configuration root, not the agent directory. Passing the agent
 * directory itself would produce `agent/agent/…`, which nikcli's glob does
 * find, so the mistake is invisible until someone looks at the tree.
 */
export type AgentScope = "project" | "global"

/**
 * The tools an agent may be given.
 *
 * Kept in step with `AVAILABLE_TOOLS` in
 * `packages/nikcli/src/cli/cmd/agent.ts`. Duplicated rather than imported
 * because ADE must not depend on the nikcli package to draw a form, and a
 * name that has gone away here only means a tool silently left disabled — the
 * command rejects nothing.
 */
export const NIKCLI_TOOLS = [
  "bash",
  "read",
  "write",
  "edit",
  "generate_image",
  "speak",
  "list",
  "glob",
  "grep",
  "webfetch",
  "task",
  "todowrite",
  "todoread",
] as const

export type NikcliTool = (typeof NIKCLI_TOOLS)[number]

/** How an agent may be used. `primary` is a bot you talk to yourself. */
export type AgentMode = "all" | "primary" | "subagent"

export interface AgentFile {
  /** The name nikcli knows it by: the filename without `.md`. */
  readonly identifier: string
  readonly path: string
  readonly scope: AgentScope
  /** When to use it — nikcli's `description`, one line in the roster. */
  readonly description: string
  readonly mode: AgentMode
  /** `provider/model`, as nikcli names models. Absent means nikcli's default. */
  readonly model?: string
  /**
   * How hard the model is asked to think — nikcli's `variant`.
   *
   * Provider-specific and deliberately a free string: the legal names come
   * from the resolved model's own variant table, so an effort model takes
   * something like `minimal`…`high`, a toggle model takes `none`/`thinking`
   * and a budget model takes `high`/`max`. A name the model does not declare
   * is dropped silently by nikcli rather than refused, which is the one thing
   * worth knowing before typing in the field.
   *
   * It does not require a pinned model, despite what nikcli's own description
   * of the key says: the prompt applies the agent's variant to whichever model
   * the turn ends up using.
   */
  readonly effort?: string
  /** The system prompt: persona and objectives together, as nikcli reads it. */
  readonly prompt: string
  /** Only the tools explicitly turned off; everything absent is allowed. */
  readonly disabledTools: readonly string[]
  /**
   * The face the user chose, as `shape/color` — see `avatar.ts`.
   *
   * ADE's own key in nikcli's file. nikcli ignores keys it does not know, so
   * it costs nothing there, and it means the face travels with the bot rather
   * than living in one machine's browser storage. Absent: the name decides.
   */
  readonly avatar?: string
  /**
   * The program its turns run on — see `runners.ts`. ADE's own key, like
   * `avatar`. Absent: nikcli.
   */
  readonly runner?: string
}

/**
 * The heading under which a bot's standing objectives live.
 *
 * nikcli's agent file has exactly one place for instructions — the body, which
 * is the system prompt — and no separate concept of goals. Objectives are
 * therefore part of the prompt, and this heading is how ADE finds them again
 * to put them back in their own field.
 *
 * A convention, not a format: the file stays a plain system prompt that reads
 * correctly to the model and to anyone opening it in an editor, and a bot
 * whose objectives were written by hand under a differently-spelled heading
 * simply shows them as part of the persona. Nothing is lost either way — which
 * is the test a convention like this has to pass.
 */
export const OBJECTIVES_HEADING = "## Obiettivi"

/**
 * Efforts worth offering, though the field is not limited to them.
 *
 * `variant` is passed through to whichever provider owns the model, and each
 * provider names its own steps — so this is a list of suggestions, not a set
 * of valid values, and the control that uses it accepts anything typed. A
 * closed dropdown here would be ADE deciding on behalf of a provider it has
 * never heard of.
 */
export const COMMON_EFFORTS: readonly string[] = ["minimal", "low", "medium", "high", "max"]

export interface PromptParts {
  /** Who the bot is and how it behaves. */
  readonly persona: string
  /** What it is always working towards, one per line, without bullets. */
  readonly objectives: readonly string[]
}

/**
 * Splits a system prompt into the persona and the objectives below it.
 *
 * Everything before the heading is the persona; the list items under it are
 * the objectives. Anything else under the heading — a paragraph someone wrote
 * by hand — stays with the persona rather than being silently dropped, because
 * this reads a file the user is invited to edit and losing a sentence on a
 * round trip is worse than showing it in the wrong box.
 */
export function splitPrompt(prompt: string): PromptParts {
  const normalized = prompt.replace(/\r\n/g, "\n")
  const at = normalized.indexOf(`${OBJECTIVES_HEADING}\n`)
  const atEnd = normalized.endsWith(OBJECTIVES_HEADING)
  if (at === -1 && !atEnd) return { persona: normalized.trim(), objectives: [] }

  const cut = at === -1 ? normalized.length - OBJECTIVES_HEADING.length : at
  const persona = normalized.slice(0, cut).trim()
  const body = at === -1 ? "" : normalized.slice(cut + OBJECTIVES_HEADING.length + 1)

  const objectives: string[] = []
  const strays: string[] = []
  for (const line of body.split("\n")) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    const bullet = /^[-*•]\s+(.*)$/.exec(trimmed)
    if (bullet) objectives.push(bullet[1].trim())
    else strays.push(trimmed)
  }

  return {
    persona: strays.length > 0 ? [persona, ...strays].filter(Boolean).join("\n\n") : persona,
    objectives,
  }
}

/**
 * Puts the two halves back together as one system prompt.
 *
 * The heading is written only when there is something under it: a bot with no
 * objectives gets a file with no empty section, which is what someone reading
 * it in an editor expects and what keeps the round trip stable.
 */
export function joinPrompt(parts: PromptParts): string {
  const objectives = parts.objectives.map((line) => line.trim()).filter((line) => line.length > 0)
  const persona = parts.persona.trim()
  if (objectives.length === 0) return persona

  const list = objectives.map((line) => `- ${line}`).join("\n")
  return [persona, `${OBJECTIVES_HEADING}\n${list}`].filter((part) => part.length > 0).join("\n\n")
}

/**
 * The configuration root for a scope — the value `--path` takes.
 *
 * `global` is the nikcli config directory itself; `project` is `.nikcli`
 * inside the open project, which is the layout `nikcli agent create` produces
 * when asked interactively and the one `Config` scans.
 */
export function agentHome(base: string, scope: AgentScope): string {
  return scope === "project" ? joinPath(base, PROJECT_CONFIG_DIR) : base
}

/** Where the files themselves live, and where new ones are written. */
export function agentDir(base: string, scope: AgentScope): string {
  return joinPath(agentHome(base, scope), "agent")
}

/**
 * Both directory names nikcli looks in.
 *
 * Its glob is `{agent,agents}/**\/*.md`, so a project that spelled the folder
 * `agents` has bots that nikcli runs and that a roster reading only `agent`
 * cannot see — a bot that exists everywhere except in the list of bots. New
 * files go in `agent`, which is the spelling `agent create` produces.
 */
export function agentDirs(base: string, scope: AgentScope): string[] {
  const home = agentHome(base, scope)
  return [joinPath(home, "agent"), joinPath(home, "agents")]
}

/**
 * nikcli's global configuration directory, from the home directory.
 *
 * Mirrors `Global.Path.config` in `packages/util/src/global.ts`: `%APPDATA%`
 * on Windows, `$XDG_CONFIG_HOME` elsewhere, both falling back to the layout
 * below. ADE cannot read the environment of a process it has not started, so
 * this is the fallback branch of that function rather than the variable — it
 * is right on every machine that has not moved AppData, and the consequence
 * of being wrong is a global roster that lists nothing, never a file written
 * in the wrong place: every write goes through a path nikcli itself printed.
 */
export function globalConfigDir(home: string, platform: "windows" | "posix"): string {
  return platform === "windows"
    ? joinPath(home, "AppData", "Roaming", "nikcli")
    : joinPath(home, ".config", "nikcli")
}

export interface CreateArgsInput {
  /** The configuration root — `agentHome(...)`, not the agent directory. */
  readonly home: string
  /** What the agent should do. nikcli's model writes the prompt from this. */
  readonly description: string
  readonly mode: AgentMode
  /** Which tools stay on. Empty means none; omit the field for all of them. */
  readonly tools?: readonly string[]
  /** Which model writes the agent, not which model the agent runs on. */
  readonly model?: string
}

/**
 * The argument list for `nikcli agent create`, in its non-interactive form.
 *
 * All four of `--path`, `--description`, `--mode` and `--tools` are required
 * together: the command decides it is non-interactive by checking that every
 * one of them is present, and with any of them missing it opens a `@clack`
 * prompt on a terminal nobody is attached to and waits there until the pane
 * is closed. `--tools ""` is the documented way to say "all of them", which
 * is why the empty string is passed rather than the flag being dropped.
 */
export function createArgs(input: CreateArgsInput): string[] {
  const args = [
    "agent",
    "create",
    "--path",
    input.home,
    "--description",
    input.description,
    "--mode",
    input.mode,
    "--tools",
    input.tools === undefined ? "" : input.tools.join(","),
  ]
  if (input.model) args.push("--model", input.model)
  return args
}

/**
 * The file `agent create` says it wrote.
 *
 * Non-interactive, the command prints the path and nothing else on stdout —
 * but the process also logs, and a shell that inherits a noisy environment
 * can put a line in front of it. The last line that looks like a markdown
 * path is the answer; anything else means the command did not get that far,
 * and the caller must show its output rather than guess at an identifier.
 */
export function parseCreatedPath(stdout: string): string | undefined {
  const lines = stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)

  for (let index = lines.length - 1; index >= 0; index--) {
    if (lines[index].toLowerCase().endsWith(".md")) return lines[index]
  }
  return undefined
}

/** The name nikcli knows a file by. */
export function identifierFromPath(path: string): string {
  return basename(path).replace(/\.md$/i, "")
}

/**
 * A legal agent identifier, or nothing.
 *
 * nikcli addresses agents by this on the command line (`--agent <name>`), so
 * a space or a quote in it is a name that cannot be started. Refused rather
 * than corrected, for the same reason a bot name is: a file the user cannot
 * find under the name they typed is worse than a form that says no.
 */
export function isLegalIdentifier(name: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,63}$/.test(name)
}

/**
 * An identifier derived from a display name, avoiding the ones taken.
 *
 * Two bots called "Revisore" are two bots; the second must not overwrite the
 * first's file — and `agent create` itself refuses to overwrite, so without
 * this the second creation fails with a message about a file rather than
 * about a name.
 */
export function identifierFor(name: string, taken: readonly string[] = []): string {
  const base =
    name
      .trim()
      .toLowerCase()
      .normalize("NFD")
      // Drop the combining marks the decomposition leaves behind, so "Perché"
      // is "perche" and not "perche" with invisible accents in the filename.
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "bot"

  if (!taken.includes(base)) return base
  for (let n = 2; n < 1000; n++) {
    const candidate = `${base}-${n}`
    if (!taken.includes(candidate)) return candidate
  }
  return `${base}-${Date.now()}`
}

export interface Frontmatter {
  readonly values: Record<string, string>
  /** One level of `key:\n  sub: true` — which is how nikcli writes `tools`. */
  readonly maps: Record<string, Record<string, boolean>>
  /**
   * Every top-level key's own source lines, exactly as they were written.
   *
   * This exists because rewriting the file must not change the *type* of a key
   * ADE does not understand, and the parsed forms above are all strings. nikcli
   * validates an agent file against a zod schema where `temperature` is a
   * number and `permission` is a nested object; writing `temperature: "0.3"`
   * back makes the file invalid, and an invalid agent file is not a bot that
   * fails to appear — `loadAgent` throws, which aborts the whole configuration
   * load, taking every other agent, command and plugin in the project with it.
   * Opening ADE's bot editor would break nikcli for that project.
   *
   * So anything not modelled here travels as text and is re-emitted byte for
   * byte. See `carriedLines`.
   */
  readonly raw: Record<string, string[]>
}

export interface ParsedAgentFile {
  readonly front: Frontmatter
  readonly prompt: string
}

/**
 * Reads an agent file: its frontmatter, and the prompt below it.
 *
 * A deliberately small YAML reader rather than a dependency, covering exactly
 * what is found in these files — the scalars gray-matter writes (including
 * the folded `>-` form it reaches for on long descriptions), the one-level
 * boolean map it writes for `tools`, and what a person types when they edit
 * one by hand. Anything it does not understand is skipped rather than thrown:
 * a roster that refuses to load because one agent has an exotic key loses the
 * other nine, and nikcli is the authority on whether the file is valid — this
 * only has to show it.
 */
export function parseAgentFile(text: string): ParsedAgentFile {
  const normalized = text.replace(/\r\n/g, "\n")
  const match = /^---\n([\s\S]*?)\n---\n?/.exec(normalized)
  if (!match) return { front: { values: {}, maps: {}, raw: {} }, prompt: normalized.trim() }

  const values: Record<string, string> = {}
  const maps: Record<string, Record<string, boolean>> = {}
  const raws: Record<string, string[]> = {}
  const lines = match[1].split("\n")

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]
    if (line.trim().length === 0 || line.trimStart().startsWith("#")) continue
    // Indented lines are consumed by whichever key opened them, below.
    if (/^\s/.test(line)) continue

    const separator = line.indexOf(":")
    if (separator === -1) continue
    const key = line.slice(0, separator).trim()
    const raw = line.slice(separator + 1).trim()
    const source = [line]
    raws[key] = source

    if (raw.length === 0 || raw === ">-" || raw === ">" || raw === "|" || raw === "|-") {
      /*
       * A block: either a nested map or a folded scalar, and which one is
       * decided by what the indented lines look like rather than by the
       * marker — gray-matter emits `>-` for a long description and a bare
       * `tools:` for the map, and a hand-edited file may have neither.
       */
      const block: string[] = []
      while (index + 1 < lines.length && (/^\s+\S/.test(lines[index + 1]) || lines[index + 1].trim() === "")) {
        index++
        block.push(lines[index])
        source.push(lines[index])
      }
      const entries: Record<string, boolean> = {}
      let looksLikeMap = block.length > 0
      for (const entry of block) {
        const at = entry.indexOf(":")
        if (at === -1 || entry.trim().length === 0) {
          if (entry.trim().length > 0) looksLikeMap = false
          continue
        }
        const name = entry.slice(0, at).trim()
        const flag = entry.slice(at + 1).trim()
        if (flag !== "true" && flag !== "false") {
          looksLikeMap = false
          continue
        }
        entries[name] = flag === "true"
      }

      if (looksLikeMap && Object.keys(entries).length > 0) {
        maps[key] = entries
        continue
      }
      // Folded: the lines join with spaces, which is what `>-` means.
      values[key] = block
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0)
        .join(" ")
      continue
    }

    values[key] = unquote(raw)
  }

  return { front: { values, maps, raw: raws }, prompt: normalized.slice(match[0].length).trim() }
}

function unquote(raw: string): string {
  if (raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')) {
    return raw.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\")
  }
  if (raw.length >= 2 && raw.startsWith("'") && raw.endsWith("'")) {
    return raw.slice(1, -1).replace(/''/g, "'")
  }
  return raw
}

/**
 * An agent file as it is written back.
 *
 * Always quoted scalars and always an explicit map: the values come from a
 * form, so they can contain a colon, a `#`, or start with a `>` — each of
 * which turns an unquoted YAML scalar into something else, and one of which
 * (`description: foo: bar`) makes the whole file unparseable and the agent
 * vanish from nikcli's list with no error in ADE.
 */
export function serializeAgentFile(input: {
  readonly description: string
  readonly mode: AgentMode
  readonly model?: string
  readonly effort?: string
  readonly disabledTools?: readonly string[]
  readonly prompt: string
  /** The chosen face, `shape/color`. Omitted when the name decides. */
  readonly avatar?: string
  /** The runner, when it is not nikcli. */
  readonly runner?: string
  /**
   * Frontmatter this writer does not model, as the source lines it came from.
   *
   * Lines rather than values, and that distinction is the whole point. The
   * schema nikcli accepts is far wider than what ADE offers — `temperature` is
   * a number, `steps` an integer, `permission` a nested object, `advisor` a
   * string — and this writer only knows how to emit quoted strings. Re-emitting
   * a number as `temperature: "0.3"` produces a file that fails nikcli's zod
   * validation, and `loadAgent` answers an invalid agent file by *throwing*:
   * the whole configuration load aborts and every agent, command and plugin in
   * that project stops working. Carrying the original text sidesteps the
   * question of type entirely.
   *
   * See `carriedLines`, which is where these come from.
   */
  readonly carried?: readonly string[]
}): string {
  const lines = ["---", `description: ${quote(input.description)}`, `mode: ${input.mode}`]
  if (input.model) lines.push(`model: ${quote(input.model)}`)
  if (input.effort) lines.push(`variant: ${quote(input.effort)}`)
  if (input.avatar) lines.push(`avatar: ${quote(input.avatar)}`)
  if (input.runner && input.runner !== "nikcli") lines.push(`runner: ${quote(input.runner)}`)
  lines.push(...(input.carried ?? []))
  if (input.disabledTools && input.disabledTools.length > 0) {
    lines.push("tools:")
    for (const tool of input.disabledTools) lines.push(`  ${tool}: false`)
  }
  lines.push("---", "", input.prompt.trim(), "")
  return lines.join("\n")
}

/**
 * The frontmatter keys this writer produces itself. Everything else is carried.
 *
 * `tools` is here because `disabledTools` reproduces it. It is deprecated in
 * nikcli — the loader rewrites it into `permission` — but reproducing what the
 * file already said is not ADE's decision to change.
 */
const KNOWN_KEYS = new Set(["description", "mode", "model", "variant", "tools", "avatar", "runner"])

/**
 * Every line of frontmatter this writer would otherwise lose.
 *
 * Returned in the order they appeared, so a file that is rewritten twice does
 * not shuffle itself and produce a diff nobody made.
 */
export function carriedLines(front: Frontmatter): string[] {
  const out: string[] = []
  for (const [key, lines] of Object.entries(front.raw)) {
    if (KNOWN_KEYS.has(key)) continue
    out.push(...lines)
  }
  return out
}

function quote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, " ")}"`
}

function readMode(raw: string | undefined): AgentMode {
  return raw === "primary" || raw === "subagent" || raw === "all" ? raw : "all"
}

/** An agent file, read. */
export function readAgentFile(input: {
  readonly path: string
  readonly scope: AgentScope
  readonly text: string
}): AgentFile {
  const parsed = parseAgentFile(input.text)
  const disabled = Object.entries(parsed.front.maps["tools"] ?? {})
    .filter(([, enabled]) => !enabled)
    .map(([tool]) => tool)

  return {
    identifier: identifierFromPath(input.path),
    path: input.path,
    scope: input.scope,
    description: parsed.front.values["description"] ?? "",
    mode: readMode(parsed.front.values["mode"]),
    ...(parsed.front.values["model"] ? { model: parsed.front.values["model"] } : {}),
    ...(parsed.front.values["variant"] ? { effort: parsed.front.values["variant"] } : {}),
    ...(parsed.front.values["avatar"] ? { avatar: parsed.front.values["avatar"] } : {}),
    ...(parsed.front.values["runner"] ? { runner: parsed.front.values["runner"] } : {}),
    prompt: parsed.prompt,
    disabledTools: disabled,
  }
}

/**
 * The same bot with its settings changed, as the file should now read.
 *
 * One function rather than a field-by-field patcher: the file is rewritten
 * whole every time, so the only safe way to change one thing is to hand the
 * writer everything — including the keys ADE does not model, which travel
 * through `extra` untouched.
 */
export function editedAgentFile(
  text: string,
  changes: {
    readonly description?: string
    readonly model?: string | undefined
    readonly effort?: string | undefined
    readonly persona?: string
    readonly objectives?: readonly string[]
    /** `undefined` in the object clears the choice; omit the key to leave it alone. */
    readonly avatar?: string | undefined
    /** Same rule as `avatar`. */
    readonly runner?: string | undefined
  },
): string {
  const parsed = parseAgentFile(text)
  const avatar = "avatar" in changes ? changes.avatar : parsed.front.values["avatar"]
  const runner = "runner" in changes ? changes.runner : parsed.front.values["runner"]
  const disabled = Object.entries(parsed.front.maps["tools"] ?? {})
    .filter(([, enabled]) => !enabled)
    .map(([tool]) => tool)
  const parts = splitPrompt(parsed.prompt)

  const model = "model" in changes ? changes.model : parsed.front.values["model"]
  /*
   * The effort stands on its own, and does not need a pinned model.
   *
   * nikcli's own description of the key says it "applies only when using the
   * agent's configured model", and that is not what the code does: the prompt
   * resolves the model as the request's, then the agent's, then the last one
   * used, and applies the agent's `variant` to whichever won. Gating on the
   * pin here would drop a setting the user made, for a reason that is only in
   * a doc comment.
   */
  const effort = "effort" in changes ? changes.effort : model ? parsed.front.values["variant"] : undefined

  return serializeAgentFile({
    description: changes.description ?? parsed.front.values["description"] ?? "",
    mode: readMode(parsed.front.values["mode"]),
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
    ...(avatar ? { avatar } : {}),
    ...(runner ? { runner } : {}),
    carried: carriedLines(parsed.front),
    disabledTools: disabled,
    prompt: joinPrompt({
      persona: changes.persona ?? parts.persona,
      objectives: changes.objectives ?? parts.objectives,
    }),
  })
}

/**
 * How a bot is started: the command the user would type themselves.
 *
 * The bare `nikcli` command is the TUI, and it takes `--agent` — so a bot
 * opens as a real interactive session in a pane, with its persona and its
 * tools, and everything the user does next is theirs. `--model` is passed
 * only when the bot pins one, because passing nikcli's own default back to it
 * as an argument is a way to break the day the default changes.
 */
export function launchArgs(identifier: string, model?: string): string[] {
  const args = ["--agent", identifier]
  if (model) args.push("--model", model)
  return args
}

/**
 * The models nikcli can use, from `nikcli models`.
 *
 * One `provider/model` per line. Taken from nikcli rather than from ADE's own
 * chat list because they are not the same set: the chat section talks to
 * OpenRouter directly, while a bot runs inside nikcli and can only be pinned
 * to something nikcli has a provider for. Offering the OpenRouter list here
 * would offer models that fail at launch with a message from another program.
 */
export function parseModelList(stdout: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const line of stdout.split("\n")) {
    const value = line.trim()
    // `--verbose` interleaves JSON; a model id is one token with one slash.
    if (!/^[\w.-]+\/[\w.:@-]+$/.test(value)) continue
    if (seen.has(value)) continue
    seen.add(value)
    out.push(value)
  }
  return out
}
