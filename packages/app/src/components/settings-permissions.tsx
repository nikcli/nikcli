import type {
  PermissionActionConfig,
  PermissionConfig,
  PermissionObjectConfig,
  PermissionRuleConfig,
} from "@nikcli-ai/sdk/httpapi"
import { Select } from "@nikcli-ai/ui/select"
import { showToast } from "@nikcli-ai/ui/toast"
import { Component, For, createMemo, type JSX } from "solid-js"
import { useGlobalSync } from "@/context/global-sync"
import { useLanguage } from "@/context/language"

// Sourced from the HTTP contract so the editor cannot produce a permission
// shape the server would reject; the runtime `Array.isArray` guards below stay
// as a defence against older config files.
export type PermissionAction = PermissionActionConfig
export type PermissionObject = PermissionObjectConfig
export type PermissionValue = PermissionRuleConfig | undefined
export type PermissionMap = PermissionConfig
export type PermissionPreset = "require_approval" | "approve_for_me" | "auto" | "full_access"
export type PermissionMode = PermissionPreset | "custom"
/** The server-side permission mode (`permission_mode` in nikcli.json). */
export type PermissionModeSetting = "default" | "auto"

type PermissionItem = {
  id: string
  title: string
  description: string
}

const PERMISSION_TOOL_KEYS = [
  "read",
  "edit",
  "glob",
  "grep",
  "list",
  "tree",
  "bash",
  "task",
  "skill",
  "lsp",
  "todoread",
  "todowrite",
  "webfetch",
  "websearch",
  "codesearch",
  "external_directory",
  "doom_loop",
  "browser_control",
  "computer",
  "repo_clone",
  "repo_overview",
  "generate_image",
  "memory_search",
  "context_collect",
  "context_search",
  "context_related",
  "context_diagnostics",
  "rag_index",
  "rag_search",
  "rag_status",
  "rag_reset",
  "speak",
] as const

const INTERNAL_DENY_PERMISSION_KEYS = ["question", "plan_enter", "plan_exit"] as const

const APPROVE_FOR_ME_PERMISSIONS: PermissionMap = {
  "*": "allow",
  read: {
    "*": "allow",
    "*.env": "ask",
    "*.env.*": "ask",
    "*.env.example": "allow",
  },
  edit: "allow",
  glob: "allow",
  grep: "allow",
  list: "allow",
  tree: "allow",
  task: "allow",
  skill: "allow",
  lsp: "allow",
  todoread: "allow",
  todowrite: "allow",
  repo_overview: "allow",
  context_collect: "allow",
  context_search: "allow",
  context_related: "allow",
  context_diagnostics: "allow",
  rag_search: "allow",
  rag_status: "allow",
  speak: "allow",
  bash: "ask",
  webfetch: "ask",
  websearch: "ask",
  codesearch: "ask",
  external_directory: "ask",
  doom_loop: "ask",
  browser_control: "ask",
  computer: "ask",
  repo_clone: "ask",
  generate_image: "ask",
  memory_search: "ask",
  rag_index: "ask",
  rag_reset: "ask",
  question: "deny",
  plan_enter: "deny",
  plan_exit: "deny",
}

export const PERMISSION_PRESETS = ["require_approval", "approve_for_me", "auto", "full_access"] as const

const ACTIONS = [
  { value: "allow", label: "settings.permissions.action.allow" },
  { value: "ask", label: "settings.permissions.action.ask" },
  { value: "deny", label: "settings.permissions.action.deny" },
] as const

export const PERMISSION_ITEMS = [
  {
    id: "read",
    title: "settings.permissions.tool.read.title",
    description: "settings.permissions.tool.read.description",
  },
  {
    id: "edit",
    title: "settings.permissions.tool.edit.title",
    description: "settings.permissions.tool.edit.description",
  },
  {
    id: "glob",
    title: "settings.permissions.tool.glob.title",
    description: "settings.permissions.tool.glob.description",
  },
  {
    id: "grep",
    title: "settings.permissions.tool.grep.title",
    description: "settings.permissions.tool.grep.description",
  },
  {
    id: "list",
    title: "settings.permissions.tool.list.title",
    description: "settings.permissions.tool.list.description",
  },
  {
    id: "bash",
    title: "settings.permissions.tool.bash.title",
    description: "settings.permissions.tool.bash.description",
  },
  {
    id: "task",
    title: "settings.permissions.tool.task.title",
    description: "settings.permissions.tool.task.description",
  },
  {
    id: "skill",
    title: "settings.permissions.tool.skill.title",
    description: "settings.permissions.tool.skill.description",
  },
  {
    id: "lsp",
    title: "settings.permissions.tool.lsp.title",
    description: "settings.permissions.tool.lsp.description",
  },
  {
    id: "todoread",
    title: "settings.permissions.tool.todoread.title",
    description: "settings.permissions.tool.todoread.description",
  },
  {
    id: "todowrite",
    title: "settings.permissions.tool.todowrite.title",
    description: "settings.permissions.tool.todowrite.description",
  },
  {
    id: "webfetch",
    title: "settings.permissions.tool.webfetch.title",
    description: "settings.permissions.tool.webfetch.description",
  },
  {
    id: "websearch",
    title: "settings.permissions.tool.websearch.title",
    description: "settings.permissions.tool.websearch.description",
  },
  {
    id: "codesearch",
    title: "settings.permissions.tool.codesearch.title",
    description: "settings.permissions.tool.codesearch.description",
  },
  {
    id: "external_directory",
    title: "settings.permissions.tool.external_directory.title",
    description: "settings.permissions.tool.external_directory.description",
  },
  {
    id: "doom_loop",
    title: "settings.permissions.tool.doom_loop.title",
    description: "settings.permissions.tool.doom_loop.description",
  },
] as const

const VALID_ACTIONS = new Set<PermissionAction>(["allow", "ask", "deny"])

export function toPermissionMap(value: unknown): PermissionMap {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as PermissionMap

  const action = getPermissionAction(value)
  if (action) return { "*": action }

  return {}
}

export function getPermissionAction(value: unknown): PermissionAction | undefined {
  if (typeof value === "string" && VALID_ACTIONS.has(value as PermissionAction)) return value as PermissionAction
  return
}

export function getPermissionRuleDefault(value: unknown): PermissionAction | undefined {
  const action = getPermissionAction(value)
  if (action) return action

  if (!value || typeof value !== "object" || Array.isArray(value)) return

  return getPermissionAction((value as Record<string, unknown>)["*"])
}

export function getPermissionActionFor(map: PermissionMap, id: string, fallback: PermissionAction = "allow") {
  const direct = getPermissionRuleDefault(map[id])
  if (direct) return direct

  const wildcard = getPermissionRuleDefault(map["*"])
  if (wildcard) return wildcard

  return fallback
}

function hasRuleAction(value: PermissionValue, action: PermissionAction) {
  if (getPermissionAction(value) === action) return true
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  return Object.values(value).some((entry) => entry === action)
}

function uniformPermissionPatch(action: PermissionAction): PermissionMap {
  const patch: PermissionMap = { "*": action }
  for (const key of PERMISSION_TOOL_KEYS) patch[key] = action
  for (const key of INTERNAL_DENY_PERMISSION_KEYS) patch[key] = "deny"
  return patch
}

function clonePermissionMap(map: PermissionMap): PermissionMap {
  return Object.fromEntries(
    Object.entries(map).map(([key, value]) => [
      key,
      value && typeof value === "object" && !Array.isArray(value) ? { ...value } : value,
    ]),
  )
}

/**
 * Auto is a permission *mode*, not a ruleset: it keeps the current rules and
 * sends what they would prompt for to the auto mode classifier. Selecting it
 * writes `permission_mode: "auto"` and leaves the permission map alone; every
 * other preset writes its map and sets the mode back to `default`.
 */
export function presetPermissionMode(preset: PermissionPreset): PermissionModeSetting {
  return preset === "auto" ? "auto" : "default"
}

export function permissionPresetPatch(preset: PermissionPreset): PermissionMap {
  if (preset === "auto") return {}
  if (preset === "require_approval") return uniformPermissionPatch("ask")
  if (preset === "full_access") return uniformPermissionPatch("allow")
  return clonePermissionMap(APPROVE_FOR_ME_PERMISSIONS)
}

export function detectPermissionMode(value: unknown, permissionMode?: unknown): PermissionMode {
  if (permissionMode === "auto") return "auto"
  const map = toPermissionMap(value)
  if (Object.keys(map).length === 0) return "approve_for_me"

  const strict = getPermissionRuleDefault(map["*"]) === "ask"
  if (strict && PERMISSION_TOOL_KEYS.every((key) => getPermissionActionFor(map, key, "ask") === "ask")) {
    return "require_approval"
  }

  const full = getPermissionRuleDefault(map["*"]) === "allow"
  if (
    full &&
    PERMISSION_TOOL_KEYS.every((key) => getPermissionActionFor(map, key) === "allow") &&
    !Object.entries(map).some(
      ([key, value]) =>
        !INTERNAL_DENY_PERMISSION_KEYS.includes(key as (typeof INTERNAL_DENY_PERMISSION_KEYS)[number]) &&
        (hasRuleAction(value, "ask") || hasRuleAction(value, "deny")),
    )
  ) {
    return "full_access"
  }

  const approveForMe =
    getPermissionRuleDefault(map["*"]) === "allow" &&
    getPermissionActionFor(map, "edit") === "allow" &&
    getPermissionActionFor(map, "bash") === "ask" &&
    getPermissionActionFor(map, "webfetch") === "ask" &&
    getPermissionActionFor(map, "websearch") === "ask" &&
    getPermissionActionFor(map, "external_directory") === "ask"

  return approveForMe ? "approve_for_me" : "custom"
}

export const SettingsPermissions: Component = () => {
  const globalSync = useGlobalSync()
  const language = useLanguage()

  const actions = createMemo(
    (): Array<{ value: PermissionAction; label: string }> =>
      ACTIONS.map((action) => ({
        value: action.value,
        label: language.t(action.label),
      })),
  )

  const permission = createMemo(() => {
    return toPermissionMap(globalSync.data.config.permission)
  })

  const actionFor = (id: string): PermissionAction => getPermissionActionFor(permission(), id)

  const setPermission = async (id: string, action: PermissionAction) => {
    const before = globalSync.data.config.permission
    const map = toPermissionMap(before)
    const existing = map[id]

    const nextValue =
      existing && typeof existing === "object" && !Array.isArray(existing) ? { ...existing, "*": action } : action

    globalSync.set("config", "permission", { ...map, [id]: nextValue })
    globalSync.updateConfig({ permission: { [id]: nextValue } }).catch((err: unknown) => {
      globalSync.set("config", "permission", before)
      const message = err instanceof Error ? err.message : String(err)
      showToast({ title: language.t("settings.permissions.toast.updateFailed.title"), description: message })
    })
  }

  return (
    <div class="flex flex-col h-full overflow-y-auto no-scrollbar">
      <div class="sticky top-0 z-10 bg-[linear-gradient(to_bottom,var(--surface-raised-stronger-non-alpha)_calc(100%_-_24px),transparent)]">
        <div class="flex flex-col gap-1 px-4 py-8 sm:p-8 max-w-[720px]">
          <h2 class="text-16-medium text-text-strong">{language.t("settings.permissions.title")}</h2>
          <p class="text-14-regular text-text-weak">{language.t("settings.permissions.description")}</p>
        </div>
      </div>

      <div class="flex flex-col gap-6 px-4 py-6 sm:p-8 sm:pt-6 max-w-[720px]">
        <div class="flex flex-col gap-2">
          <h3 class="text-14-medium text-text-strong">{language.t("settings.permissions.section.tools")}</h3>
          <div class="border border-border-weak-base rounded-lg overflow-hidden">
            <For each={PERMISSION_ITEMS}>
              {(item) => (
                <SettingsRow title={language.t(item.title)} description={language.t(item.description)}>
                  <Select
                    options={actions()}
                    current={actions().find((o) => o.value === actionFor(item.id))}
                    value={(o) => o.value}
                    label={(o) => o.label}
                    onSelect={(option) => option && setPermission(item.id, option.value)}
                    variant="secondary"
                    size="small"
                    triggerVariant="settings"
                  />
                </SettingsRow>
              )}
            </For>
          </div>
        </div>
      </div>
    </div>
  )
}

interface SettingsRowProps {
  title: string
  description: string
  children: JSX.Element
}

const SettingsRow: Component<SettingsRowProps> = (props) => {
  return (
    <div class="flex flex-wrap items-center justify-between gap-4 px-4 py-3 border-b border-border-weak-base last:border-none">
      <div class="flex flex-col gap-0.5 min-w-0">
        <span class="text-14-medium text-text-strong">{props.title}</span>
        <span class="text-12-regular text-text-weak">{props.description}</span>
      </div>
      <div class="flex-shrink-0">{props.children}</div>
    </div>
  )
}
