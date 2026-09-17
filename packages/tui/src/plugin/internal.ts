import HomeTips from "../feature-plugins/home/tips"
import SidebarContext from "../feature-plugins/sidebar/context"
import SidebarMcp from "../feature-plugins/sidebar/mcp"
import SidebarLsp from "../feature-plugins/sidebar/lsp"
import SidebarTodo from "../feature-plugins/sidebar/todo"
import SidebarFiles from "../feature-plugins/sidebar/files"
import SidebarFooter from "../feature-plugins/sidebar/footer"
import PluginManager from "../feature-plugins/system/plugins"
import Fusion from "../feature-plugins/system/fusion"
import Loops from "../feature-plugins/loops"
import Missions from "../feature-plugins/mission"
import Brain from "../feature-plugins/brain"
import Browser from "../feature-plugins/browser"
import Chatbot from "../feature-plugins/chatbot"
import Discord from "../feature-plugins/discord"
import Computer from "../feature-plugins/computer"
import Connectors from "../feature-plugins/connectors"
import Observability from "../feature-plugins/observability"
import Math from "../feature-plugins/math"
import Island from "../feature-plugins/island"
import Background from "../feature-plugins/background"
import Herdr from "../feature-plugins/herdr"
import DevTools from "../feature-plugins/devtools"
import { Flag } from "@nikcli-ai/util/flag"
import { dbg } from "../feature-plugins/background/__debug"
dbg("internal.ts imported")

import type { TuiPlugin, TuiPluginModule } from "@nikcli-ai/plugin/tui"
import type { Definition } from "@nikcli-ai/plugin/v2/tui/plugin"

export type InternalTuiPlugin =
  | (TuiPluginModule & {
      id: string
      tui: TuiPlugin
    })
  | Definition

export const INTERNAL_TUI_PLUGINS: InternalTuiPlugin[] = [
  HomeTips,
  SidebarContext,
  SidebarMcp,
  SidebarLsp,
  SidebarTodo,
  SidebarFiles,
  SidebarFooter,
  PluginManager,
  Fusion,
  Missions,
  Loops,
  Brain,
  Browser,
  Chatbot,
  Discord,
  Computer,
  Connectors,
  Observability,
  Math,
  Background,
  DevTools,
  // Herdr TUI plugin is loaded by default. It auto-enables the bridge
  // when running inside a Herdr pane and stays dormant otherwise.
  Herdr,
  ...(Flag.NIKCLI_ISLAND ? [Island] : []),
]
