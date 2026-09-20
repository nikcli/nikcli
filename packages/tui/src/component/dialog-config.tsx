import { createMemo } from "solid-js"
import { useSync } from "@tui/context/sync"
import { useSDK } from "@tui/context/sdk"
import { useDialog } from "@tui/ui/dialog"
import { useToast } from "../ui/toast"
import { DialogPrompt } from "../ui/dialog-prompt"
import { DialogSelect, type DialogSelectOption } from "@tui/ui/dialog-select"
import { entries } from "remeda"

type ConfigCategory = "agent" | "provider" | "mcp" | "connectors" | "permission" | "formatter" | "lsp" | "command"

function ConfigCategoryList() {
  const sync = useSync()
  const dialog = useDialog()

  const categories = createMemo((): DialogSelectOption<ConfigCategory>[] => {
    const config = sync.data.config as any
    const result: DialogSelectOption<ConfigCategory>[] = []

    if (config?.agent && Object.keys(config.agent).length > 0) {
      result.push({
        title: "Agents",
        value: "agent",
        description: `Configured: ${Object.keys(config.agent).join(", ")}`,
        category: "Configuration",
      })
    }

    if (config?.provider && Object.keys(config.provider).length > 0) {
      result.push({
        title: "Providers",
        value: "provider",
        description: `Configured: ${Object.keys(config.provider).join(", ")}`,
        category: "Configuration",
      })
    }

    if (config?.mcp && Object.keys(config.mcp).length > 0) {
      result.push({
        title: "MCP Servers",
        value: "mcp",
        description: `Configured: ${Object.keys(config.mcp).join(", ")}`,
        category: "Configuration",
      })
    }

    if (config?.connectors && Object.keys(config.connectors).length > 0) {
      result.push({
        title: "Connectors",
        value: "connectors",
        description: `Configured: ${Object.keys(config.connectors).join(", ")}`,
        category: "Configuration",
      })
    }

    if (config?.permission) {
      result.push({
        title: "Permissions",
        value: "permission",
        description: "Tool and action permissions",
        category: "Configuration",
      })
    }

    if (config?.formatter) {
      result.push({
        title: "Formatters",
        value: "formatter",
        description: "Code formatter configurations",
        category: "Configuration",
      })
    }

    if (config?.lsp) {
      result.push({
        title: "LSP Servers",
        value: "lsp",
        description: "Language server configurations",
        category: "Configuration",
      })
    }

    if (config?.command && Object.keys(config.command).length > 0) {
      result.push({
        title: "Commands",
        value: "command",
        description: `Configured: ${Object.keys(config.command).join(", ")}`,
        category: "Configuration",
      })
    }

    if (result.length === 0) {
      result.push({
        title: "No configurations found",
        value: "agent" as ConfigCategory,
        description: "Add configurations to your nikcli.json",
        category: "Info",
        disabled: true,
      })
    }

    return result
  })

  const handleSelect = (option: DialogSelectOption<ConfigCategory>) => {
    dialog.replace(() => <ConfigCategoryDetail category={option.value} />)
  }

  return <DialogSelect title="Config Editor" options={categories()} onSelect={handleSelect} />
}

function ConfigCategoryDetail(props: { category: ConfigCategory }) {
  const sync = useSync()
  const sdk = useSDK()
  const dialog = useDialog()
  const toast = useToast()

  const config = createMemo(() => (sync.data.config as any)?.[props.category] || {})

  const items = createMemo(() => {
    const cfg = config()
    return entries(cfg).map(([key, value]) => ({
      key,
      value: typeof value === "object" ? JSON.stringify(value, null, 2) : String(value),
    }))
  })

  const handleEdit = async (key: string) => {
    const currentValue = config()[key]
    const currentStr = typeof currentValue === "object" ? JSON.stringify(currentValue, null, 2) : String(currentValue)

    const result = await DialogPrompt.show(dialog, `Edit ${props.category}.${key}`, {
      placeholder: "Enter JSON value",
      value: currentStr,
    })

    if (result === null) return

    try {
      let parsed = result
      try {
        parsed = JSON.parse(result)
      } catch {
        parsed = result
      }

      await sdk.client.config.update({
        payload: {
          [props.category]: {
            [key]: parsed,
          },
        } as any,
      })

      toast.show({ message: `Updated ${props.category}.${key}`, variant: "success" })
      dialog.replace(() => <ConfigCategoryDetail category={props.category} />)
    } catch (error: any) {
      toast.show({ message: `Failed to update: ${error.message}`, variant: "error" })
    }
  }

  const handleAdd = async () => {
    const result = await DialogPrompt.show(dialog, `Add new ${props.category} key`, {
      placeholder: "Enter key name",
    })

    if (!result) return

    const key = result.trim()
    if (!key) return

    const valueResult = await DialogPrompt.show(dialog, `Enter value for ${key}`, {
      placeholder: "Enter JSON value (or plain text)",
      value: "{}",
    })

    if (valueResult === null) return

    try {
      let parsed = valueResult
      try {
        parsed = JSON.parse(valueResult)
      } catch {
        parsed = valueResult
      }

      await sdk.client.config.update({
        payload: {
          [props.category]: {
            [key]: parsed,
          },
        } as any,
      })

      toast.show({ message: `Added ${props.category}.${key}`, variant: "success" })
      dialog.replace(() => <ConfigCategoryDetail category={props.category} />)
    } catch (error: any) {
      toast.show({ message: `Failed to add: ${error.message}`, variant: "error" })
    }
  }

  const options = createMemo(() => {
    const baseItems = items().map((item) => ({
      title: item.key,
      value: item.key,
      description: item.value.substring(0, 100) + (item.value.length > 100 ? "..." : ""),
      category: "Entries" as const,
      onSelect: () => handleEdit(item.key),
    }))

    return [
      {
        title: "+ Add new",
        value: "__add__",
        description: `Add a new ${props.category} entry`,
        category: "Actions" as const,
        onSelect: () => handleAdd(),
      },
      ...baseItems,
    ]
  })

  return <DialogSelect title={props.category.charAt(0).toUpperCase() + props.category.slice(1)} options={options()} />
}

export function DialogConfig() {
  const sync = useSync()
  const dialog = useDialog()
  const sdk = useSDK()
  const toast = useToast()

  const config = createMemo(() => sync.data.config as any)

  const hasConfig = createMemo(() => {
    const cfg = config()
    return cfg && Object.keys(cfg).length > 0
  })

  const handleEditFull = async () => {
    const result = await DialogPrompt.show(dialog, "Edit Full Config", {
      placeholder: "Enter JSON configuration",
      value: JSON.stringify(config(), null, 2),
    })

    if (result === null) return

    try {
      const parsed = JSON.parse(result)
      await sdk.client.config.update({ payload: parsed })
      toast.show({ message: "Config updated", variant: "success" })
    } catch (error: any) {
      toast.show({ message: `Invalid JSON: ${error.message}`, variant: "error" })
    }
  }

  const handleAddNew = () => {
    dialog.replace(() => <ConfigCategoryList />)
  }

  return (
    <DialogSelect
      title="Config Editor"
      options={[
        {
          title: "Browse by Category",
          value: "browse",
          description: "View and edit configurations by category",
          category: "Actions",
          onSelect: () => handleAddNew(),
        },
        {
          title: "Edit Full Config JSON",
          value: "edit",
          description: "Edit the entire configuration as JSON",
          category: "Actions",
          onSelect: () => handleEditFull(),
        },
        {
          title: "View Config",
          value: "view",
          description: hasConfig() ? `${Object.keys(config()).length} config keys` : "No configuration found",
          category: "Info",
        },
      ]}
    />
  )
}

export function DialogConfigEditor() {
  return <ConfigCategoryList />
}
