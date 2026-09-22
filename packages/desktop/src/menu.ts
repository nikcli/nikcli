import { Menu, MenuItem, PredefinedMenuItem, Submenu } from "@tauri-apps/api/menu"
import { type as ostype } from "@tauri-apps/plugin-os"
import { relaunch } from "@tauri-apps/plugin-process"
import { openUrl } from "@tauri-apps/plugin-opener"

import { runUpdater, UPDATER_ENABLED } from "./updater"
import { installCli } from "./cli"
import { initI18n, t } from "./i18n"
import { commands } from "./bindings"

export async function createMenu(trigger: (id: string) => void) {
  if (ostype() !== "macos") return

  await initI18n()

  const menu = await Menu.new({
    items: [
      await Submenu.new({
        text: "Nikcli",
        items: [
          await PredefinedMenuItem.new({
            item: { About: null },
          }),
          await MenuItem.new({
            enabled: UPDATER_ENABLED,
            action: () => runUpdater({ alertOnFail: true }),
            text: t("desktop.menu.checkForUpdates"),
          }),
          await MenuItem.new({
            action: () => installCli(),
            text: t("desktop.menu.installCli"),
          }),
          await MenuItem.new({
            action: async () => window.location.reload(),
            text: t("desktop.menu.reloadWebview"),
          }),
          await MenuItem.new({
            action: async () => {
              await commands.killSidecar().catch(() => undefined)
              await relaunch().catch(() => undefined)
            },
            text: t("desktop.menu.restart"),
          }),
          await PredefinedMenuItem.new({
            item: "Separator",
          }),
          await PredefinedMenuItem.new({
            item: "Hide",
          }),
          await PredefinedMenuItem.new({
            item: "HideOthers",
          }),
          await PredefinedMenuItem.new({
            item: "ShowAll",
          }),
          await PredefinedMenuItem.new({
            item: "Separator",
          }),
          await PredefinedMenuItem.new({
            item: "Quit",
          }),
        ].filter(Boolean),
      }),
      await Submenu.new({
        text: t("desktop.menu.file"),
        items: [
          await MenuItem.new({
            text: t("command.session.new"),
            accelerator: "Shift+Cmd+S",
            action: () => trigger("session.new"),
          }),
          await MenuItem.new({
            text: t("command.project.open"),
            accelerator: "Cmd+O",
            action: () => trigger("project.open"),
          }),
          await PredefinedMenuItem.new({
            item: "Separator",
          }),
          await PredefinedMenuItem.new({
            item: "CloseWindow",
          }),
        ],
      }),
      await Submenu.new({
        text: t("desktop.menu.edit"),
        items: [
          await PredefinedMenuItem.new({
            item: "Undo",
          }),
          await PredefinedMenuItem.new({
            item: "Redo",
          }),
          await PredefinedMenuItem.new({
            item: "Separator",
          }),
          await PredefinedMenuItem.new({
            item: "Cut",
          }),
          await PredefinedMenuItem.new({
            item: "Copy",
          }),
          await PredefinedMenuItem.new({
            item: "Paste",
          }),
          await PredefinedMenuItem.new({
            item: "SelectAll",
          }),
        ],
      }),
      await Submenu.new({
        text: t("desktop.menu.view"),
        items: [
          await MenuItem.new({
            action: () => trigger("sidebar.toggle"),
            text: t("command.sidebar.toggle"),
            accelerator: "Cmd+B",
          }),
          await MenuItem.new({
            action: () => trigger("terminal.toggle"),
            text: t("command.terminal.toggle"),
            accelerator: "Ctrl+`",
          }),
          await MenuItem.new({
            action: () => trigger("fileTree.toggle"),
            text: t("command.fileTree.toggle"),
          }),
          await PredefinedMenuItem.new({
            item: "Separator",
          }),
          await MenuItem.new({
            action: () => trigger("common.goBack"),
            text: t("common.goBack"),
          }),
          await MenuItem.new({
            action: () => trigger("common.goForward"),
            text: t("common.goForward"),
          }),
          await PredefinedMenuItem.new({
            item: "Separator",
          }),
          await MenuItem.new({
            action: () => trigger("session.previous"),
            text: t("command.session.previous"),
            accelerator: "Option+ArrowUp",
          }),
          await MenuItem.new({
            action: () => trigger("session.next"),
            text: t("command.session.next"),
            accelerator: "Option+ArrowDown",
          }),
          await PredefinedMenuItem.new({
            item: "Separator",
          }),
        ],
      }),
      await Submenu.new({
        text: t("desktop.menu.tools"),
        items: [
          await MenuItem.new({
            action: () => trigger("routine.list"),
            text: t("command.routines.open"),
          }),
          await MenuItem.new({
            action: () => trigger("analytics.view"),
            text: t("command.analytics.open"),
          }),
          await MenuItem.new({
            action: () => trigger("connectors.list"),
            text: t("command.connectors.open"),
          }),
          await MenuItem.new({
            action: () => trigger("skill.list"),
            text: t("command.skills.open"),
          }),
          await PredefinedMenuItem.new({
            item: "Separator",
          }),
          await MenuItem.new({
            action: () => trigger("nikcli.status"),
            text: t("command.status.open"),
          }),
          await MenuItem.new({
            action: () => trigger("support.doctor"),
            text: t("command.doctor.open"),
          }),
        ],
      }),
      await Submenu.new({
        text: t("desktop.menu.help"),
        items: [
          await MenuItem.new({
            action: () => openUrl("https://nikcli.ai/docs"),
            text: t("desktop.menu.documentation"),
          }),
          await MenuItem.new({
            action: () => openUrl("https://discord.com/invite/nikcli"),
            text: t("desktop.menu.supportForum"),
          }),
          await PredefinedMenuItem.new({
            item: "Separator",
          }),
          await MenuItem.new({
            action: () => openUrl("https://github.com/nikcli/nikcli/issues/new?template=feature_request.yml"),
            text: t("desktop.menu.shareFeedback"),
          }),
          await MenuItem.new({
            action: () => openUrl("https://github.com/nikcli/nikcli/issues/new?template=bug_report.yml"),
            text: t("desktop.menu.reportBug"),
          }),
        ],
      }),
    ],
  })
  menu.setAsAppMenu()
}
