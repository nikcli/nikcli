import { t } from "../i18n"
/**
 * Installing ADE's reporting hook into a CLI's own configuration.
 *
 * `agent-link.ts` describes the message; this is the part that arranges for it
 * to be sent. Both Claude Code and codex run a command of the user's choosing
 * when a session starts and hand it a JSON payload containing the session id,
 * so the whole mechanism is: put a script somewhere, add one entry to a config
 * file, and the CLI tells ADE who it is.
 *
 * ## Why this is pure, and careful
 *
 * The files involved — `~/.claude/settings.json`, `~/.codex/hooks.json` — are
 * not ADE's. On this machine each already holds four `SessionStart` entries
 * belonging to four other tools, and one of them is herdr doing exactly this.
 * A merge that reformats, reorders or quietly drops somebody else's hook is a
 * bug the user would discover much later, in another program. So the merge is
 * a pure function over text, it is tested against the real shapes of both
 * files, and every ADE entry is recognisable by {@link HOOK_MARKER} so it can
 * be found again and removed.
 *
 * Nothing here runs on its own. Installing edits files ADE does not own, which
 * is a decision, not a detail — it is offered in the settings panel with its
 * state shown, and never done at startup.
 */

/**
 * What makes an entry ADE's.
 *
 * It appears in the script's filename, and therefore inside the command
 * string, which is the only part of an entry that is guaranteed to survive a
 * user hand-editing the file. Matching on it rather than on the exact command
 * means a hook installed by an older version is still found and replaced.
 */
export const HOOK_MARKER = "ade-agent-session"

/** A CLI ADE knows how to install into. */
export interface HookTarget {
  /** The agent id ADE uses elsewhere — the key into `RESUME`. */
  readonly id: string
  /** For the settings panel. */
  readonly label: string
  /** What the script writes as `agent` in its report. */
  readonly agent: string
  /** The CLI's config file, as path segments below the home directory. */
  readonly config: readonly string[]
  /** Where ADE's script goes, as path segments below the home directory. */
  readonly script: readonly string[]
  /**
   * The CLI's event filter.
   *
   * Claude Code names the three ways a session can begin and ADE wants all
   * three: a resumed conversation has an id worth recording too. codex takes
   * no matcher at all — herdr's entry there omits the key, and that entry
   * works, so ADE's omits it as well.
   */
  readonly matcher?: string
  /**
   * Events that say whether the agent is working: the first starts a turn,
   * every other one ends it. Claude Code only — its `UserPromptSubmit` and
   * `Stop` are documented and take no matcher. codex's other events have not
   * been read off an installed config, so it gets none.
   *
   * What firstmate learned: busy or idle comes from the harness, not from how
   * the screen looks — a long turn with nothing new drawn is not an idle agent.
   */
  readonly activityEvents?: readonly string[]
}

/**
 * The two CLIs whose hook format has been read off this machine.
 *
 * Deliberately short. Several other agents have hook systems, and guessing at
 * the shape of a config file that belongs to someone else is how you corrupt
 * it. A CLI is added here once its format has been verified, not before.
 *
 * claude and pi are absent from the *need* for this — ADE pins their ids with
 * `--session-id` — but Claude Code is here anyway: the hook reports the id of
 * a conversation the user resumed or cleared from inside the CLI, which the
 * flag cannot know about.
 */
export const HOOK_TARGETS: readonly HookTarget[] = [
  {
    id: "claude-code",
    label: "Claude Code",
    agent: "claude",
    config: [".claude", "settings.json"],
    script: [".claude", "hooks", `${HOOK_MARKER}.ps1`],
    matcher: "startup|resume|clear",
    activityEvents: ["UserPromptSubmit", "Stop"],
  },
  {
    id: "codex",
    label: "Codex",
    agent: "codex",
    config: [".codex", "hooks.json"],
    script: [".codex", `${HOOK_MARKER}.ps1`],
  },
]

/** The target for an agent id, if ADE knows one. */
export function hookTarget(agentId: string): HookTarget | undefined {
  return HOOK_TARGETS.find((target) => target.id === agentId)
}

/** How the config file invokes the script. */
export function hookCommand(scriptPath: string): string {
  return `powershell -NoProfile -ExecutionPolicy Bypass -File "${scriptPath}"`
}

/** True for a command string that belongs to ADE. */
export function isAdeCommand(command: unknown): boolean {
  return typeof command === "string" && command.includes(HOOK_MARKER)
}

/** How long the CLI waits for the hook, in seconds. Writing a file is instant. */
const HOOK_TIMEOUT = 5

/**
 * A JSON object, as far as anything here is concerned.
 *
 * Everything below walks the config as untyped tables and arrays rather than
 * through an interface describing what the file "should" contain. The shape
 * is another program's, it changes when that program changes, and a modelled
 * type would be a claim about it that goes stale silently — the code reads
 * only the two fields it needs and copies the rest through untouched.
 */
type Table = Record<string, unknown>

function isTable(value: unknown): value is Table {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

/** The `SessionStart` groups of a config, as tables, or nothing. */
function sessionStart(config: Table): Table[] {
  const hooks = config.hooks
  if (!isTable(hooks)) return []
  const groups = hooks.SessionStart
  if (!Array.isArray(groups)) return []
  return groups.filter(isTable)
}

/** The commands inside one group. */
function leaves(group: Table): unknown[] {
  return Array.isArray(group.hooks) ? group.hooks : []
}

function commandOf(leaf: unknown): string | undefined {
  if (!isTable(leaf)) return undefined
  return typeof leaf.command === "string" ? leaf.command : undefined
}

/**
 * The command ADE currently has installed in this config, if any.
 *
 * Returns the command rather than a boolean so the caller can tell an entry
 * pointing at the right script from one left over at an old path — the second
 * is installed, and broken, and the panel should say so.
 */
export function installedCommand(configText: string | undefined): string | undefined {
  for (const group of sessionStart(parse(configText))) {
    for (const leaf of leaves(group)) {
      const command = commandOf(leaf)
      if (command !== undefined && isAdeCommand(command)) return command
    }
  }
  return undefined
}

/**
 * The config with ADE's entry present exactly once, and nothing else touched.
 *
 * Removes first and then appends, so reinstalling after a path change leaves
 * one entry rather than two, and so the entry always ends up last — the order
 * of `SessionStart` groups is the order they run in, and ADE's is the one that
 * matters least.
 */
export function installHook(
  configText: string | undefined,
  command: string,
  matcher?: string,
  activityEvents: readonly string[] = [],
): string {
  const config = withoutAde(parse(configText))
  const hooks: Table = isTable(config.hooks) ? config.hooks : {}
  config.hooks = hooks
  const leaf = { type: "command", command, timeout: HOOK_TIMEOUT }
  const append = (event: string, group: Table) => {
    const groups: unknown[] = Array.isArray(hooks[event]) ? (hooks[event] as unknown[]) : []
    groups.push(group)
    hooks[event] = groups
  }
  append("SessionStart", matcher === undefined ? { hooks: [leaf] } : { matcher, hooks: [leaf] })
  for (const event of activityEvents) append(event, { hooks: [{ ...leaf }] })
  return render(config)
}

/** The activity events this config does not send to ADE yet. */
export function missingActivityEvents(configText: string | undefined, events: readonly string[] = []): string[] {
  const config = parse(configText)
  const hooks = isTable(config.hooks) ? config.hooks : {}
  return events.filter((event) => {
    const groups = Array.isArray(hooks[event]) ? (hooks[event] as unknown[]).filter(isTable) : []
    return !groups.some((group) => leaves(group).some((leaf) => isAdeCommand(commandOf(leaf))))
  })
}

/**
 * The config with ADE's entry gone and everyone else's intact.
 *
 * A group that held nothing but ADE's hook goes with it; a group that held
 * ADE's hook beside someone else's keeps the someone else. `SessionStart`
 * itself is left in place even when it ends up empty, because an empty array
 * the user can see is less surprising than a key that vanished.
 */
export function removeHook(configText: string | undefined): string {
  return render(withoutAde(parse(configText)))
}

function withoutAde(config: Table): Table {
  const hooks = config.hooks
  if (!isTable(hooks)) return config
  // Every event: ADE's entries are under SessionStart and, for Claude Code, the activity events too.
  for (const event of Object.keys(hooks)) {
    if (Array.isArray(hooks[event])) withoutAdeIn(hooks, event)
  }
  return config
}

function withoutAdeIn(hooks: Table, event: string): void {
  const groups = hooks[event] as unknown[]
  // An event that never held an ADE entry is left exactly as it was, down to its object identity.
  const touched = groups.some((group) => isTable(group) && leaves(group).some((leaf) => isAdeCommand(commandOf(leaf))))
  if (!touched) return

  const kept: unknown[] = []
  for (const group of groups) {
    // Anything that is not a group of hooks is somebody's hand edit, and goes
    // back exactly as it came.
    if (!isTable(group) || !Array.isArray(group.hooks)) {
      kept.push(group)
      continue
    }
    const mine = group.hooks.filter((leaf) => {
      const command = commandOf(leaf)
      return command !== undefined && isAdeCommand(command)
    })
    if (mine.length === 0) {
      kept.push(group)
      continue
    }
    const others = group.hooks.filter((leaf) => !mine.includes(leaf))
    if (others.length === 0) continue
    kept.push({ ...group, hooks: others })
  }
  // SessionStart stays even empty (see removeHook); an activity event emptied of ADE's entry was ADE's to begin with.
  if (kept.length === 0 && event !== "SessionStart") delete hooks[event]
  else hooks[event] = kept
}

/**
 * The file as an object, or an empty one.
 *
 * A config that does not parse is treated as absent rather than as an error,
 * and `render` then writes a valid file over it. That is the right trade for
 * a file this small: the alternative is refusing to install because of a
 * stray comma, in a file the user cannot see from inside ADE.
 */
function parse(text: string | undefined): Table {
  if (text === undefined || text.trim().length === 0) return {}
  try {
    const parsed: unknown = JSON.parse(text)
    return isTable(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

/** Two-space JSON with a trailing newline: what both files already are. */
function render(config: Table): string {
  return `${JSON.stringify(config, null, 2)}\n`
}

// ---------------------------------------------------------------------------
// Reading and changing the state, given something that can touch the files
// ---------------------------------------------------------------------------

/**
 * The two host calls this needs, and no more.
 *
 * Declared structurally rather than imported from `host/shell.ts` so the
 * tests can drive it with two functions and a string, and so the merge above
 * stays the only thing in this file that knows a file format.
 */
export interface HookHost {
  readAgentHook?: (agent: string) => Promise<{
    configPath: string
    configText: string | null
    scriptPath: string
    scriptPresent: boolean
  }>
  writeAgentHook?: (agent: string, configText: string, script: string | null) => Promise<void>
}

/** What the settings panel shows for one CLI. */
export interface HookStatus {
  readonly target: HookTarget
  /** The hook is installed and points at the script that is there. */
  readonly installed: boolean
  /**
   * There is an ADE entry, but it does not match what is on disk.
   *
   * Either the entry points somewhere else — an install from an older version
   * — or the script it names is missing. Both mean the CLI is running a hook
   * that does nothing, or failing to run one, and both are fixed by
   * installing again, which is why the panel says so rather than showing the
   * row as simply "off".
   */
  readonly broken: boolean
  readonly configPath: string
  readonly scriptPath: string
  /** Set when the state could not be read at all. */
  readonly error?: string
}

/** What ADE has installed for this CLI right now. */
export async function readHookStatus(host: HookHost, target: HookTarget): Promise<HookStatus> {
  const read = host.readAgentHook
  if (!read) {
    return {
      target,
      installed: false,
      broken: false,
      configPath: "",
      scriptPath: "",
      error: t("hooks.unavailable"),
    }
  }
  try {
    const files = await read(target.id)
    const command = installedCommand(files.configText ?? undefined)
    const wanted = hookCommand(files.scriptPath)
    return {
      target,
      installed: command === wanted && files.scriptPresent,
      broken: command !== undefined && (command !== wanted || !files.scriptPresent),
      configPath: files.configPath,
      scriptPath: files.scriptPath,
    }
  } catch (error) {
    return {
      target,
      installed: false,
      broken: false,
      configPath: "",
      scriptPath: "",
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

/**
 * Installs or removes the hook, and answers with the state afterwards.
 *
 * Reads the configuration again immediately before writing it, rather than
 * trusting the copy the panel was rendered from: the file belongs to another
 * program, the panel may have been open for an hour, and the merge is only
 * safe against the text that is actually there.
 */
export async function setHook(host: HookHost, target: HookTarget, install: boolean): Promise<HookStatus> {
  const read = host.readAgentHook
  const write = host.writeAgentHook
  if (!read || !write) return readHookStatus(host, target)

  const files = await read(target.id)
  const current = files.configText ?? undefined
  if (install) {
    const command = hookCommand(files.scriptPath)
    await write(target.id, installHook(current, command, target.matcher, target.activityEvents), hookScript(target.agent))
  } else {
    await write(target.id, removeHook(current), null)
  }
  return readHookStatus(host, target)
}

/**
 * Rewrites an installed hook's script with this version's, config untouched.
 *
 * The script is ADE's own file and changes when ADE does (it began sending
 * `source`); an install from an older version would otherwise keep the old
 * one until the user thought to reinstall. The config is written back as the
 * exact text just read, because `writeAgentHook` writes both halves and the
 * config is not ADE's to reformat. Done only when `lastWritten` differs, so a
 * launch with nothing new does not touch another program's settings file.
 * Answers the script now on disk, for the caller to remember.
 */
export async function refreshHookScript(
  host: HookHost,
  target: HookTarget,
  lastWritten: string | undefined,
): Promise<string | undefined> {
  const script = hookScript(target.agent)
  if (lastWritten === script || !host.readAgentHook || !host.writeAgentHook) return undefined
  const files = await host.readAgentHook(target.id)
  const command = installedCommand(files.configText ?? undefined)
  if (files.configText === null || !files.scriptPresent || command !== hookCommand(files.scriptPath)) return undefined
  // An install from before the activity events gets them too; otherwise the config goes back as it was read.
  const missing = missingActivityEvents(files.configText, target.activityEvents)
  const config =
    missing.length > 0 ? installHook(files.configText, command, target.matcher, target.activityEvents) : files.configText
  await host.writeAgentHook(target.id, config, script)
  return script
}

/**
 * The script the config points at.
 *
 * Windows PowerShell, and only that. A hook that is subtly wrong does not
 * fail — it writes nothing, or writes the wrong id, and the pane silently
 * resumes into someone else's conversation. Both formats here were read off
 * an installed hook on this machine; a POSIX variant would be written from
 * memory, so it is not written at all, and {@link installHook} is offered
 * only where this script can run.
 *
 * The guards, in order, are the reason this is safe to leave installed:
 *
 * - no `ADE_SPAWN_NONCE` means the CLI was not started by ADE, so the hook
 *   does nothing at all and costs a process start;
 * - `hook_event_name` is checked because the same script is reachable from
 *   more than one event once a user adds their own entries;
 * - `CODEX_THREAD_ID` disagreeing with the payload means this is a nested
 *   thread reporting the wrong id, which is herdr's guard and a real case.
 *
 * The file is written beside its destination and moved into place, so a
 * reader that arrives mid-write sees either nothing or a whole report.
 */
export function hookScript(agent: string): string {
  return `# installed by ADE — ${HOOK_MARKER}
# ADE overwrites this file when the integration is reinstalled.
# to add your own hook, add another entry beside this one in the config.

if ([string]::IsNullOrWhiteSpace($env:ADE_SPAWN_NONCE)) { exit 0 }
if ([string]::IsNullOrWhiteSpace($env:ADE_PANE_ID)) { exit 0 }
if ([string]::IsNullOrWhiteSpace($env:ADE_SESSION_DIR)) { exit 0 }
if (-not (Test-Path -LiteralPath $env:ADE_SESSION_DIR)) { exit 0 }

$raw = [Console]::In.ReadToEnd()
if ([string]::IsNullOrWhiteSpace($raw)) { exit 0 }
try { $payload = $raw | ConvertFrom-Json } catch { exit 0 }

$sessionId = $payload.session_id
if ([string]::IsNullOrWhiteSpace($sessionId)) { exit 0 }

# A turn starting or ending: whether the agent is working, for ADE to wait on or remind.
$event = "$($payload.hook_event_name)"
if ($event -eq "UserPromptSubmit" -or $event -eq "Stop") {
  $activity = [ordered]@{
    state     = $(if ($event -eq "Stop") { "idle" } else { "busy" })
    sessionId = "$sessionId"
    cwd       = "$($payload.cwd)"
    at        = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  }
  $target = Join-Path $env:ADE_SESSION_DIR ("$env:ADE_SPAWN_NONCE" + ".activity")
  $staging = $target + ".part"
  try {
    [IO.File]::WriteAllText($staging, ($activity | ConvertTo-Json -Compress), (New-Object Text.UTF8Encoding $false))
    Move-Item -LiteralPath $staging -Destination $target -Force
  } catch {}
  exit 0
}

if ($event -and $event -ne "SessionStart") { exit 0 }
if (-not [string]::IsNullOrWhiteSpace($env:CODEX_THREAD_ID) -and $env:CODEX_THREAD_ID -ne $sessionId) { exit 0 }

$report = [ordered]@{
  pane      = "$env:ADE_PANE_ID"
  nonce     = "$env:ADE_SPAWN_NONCE"
  agent     = "${agent}"
  sessionId = "$sessionId"
  source    = "$($payload.source)"
  at        = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
}

$target = Join-Path $env:ADE_SESSION_DIR ("$env:ADE_SPAWN_NONCE" + ".json")
$staging = $target + ".part"
try {
  $json = $report | ConvertTo-Json -Compress
  [IO.File]::WriteAllText($staging, $json, (New-Object Text.UTF8Encoding $false))
  Move-Item -LiteralPath $staging -Destination $target -Force
} catch {
  exit 0
}
`
}
