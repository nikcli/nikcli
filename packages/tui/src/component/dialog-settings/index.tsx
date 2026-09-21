import { createMemo } from "solid-js"
import { DialogSelect, type DialogSelectOption } from "@tui/ui/dialog-select"
import { useDialog, type DialogContext } from "@tui/ui/dialog"
import type { CommandOption } from "../dialog-command"
import { DialogSettingsSpinner } from "./spinner"
import { DialogSettingsPrompt } from "./prompt"
import { DialogSettingsSidebar } from "./sidebar"
import { DialogSettingsUI } from "./ui"
import { DialogSettingsBrain } from "./brain"
import { DialogSettingsDiagnostics } from "./diagnostics"
import { DialogSettingsAudio } from "./audio"
import { DialogSettingsKeybinds } from "./keybinds"
import { DialogSettingsText } from "./text"

export type SettingsCategory =
  | "spinner"
  | "prompt"
  | "sidebar"
  | "ui"
  | "text"
  | "keybinds"
  | "brain"
  | "diagnostics"
  | "audio"

type SettingsSearchEntry = {
  title: string
  keywords?: readonly string[]
}

type SettingsCategoryInfo = {
  title: string
  value: SettingsCategory
  description: string
  group: string
  keywords: readonly string[]
  settings: readonly SettingsSearchEntry[]
}

export const TEXT_CATEGORY: SettingsCategoryInfo = {
  title: "Text",
  value: "text",
  description: "Weight and dimming — the typeface is your terminal's",
  group: "Appearance",
  keywords: ["font", "typeface", "bold", "dim", "weight", "emphasis", "contrast"],
  settings: [
    { title: "Regular", keywords: ["default", "normal"] },
    { title: "Quiet", keywords: ["dim", "muted", "subtle", "low contrast"] },
    { title: "Strong", keywords: ["bold", "bright", "projector", "high contrast"] },
  ],
}

export const KEYBINDS_CATEGORY: SettingsCategoryInfo = {
  title: "Keybindings",
  value: "keybinds",
  description: "Every key the TUI answers to",
  group: "Input",
  keywords: ["keys", "shortcuts", "bindings", "hotkeys", "leader"],
  settings: [{ title: "Browse keybindings", keywords: ["list", "reference", "what does this key do"] }],
}

export const SETTINGS_CATEGORIES: readonly SettingsCategoryInfo[] = [
  {
    title: "Spinner",
    value: "spinner",
    description: "Loading animation style",
    group: "Appearance",
    keywords: ["loading", "animation", "indicator"],
    settings: [
      {
        title: "Spinner Visibility",
        keywords: ["enable", "disable", "on", "off"],
      },
      {
        title: "Spinner Style",
        keywords: ["knight rider", "braille", "dots", "line", "pulse"],
      },
    ],
  },
  {
    title: "Prompt",
    value: "prompt",
    description: "Prompt area customization",
    group: "Appearance",
    keywords: ["input", "composer"],
    settings: [
      { title: "Show Agent", keywords: ["agent name"] },
      { title: "Show Model", keywords: ["model info"] },
      { title: "Show Shortcuts", keywords: ["keyboard", "keybind", "hints"] },
      { title: "Show Sponsored", keywords: ["sponsor", "tips"] },
    ],
  },
  {
    title: "Sidebar",
    value: "sidebar",
    description: "Sidebar visibility and sections",
    group: "Layout",
    keywords: ["side panel", "navigation"],
    settings: [{ title: "Sidebar Visibility", keywords: ["auto", "show", "hide"] }],
  },
  {
    title: "UI",
    value: "ui",
    description: "General interface settings",
    group: "General",
    keywords: ["interface", "display"],
    settings: [
      { title: "Animations", keywords: ["motion", "effects"] },
      { title: "Timestamps", keywords: ["time", "messages"] },
      { title: "Thinking", keywords: ["reasoning", "chain of thought"] },
      { title: "Tool Details", keywords: ["tool output", "calls"] },
      { title: "Scrollbar", keywords: ["scroll bar"] },
    ],
  },
  {
    title: "Brain",
    value: "brain",
    description: "Memory consolidation settings",
    group: "General",
    keywords: ["memory", "consolidation"],
    settings: [
      { title: "Enable Brain", keywords: ["disable brain"] },
      { title: "Memory Consolidation", keywords: ["memory enabled"] },
      { title: "Min Hours", keywords: ["minimum hours", "interval"] },
      { title: "Min Sessions", keywords: ["minimum sessions"] },
      { title: "Brain Model", keywords: ["memory model", "provider"] },
    ],
  },
  {
    title: "Diagnostics",
    value: "diagnostics",
    description: "Token and cost instrumentation",
    group: "General",
    keywords: ["debug", "tokens", "cost", "cache", "usage"],
    settings: [
      {
        title: "Per-Turn Token Breakdown",
        keywords: ["turn tokens", "cache bust", "billing", "usage", "cost"],
      },
    ],
  },
  {
    title: "Audio",
    value: "audio",
    description: "Ambient sound feedback",
    group: "General",
    keywords: ["sound", "audio", "chime", "bell", "feedback", "mute"],
    settings: [
      {
        title: "Sound Effects",
        keywords: ["sound on", "sound off", "notification", "pulse", "volume", "mute"],
      },
    ],
  },
  TEXT_CATEGORY,
  KEYBINDS_CATEGORY,
]

export function openSettingsCategory(dialog: DialogContext, category: SettingsCategory) {
  const content = () => {
    switch (category) {
      case "spinner":
        return <DialogSettingsSpinner />
      case "prompt":
        return <DialogSettingsPrompt />
      case "sidebar":
        return <DialogSettingsSidebar />
      case "ui":
        return <DialogSettingsUI />
      case "brain":
        return <DialogSettingsBrain />
      case "diagnostics":
        return <DialogSettingsDiagnostics />
      case "audio":
        return <DialogSettingsAudio />
      case "text":
        return <DialogSettingsText />
      case "keybinds":
        return <DialogSettingsKeybinds />
    }
  }
  dialog.replace(content)
}

export function settingsCommandOptions(): CommandOption[] {
  return SETTINGS_CATEGORIES.flatMap((category) => {
    const open = (dialog: DialogContext) => openSettingsCategory(dialog, category.value)
    const context = [category.title, category.description, ...category.keywords]
    return [
      {
        title: `${category.title} Settings`,
        value: `settings.category.${category.value}`,
        description: category.description,
        category: "Settings",
        searchText: context.join(" "),
        onSelect: open,
      },
      ...category.settings.map((setting, index) => ({
        title: setting.title,
        value: `settings.${category.value}.${index}`,
        description: category.title,
        category: "Settings",
        searchText: [...context, ...(setting.keywords ?? [])].join(" "),
        onSelect: open,
      })),
    ]
  })
}

export function DialogSettings() {
  const dialog = useDialog()

  const categories = createMemo((): DialogSelectOption<SettingsCategory>[] =>
    SETTINGS_CATEGORIES.map((category) => ({
      title: category.title,
      value: category.value,
      description: category.description,
      category: category.group,
      searchText: category.keywords.join(" "),
    })),
  )

  const handleSelect = (option: DialogSelectOption<SettingsCategory>) => {
    openSettingsCategory(dialog, option.value)
  }

  return <DialogSelect title="Settings" options={categories()} onSelect={handleSelect} />
}
