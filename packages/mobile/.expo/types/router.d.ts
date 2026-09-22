/* eslint-disable */
import * as Router from "expo-router"

export * from "expo-router"

declare module "expo-router" {
  export namespace ExpoRouter {
    export interface __routes<T extends string | object = string> {
      hrefInputParams:
        | { pathname: Router.RelativePathString; params?: Router.UnknownInputParams }
        | { pathname: Router.ExternalPathString; params?: Router.UnknownInputParams }
        | { pathname: `/connect`; params?: Router.UnknownInputParams }
        | { pathname: `/`; params?: Router.UnknownInputParams }
        | { pathname: `/login`; params?: Router.UnknownInputParams }
        | { pathname: `/_sitemap`; params?: Router.UnknownInputParams }
        | { pathname: `${"/(app)"}/more/brain` | `/more/brain`; params?: Router.UnknownInputParams }
        | { pathname: `${"/(app)"}/more/chatbots` | `/more/chatbots`; params?: Router.UnknownInputParams }
        | { pathname: `${"/(app)"}/more/host` | `/more/host`; params?: Router.UnknownInputParams }
        | { pathname: `${"/(app)"}/more` | `/more`; params?: Router.UnknownInputParams }
        | { pathname: `${"/(app)"}/more/observability` | `/more/observability`; params?: Router.UnknownInputParams }
        | { pathname: `${"/(app)"}/more/loops` | `/more/loops`; params?: Router.UnknownInputParams }
        | { pathname: `${"/(app)"}/more/missions` | `/more/missions`; params?: Router.UnknownInputParams }
        | { pathname: `${"/(app)"}/more/settings/agents` | `/more/settings/agents`; params?: Router.UnknownInputParams }
        | {
            pathname: `${"/(app)"}/more/settings/appearance` | `/more/settings/appearance`
            params?: Router.UnknownInputParams
          }
        | {
            pathname: `${"/(app)"}/more/settings/commands` | `/more/settings/commands`
            params?: Router.UnknownInputParams
          }
        | {
            pathname: `${"/(app)"}/more/settings/connectors` | `/more/settings/connectors`
            params?: Router.UnknownInputParams
          }
        | { pathname: `${"/(app)"}/more/settings/github` | `/more/settings/github`; params?: Router.UnknownInputParams }
        | { pathname: `${"/(app)"}/more/settings` | `/more/settings`; params?: Router.UnknownInputParams }
        | { pathname: `${"/(app)"}/more/settings/mcp` | `/more/settings/mcp`; params?: Router.UnknownInputParams }
        | {
            pathname: `${"/(app)"}/more/settings/memories` | `/more/settings/memories`
            params?: Router.UnknownInputParams
          }
        | {
            pathname: `${"/(app)"}/more/settings/permissions` | `/more/settings/permissions`
            params?: Router.UnknownInputParams
          }
        | {
            pathname: `${"/(app)"}/more/settings/providers` | `/more/settings/providers`
            params?: Router.UnknownInputParams
          }
        | {
            pathname: `${"/(app)"}/more/settings/security` | `/more/settings/security`
            params?: Router.UnknownInputParams
          }
        | { pathname: `${"/(app)"}/more/settings/skills` | `/more/settings/skills`; params?: Router.UnknownInputParams }
        | { pathname: `${"/(app)"}/more/settings/tokens` | `/more/settings/tokens`; params?: Router.UnknownInputParams }
        | {
            pathname: `${"/(app)"}/more/settings/plugins` | `/more/settings/plugins`
            params?: Router.UnknownInputParams
          }
        | { pathname: `${"/(app)"}/repos` | `/repos`; params?: Router.UnknownInputParams }
        | { pathname: `${"/(app)"}/routines` | `/routines`; params?: Router.UnknownInputParams }
        | { pathname: `${"/(app)"}/sessions/editor` | `/sessions/editor`; params?: Router.UnknownInputParams }
        | { pathname: `${"/(app)"}/sessions/explorer` | `/sessions/explorer`; params?: Router.UnknownInputParams }
        | { pathname: `${"/(app)"}/sessions` | `/sessions`; params?: Router.UnknownInputParams }
        | { pathname: `${"/(app)"}/terminal` | `/terminal`; params?: Router.UnknownInputParams }
        | { pathname: `/user`; params?: Router.UnknownInputParams }
        | { pathname: `/+not-found`; params: Router.UnknownInputParams & {} }
        | {
            pathname: `${"/(app)"}/more/loops/[loopId]` | `/more/loops/[loopId]`
            params: Router.UnknownInputParams & { loopId: string | number }
          }
        | {
            pathname: `${"/(app)"}/more/missions/[missionId]` | `/more/missions/[missionId]`
            params: Router.UnknownInputParams & { missionId: string | number }
          }
        | {
            pathname: `${"/(app)"}/routines/[routineId]` | `/routines/[routineId]`
            params: Router.UnknownInputParams & { routineId: string | number }
          }
        | {
            pathname: `${"/(app)"}/sessions/[sessionId]` | `/sessions/[sessionId]`
            params: Router.UnknownInputParams & { sessionId: string | number }
          }
      hrefOutputParams:
        | { pathname: Router.RelativePathString; params?: Router.UnknownOutputParams }
        | { pathname: Router.ExternalPathString; params?: Router.UnknownOutputParams }
        | { pathname: `/connect`; params?: Router.UnknownOutputParams }
        | { pathname: `/`; params?: Router.UnknownOutputParams }
        | { pathname: `/login`; params?: Router.UnknownOutputParams }
        | { pathname: `/_sitemap`; params?: Router.UnknownOutputParams }
        | { pathname: `${"/(app)"}/more/brain` | `/more/brain`; params?: Router.UnknownOutputParams }
        | { pathname: `${"/(app)"}/more/chatbots` | `/more/chatbots`; params?: Router.UnknownOutputParams }
        | { pathname: `${"/(app)"}/more/host` | `/more/host`; params?: Router.UnknownOutputParams }
        | { pathname: `${"/(app)"}/more` | `/more`; params?: Router.UnknownOutputParams }
        | { pathname: `${"/(app)"}/more/observability` | `/more/observability`; params?: Router.UnknownOutputParams }
        | { pathname: `${"/(app)"}/more/loops` | `/more/loops`; params?: Router.UnknownOutputParams }
        | { pathname: `${"/(app)"}/more/missions` | `/more/missions`; params?: Router.UnknownOutputParams }
        | {
            pathname: `${"/(app)"}/more/settings/agents` | `/more/settings/agents`
            params?: Router.UnknownOutputParams
          }
        | {
            pathname: `${"/(app)"}/more/settings/appearance` | `/more/settings/appearance`
            params?: Router.UnknownOutputParams
          }
        | {
            pathname: `${"/(app)"}/more/settings/commands` | `/more/settings/commands`
            params?: Router.UnknownOutputParams
          }
        | {
            pathname: `${"/(app)"}/more/settings/connectors` | `/more/settings/connectors`
            params?: Router.UnknownOutputParams
          }
        | {
            pathname: `${"/(app)"}/more/settings/github` | `/more/settings/github`
            params?: Router.UnknownOutputParams
          }
        | { pathname: `${"/(app)"}/more/settings` | `/more/settings`; params?: Router.UnknownOutputParams }
        | { pathname: `${"/(app)"}/more/settings/mcp` | `/more/settings/mcp`; params?: Router.UnknownOutputParams }
        | {
            pathname: `${"/(app)"}/more/settings/memories` | `/more/settings/memories`
            params?: Router.UnknownOutputParams
          }
        | {
            pathname: `${"/(app)"}/more/settings/permissions` | `/more/settings/permissions`
            params?: Router.UnknownOutputParams
          }
        | {
            pathname: `${"/(app)"}/more/settings/providers` | `/more/settings/providers`
            params?: Router.UnknownOutputParams
          }
        | {
            pathname: `${"/(app)"}/more/settings/security` | `/more/settings/security`
            params?: Router.UnknownOutputParams
          }
        | {
            pathname: `${"/(app)"}/more/settings/skills` | `/more/settings/skills`
            params?: Router.UnknownOutputParams
          }
        | {
            pathname: `${"/(app)"}/more/settings/tokens` | `/more/settings/tokens`
            params?: Router.UnknownOutputParams
          }
        | {
            pathname: `${"/(app)"}/more/settings/plugins` | `/more/settings/plugins`
            params?: Router.UnknownOutputParams
          }
        | { pathname: `${"/(app)"}/repos` | `/repos`; params?: Router.UnknownOutputParams }
        | { pathname: `${"/(app)"}/routines` | `/routines`; params?: Router.UnknownOutputParams }
        | { pathname: `${"/(app)"}/sessions/editor` | `/sessions/editor`; params?: Router.UnknownOutputParams }
        | { pathname: `${"/(app)"}/sessions/explorer` | `/sessions/explorer`; params?: Router.UnknownOutputParams }
        | { pathname: `${"/(app)"}/sessions` | `/sessions`; params?: Router.UnknownOutputParams }
        | { pathname: `${"/(app)"}/terminal` | `/terminal`; params?: Router.UnknownOutputParams }
        | { pathname: `/user`; params?: Router.UnknownOutputParams }
        | { pathname: `/+not-found`; params: Router.UnknownOutputParams & {} }
        | {
            pathname: `${"/(app)"}/more/loops/[loopId]` | `/more/loops/[loopId]`
            params: Router.UnknownOutputParams & { loopId: string }
          }
        | {
            pathname: `${"/(app)"}/more/missions/[missionId]` | `/more/missions/[missionId]`
            params: Router.UnknownOutputParams & { missionId: string }
          }
        | {
            pathname: `${"/(app)"}/routines/[routineId]` | `/routines/[routineId]`
            params: Router.UnknownOutputParams & { routineId: string }
          }
        | {
            pathname: `${"/(app)"}/sessions/[sessionId]` | `/sessions/[sessionId]`
            params: Router.UnknownOutputParams & { sessionId: string }
          }
      href:
        | Router.RelativePathString
        | Router.ExternalPathString
        | `/connect${`?${string}` | `#${string}` | ""}`
        | `/${`?${string}` | `#${string}` | ""}`
        | `/login${`?${string}` | `#${string}` | ""}`
        | `/_sitemap${`?${string}` | `#${string}` | ""}`
        | `${"/(app)"}/more/brain${`?${string}` | `#${string}` | ""}`
        | `/more/brain${`?${string}` | `#${string}` | ""}`
        | `${"/(app)"}/more/chatbots${`?${string}` | `#${string}` | ""}`
        | `/more/chatbots${`?${string}` | `#${string}` | ""}`
        | `${"/(app)"}/more/host${`?${string}` | `#${string}` | ""}`
        | `/more/host${`?${string}` | `#${string}` | ""}`
        | `${"/(app)"}/more${`?${string}` | `#${string}` | ""}`
        | `/more${`?${string}` | `#${string}` | ""}`
        | `${"/(app)"}/more/observability${`?${string}` | `#${string}` | ""}`
        | `/more/observability${`?${string}` | `#${string}` | ""}`
        | `${"/(app)"}/more/loops${`?${string}` | `#${string}` | ""}`
        | `/more/loops${`?${string}` | `#${string}` | ""}`
        | `${"/(app)"}/more/missions${`?${string}` | `#${string}` | ""}`
        | `/more/missions${`?${string}` | `#${string}` | ""}`
        | `${"/(app)"}/more/settings/agents${`?${string}` | `#${string}` | ""}`
        | `/more/settings/agents${`?${string}` | `#${string}` | ""}`
        | `${"/(app)"}/more/settings/appearance${`?${string}` | `#${string}` | ""}`
        | `/more/settings/appearance${`?${string}` | `#${string}` | ""}`
        | `${"/(app)"}/more/settings/commands${`?${string}` | `#${string}` | ""}`
        | `/more/settings/commands${`?${string}` | `#${string}` | ""}`
        | `${"/(app)"}/more/settings/connectors${`?${string}` | `#${string}` | ""}`
        | `/more/settings/connectors${`?${string}` | `#${string}` | ""}`
        | `${"/(app)"}/more/settings/github${`?${string}` | `#${string}` | ""}`
        | `/more/settings/github${`?${string}` | `#${string}` | ""}`
        | `${"/(app)"}/more/settings${`?${string}` | `#${string}` | ""}`
        | `/more/settings${`?${string}` | `#${string}` | ""}`
        | `${"/(app)"}/more/settings/mcp${`?${string}` | `#${string}` | ""}`
        | `/more/settings/mcp${`?${string}` | `#${string}` | ""}`
        | `${"/(app)"}/more/settings/memories${`?${string}` | `#${string}` | ""}`
        | `/more/settings/memories${`?${string}` | `#${string}` | ""}`
        | `${"/(app)"}/more/settings/permissions${`?${string}` | `#${string}` | ""}`
        | `/more/settings/permissions${`?${string}` | `#${string}` | ""}`
        | `${"/(app)"}/more/settings/providers${`?${string}` | `#${string}` | ""}`
        | `/more/settings/providers${`?${string}` | `#${string}` | ""}`
        | `${"/(app)"}/more/settings/security${`?${string}` | `#${string}` | ""}`
        | `/more/settings/security${`?${string}` | `#${string}` | ""}`
        | `${"/(app)"}/more/settings/skills${`?${string}` | `#${string}` | ""}`
        | `/more/settings/skills${`?${string}` | `#${string}` | ""}`
        | `${"/(app)"}/more/settings/tokens${`?${string}` | `#${string}` | ""}`
        | `/more/settings/tokens${`?${string}` | `#${string}` | ""}`
        | `${"/(app)"}/more/settings/plugins${`?${string}` | `#${string}` | ""}`
        | `/more/settings/plugins${`?${string}` | `#${string}` | ""}`
        | `${"/(app)"}/repos${`?${string}` | `#${string}` | ""}`
        | `/repos${`?${string}` | `#${string}` | ""}`
        | `${"/(app)"}/routines${`?${string}` | `#${string}` | ""}`
        | `/routines${`?${string}` | `#${string}` | ""}`
        | `${"/(app)"}/sessions/editor${`?${string}` | `#${string}` | ""}`
        | `/sessions/editor${`?${string}` | `#${string}` | ""}`
        | `${"/(app)"}/sessions/explorer${`?${string}` | `#${string}` | ""}`
        | `/sessions/explorer${`?${string}` | `#${string}` | ""}`
        | `${"/(app)"}/sessions${`?${string}` | `#${string}` | ""}`
        | `/sessions${`?${string}` | `#${string}` | ""}`
        | `${"/(app)"}/terminal${`?${string}` | `#${string}` | ""}`
        | `/terminal${`?${string}` | `#${string}` | ""}`
        | `/user${`?${string}` | `#${string}` | ""}`
        | { pathname: Router.RelativePathString; params?: Router.UnknownInputParams }
        | { pathname: Router.ExternalPathString; params?: Router.UnknownInputParams }
        | { pathname: `/connect`; params?: Router.UnknownInputParams }
        | { pathname: `/`; params?: Router.UnknownInputParams }
        | { pathname: `/login`; params?: Router.UnknownInputParams }
        | { pathname: `/_sitemap`; params?: Router.UnknownInputParams }
        | { pathname: `${"/(app)"}/more/brain` | `/more/brain`; params?: Router.UnknownInputParams }
        | { pathname: `${"/(app)"}/more/chatbots` | `/more/chatbots`; params?: Router.UnknownInputParams }
        | { pathname: `${"/(app)"}/more/host` | `/more/host`; params?: Router.UnknownInputParams }
        | { pathname: `${"/(app)"}/more` | `/more`; params?: Router.UnknownInputParams }
        | { pathname: `${"/(app)"}/more/observability` | `/more/observability`; params?: Router.UnknownInputParams }
        | { pathname: `${"/(app)"}/more/loops` | `/more/loops`; params?: Router.UnknownInputParams }
        | { pathname: `${"/(app)"}/more/missions` | `/more/missions`; params?: Router.UnknownInputParams }
        | { pathname: `${"/(app)"}/more/settings/agents` | `/more/settings/agents`; params?: Router.UnknownInputParams }
        | {
            pathname: `${"/(app)"}/more/settings/appearance` | `/more/settings/appearance`
            params?: Router.UnknownInputParams
          }
        | {
            pathname: `${"/(app)"}/more/settings/commands` | `/more/settings/commands`
            params?: Router.UnknownInputParams
          }
        | {
            pathname: `${"/(app)"}/more/settings/connectors` | `/more/settings/connectors`
            params?: Router.UnknownInputParams
          }
        | { pathname: `${"/(app)"}/more/settings/github` | `/more/settings/github`; params?: Router.UnknownInputParams }
        | { pathname: `${"/(app)"}/more/settings` | `/more/settings`; params?: Router.UnknownInputParams }
        | { pathname: `${"/(app)"}/more/settings/mcp` | `/more/settings/mcp`; params?: Router.UnknownInputParams }
        | {
            pathname: `${"/(app)"}/more/settings/memories` | `/more/settings/memories`
            params?: Router.UnknownInputParams
          }
        | {
            pathname: `${"/(app)"}/more/settings/permissions` | `/more/settings/permissions`
            params?: Router.UnknownInputParams
          }
        | {
            pathname: `${"/(app)"}/more/settings/providers` | `/more/settings/providers`
            params?: Router.UnknownInputParams
          }
        | {
            pathname: `${"/(app)"}/more/settings/security` | `/more/settings/security`
            params?: Router.UnknownInputParams
          }
        | { pathname: `${"/(app)"}/more/settings/skills` | `/more/settings/skills`; params?: Router.UnknownInputParams }
        | { pathname: `${"/(app)"}/more/settings/tokens` | `/more/settings/tokens`; params?: Router.UnknownInputParams }
        | {
            pathname: `${"/(app)"}/more/settings/plugins` | `/more/settings/plugins`
            params?: Router.UnknownInputParams
          }
        | { pathname: `${"/(app)"}/repos` | `/repos`; params?: Router.UnknownInputParams }
        | { pathname: `${"/(app)"}/routines` | `/routines`; params?: Router.UnknownInputParams }
        | { pathname: `${"/(app)"}/sessions/editor` | `/sessions/editor`; params?: Router.UnknownInputParams }
        | { pathname: `${"/(app)"}/sessions/explorer` | `/sessions/explorer`; params?: Router.UnknownInputParams }
        | { pathname: `${"/(app)"}/sessions` | `/sessions`; params?: Router.UnknownInputParams }
        | { pathname: `${"/(app)"}/terminal` | `/terminal`; params?: Router.UnknownInputParams }
        | { pathname: `/user`; params?: Router.UnknownInputParams }
        | `/+not-found${`?${string}` | `#${string}` | ""}`
        | `${"/(app)"}/more/loops/${Router.SingleRoutePart<T>}${`?${string}` | `#${string}` | ""}`
        | `/more/loops/${Router.SingleRoutePart<T>}${`?${string}` | `#${string}` | ""}`
        | `${"/(app)"}/more/missions/${Router.SingleRoutePart<T>}${`?${string}` | `#${string}` | ""}`
        | `/more/missions/${Router.SingleRoutePart<T>}${`?${string}` | `#${string}` | ""}`
        | `${"/(app)"}/routines/${Router.SingleRoutePart<T>}${`?${string}` | `#${string}` | ""}`
        | `/routines/${Router.SingleRoutePart<T>}${`?${string}` | `#${string}` | ""}`
        | `${"/(app)"}/sessions/${Router.SingleRoutePart<T>}${`?${string}` | `#${string}` | ""}`
        | `/sessions/${Router.SingleRoutePart<T>}${`?${string}` | `#${string}` | ""}`
        | { pathname: `/+not-found`; params: Router.UnknownInputParams & {} }
        | {
            pathname: `${"/(app)"}/more/loops/[loopId]` | `/more/loops/[loopId]`
            params: Router.UnknownInputParams & { loopId: string | number }
          }
        | {
            pathname: `${"/(app)"}/more/missions/[missionId]` | `/more/missions/[missionId]`
            params: Router.UnknownInputParams & { missionId: string | number }
          }
        | {
            pathname: `${"/(app)"}/routines/[routineId]` | `/routines/[routineId]`
            params: Router.UnknownInputParams & { routineId: string | number }
          }
        | {
            pathname: `${"/(app)"}/sessions/[sessionId]` | `/sessions/[sessionId]`
            params: Router.UnknownInputParams & { sessionId: string | number }
          }
    }
  }
}
