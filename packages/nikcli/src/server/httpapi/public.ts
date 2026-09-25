import { HttpApi, HttpApiBuilder } from "effect/unstable/httpapi"
import { Layer } from "effect"
import { PermissionNext } from "@/permission/next"
import { ProjectCopy } from "@/project/copy"
import { Question } from "@/question"
import { AnalyticsHttpApi } from "./analytics"
import { AppHttpApi } from "./app"
import { ContractExtraHttpApi } from "./contract-extra"
import { MobileHttpApi } from "./mobile"
import { MobileHandlersLive } from "./mobile-handlers"
import { BrainHttpApi } from "./brain"
import { ChatbotHttpApi } from "./chatbot-api"
import { DiscordHttpApi } from "./discord"
import { VoiceHttpApi } from "./voice"
import { ProfileHttpApi } from "./profile"
import { ConfigHttpApi } from "./config"
import { ConnectorsHttpApi } from "./connectors"
import { DoctorHttpApi } from "./doctor"
import { ExperimentalHttpApi } from "./experimental"
import { FileHttpApi } from "./file"
import { GlobalHttpApi } from "./global"
import { McpHttpApi } from "./mcp"
import { MissionHttpApi } from "./mission"
import { PermissionHttpApi } from "./permission"
import { ProjectHttpApi } from "./project"
import { ProviderHttpApi } from "./provider"
import { PtyHttpApi } from "./pty"
import { LoopHttpApi } from "./loop"
import { QuestionHttpApi } from "./question"
import { SessionHttpApi } from "./session"
import { SyncHttpApi } from "./sync"
import { TopLevelHttpApi } from "./top-level"
import { TuiHttpApi } from "./tui"
import { WorkspaceHttpApi } from "./workspace"
import { AccountHttp } from "./account"
import { HttpApiAuth } from "./security"
import { HttpServerResponse } from "effect/unstable/http"
import { Effect } from "effect"

export namespace PublicHttpApi {
  /**
   * The *served* Effect surface: every group here has handlers below and is
   * reachable through the HttpApi bridge. Contract-only groups (schemas for
   * routes served as raw Request/Response handlers) live on `PublicApi` instead.
   *
   * `.middleware(HttpApiAuth.Middleware)` declares security on a group, so an
   * endpoint added to it is authenticated by construction and OpenAPI says so
   * (H8). Two groups are left unwrapped because their operations are reachable
   * without credentials: `GlobalHttpApi.Group` mixes public and protected, so
   * it marks its one protected endpoint at the definition site, and every
   * `/account/*` operation is the browser sign-in flow — unauthenticated by
   * definition, since the caller is signing in.
   */
  export const Api = HttpApi.make("nikcli")
    .add(TopLevelHttpApi.Group.middleware(HttpApiAuth.Middleware))
    .add(AnalyticsHttpApi.Group.middleware(HttpApiAuth.Middleware))
    .add(AppHttpApi.Group.middleware(HttpApiAuth.Middleware))
    .add(BrainHttpApi.Group.middleware(HttpApiAuth.Middleware))
    .add(ChatbotHttpApi.Group.middleware(HttpApiAuth.Middleware))
    .add(DiscordHttpApi.Group.middleware(HttpApiAuth.Middleware))
    .add(VoiceHttpApi.Group.middleware(HttpApiAuth.Middleware))
    .add(ProfileHttpApi.Group.middleware(HttpApiAuth.Middleware))
    .add(ConfigHttpApi.Group.middleware(HttpApiAuth.Middleware))
    .add(ConnectorsHttpApi.Group.middleware(HttpApiAuth.Middleware))
    .add(DoctorHttpApi.Group.middleware(HttpApiAuth.Middleware))
    .add(ExperimentalHttpApi.Group.middleware(HttpApiAuth.Middleware))
    .add(FileHttpApi.Group.middleware(HttpApiAuth.Middleware))
    .add(GlobalHttpApi.Group)
    .add(McpHttpApi.Group.middleware(HttpApiAuth.Middleware))
    .add(MissionHttpApi.Group.middleware(HttpApiAuth.Middleware))
    .add(MobileHttpApi.Group.middleware(HttpApiAuth.Middleware))
    .add(ProjectHttpApi.Group.middleware(HttpApiAuth.Middleware))
    .add(ProviderHttpApi.Group.middleware(HttpApiAuth.Middleware))
    .add(QuestionHttpApi.Group.middleware(HttpApiAuth.Middleware))
    .add(PermissionHttpApi.Group.middleware(HttpApiAuth.Middleware))
    .add(PtyHttpApi.Group.middleware(HttpApiAuth.Middleware))
    .add(LoopHttpApi.Group.middleware(HttpApiAuth.Middleware))
    .add(SessionHttpApi.Group.middleware(HttpApiAuth.Middleware))
    .add(ContractExtraHttpApi.AccountGroup)
    .add(SyncHttpApi.Group.middleware(HttpApiAuth.Middleware))
    .add(TuiHttpApi.Group.middleware(HttpApiAuth.Middleware))
    .add(WorkspaceHttpApi.Group.middleware(HttpApiAuth.Middleware))

  export const ApiLive = HttpApiBuilder.layer(Api)

  const QuestionHandlersLive = HttpApiBuilder.group(Api, "question", (handlers) =>
    handlers
      .handle("list", () => QuestionHttpApi.handlers.list())
      .handle("reply", (request) => QuestionHttpApi.handlers.reply(request))
      .handle("reject", (request) => QuestionHttpApi.handlers.reject(request)),
  )

  const PermissionHandlersLive = HttpApiBuilder.group(Api, "permission", (handlers) =>
    handlers
      .handle("list", () => PermissionHttpApi.handlers.list())
      .handle("blocked", () => PermissionHttpApi.handlers.blocked())
      .handle("reply", (request) => PermissionHttpApi.handlers.reply(request)),
  )

  const TopLevelHandlersLive = HttpApiBuilder.group(Api, "top-level", (handlers) =>
    handlers
      // Takes the request: instance-less, so it reads the directory rather than the ambient scope (H11).
      .handle("dispose", (input) => TopLevelHttpApi.handlers.dispose(input))
      .handle("path", () => TopLevelHttpApi.handlers.path())
      .handle("vcs", () => TopLevelHttpApi.handlers.vcs())
      .handle("vcsStatus", () => TopLevelHttpApi.handlers.vcsStatus())
      .handle("vcsDiffRaw", () => TopLevelHttpApi.handlers.vcsDiffRaw())
      .handle("vcsApply", (request) => TopLevelHttpApi.handlers.vcsApply(request))
      .handle("command", () => TopLevelHttpApi.handlers.command())
      .handle("agent", () => TopLevelHttpApi.handlers.agent())
      .handle("skill", () => TopLevelHttpApi.handlers.skill())
      .handle("lsp", () => TopLevelHttpApi.handlers.lsp())
      .handle("formatter", () => TopLevelHttpApi.handlers.formatter()),
  )

  const ConfigHandlersLive = HttpApiBuilder.group(Api, "config", (handlers) =>
    handlers
      .handle("get", () => ConfigHttpApi.handlers.get())
      .handle("update", (request) => ConfigHttpApi.handlers.update(request))
      .handle("providers", () => ConfigHttpApi.handlers.providers()),
  )

  const FileHandlersLive = HttpApiBuilder.group(Api, "file", (handlers) =>
    handlers
      .handle("findText", (request) => FileHttpApi.handlers.findText(request))
      .handle("findFile", (request) => FileHttpApi.handlers.findFile(request))
      .handle("findSymbol", (request) => FileHttpApi.handlers.findSymbol(request))
      .handle("list", (request) => FileHttpApi.handlers.list(request))
      .handle("content", (request) => FileHttpApi.handlers.content(request))
      .handle("write", (request) => FileHttpApi.handlers.write(request))
      .handle("status", () => FileHttpApi.handlers.status()),
  )

  const ExperimentalHandlersLive = HttpApiBuilder.group(Api, "experimental", (handlers) =>
    handlers
      .handle("toolIDs", () => ExperimentalHttpApi.handlers.toolIDs())
      .handle("tools", (request) => ExperimentalHttpApi.handlers.tools(request))
      .handle("worktreeCreate", (request) => ExperimentalHttpApi.handlers.worktreeCreate(request))
      .handle("worktree", () => ExperimentalHttpApi.handlers.worktree())
      .handle("worktreeRemove", (request) => ExperimentalHttpApi.handlers.worktreeRemove(request))
      .handle("worktreeReset", (request) => ExperimentalHttpApi.handlers.worktreeReset(request))
      .handle("resource", () => ExperimentalHttpApi.handlers.resource())
      .handle("managedWorktreeCreate", (request) => ExperimentalHttpApi.handlers.managedWorktreeCreate(request))
      .handle("managedWorktreeRemove", (request) => ExperimentalHttpApi.handlers.managedWorktreeRemove(request))
      .handle("managedWorktreeLink", (request) => ExperimentalHttpApi.handlers.managedWorktreeLink(request))
      .handle("managedWorktreeChildren", (request) => ExperimentalHttpApi.handlers.managedWorktreeChildren(request))
      .handle("managedWorktreeAncestors", (request) => ExperimentalHttpApi.handlers.managedWorktreeAncestors(request))
      .handle("managedWorktreeList", () => ExperimentalHttpApi.handlers.managedWorktreeList()),
  )

  const McpHandlersLive = HttpApiBuilder.group(Api, "mcp", (handlers) =>
    handlers
      .handle("status", () => McpHttpApi.handlers.status())
      .handle("add", (request) => McpHttpApi.handlers.add(request))
      .handle("startAuth", (request) => McpHttpApi.handlers.startAuth(request))
      .handle("authCallback", (request) => McpHttpApi.handlers.authCallback(request))
      .handle("authenticate", (request) => McpHttpApi.handlers.authenticate(request))
      .handle("removeAuth", (request) => McpHttpApi.handlers.removeAuth(request))
      .handle("connect", (request) => McpHttpApi.handlers.connect(request))
      .handle("disconnect", (request) => McpHttpApi.handlers.disconnect(request))
      .handle("toggle", (request) => McpHttpApi.handlers.toggle(request)),
  )

  const ProjectHandlersLive = HttpApiBuilder.group(Api, "project", (handlers) =>
    handlers
      .handle("list", () => ProjectHttpApi.handlers.list())
      .handle("current", () => ProjectHttpApi.handlers.current())
      .handle("update", (request) => ProjectHttpApi.handlers.update(request))
      .handle("directoryList", (request) => ProjectHttpApi.handlers.directoryList(request))
      .handle("copyCreate", (request) => ProjectHttpApi.handlers.copyCreate(request))
      .handle("copyRemove", (request) => ProjectHttpApi.handlers.copyRemove(request))
      .handle("copyRefresh", (request) => ProjectHttpApi.handlers.copyRefresh(request)),
  )

  const TuiHandlersLive = HttpApiBuilder.group(Api, "tui", (handlers) =>
    handlers
      .handle("appendPrompt", (request) => TuiHttpApi.handlers.appendPrompt(request))
      .handle("openHelp", () => TuiHttpApi.handlers.openHelp())
      .handle("openSessions", () => TuiHttpApi.handlers.openSessions())
      .handle("openThemes", () => TuiHttpApi.handlers.openThemes())
      .handle("openModels", () => TuiHttpApi.handlers.openModels())
      .handle("submitPrompt", () => TuiHttpApi.handlers.submitPrompt())
      .handle("clearPrompt", () => TuiHttpApi.handlers.clearPrompt())
      .handle("executeCommand", (request) => TuiHttpApi.handlers.executeCommand(request))
      .handle("showToast", (request) => TuiHttpApi.handlers.showToast(request))
      .handle("publish", (request) => TuiHttpApi.handlers.publish(request))
      .handle("selectSession", (request) => TuiHttpApi.handlers.selectSession(request))
      .handle("config", () => TuiHttpApi.handlers.config())
      .handle("controlNext", () => TuiHttpApi.handlers.controlNext())
      .handle("controlResponse", (request) => TuiHttpApi.handlers.controlResponse(request)),
  )

  const WorkspaceHandlersLive = HttpApiBuilder.group(Api, "workspace", (handlers) =>
    handlers
      .handle("adaptors", () => WorkspaceHttpApi.handlers.adaptors())
      .handle("syncList", () => WorkspaceHttpApi.handlers.syncList())
      .handle("status", () => WorkspaceHttpApi.handlers.status())
      .handle("create", (request) => WorkspaceHttpApi.handlers.create(request))
      .handle("list", () => WorkspaceHttpApi.handlers.list())
      .handle("remove", (request) => WorkspaceHttpApi.handlers.remove(request))
      .handle("restore", (request) => WorkspaceHttpApi.handlers.restore(request))
      .handle("sessionRestore", (request) => WorkspaceHttpApi.handlers.sessionRestore(request))
      .handle("warp", (request) => WorkspaceHttpApi.handlers.warp(request)),
  )

  const ProviderHandlersLive = HttpApiBuilder.group(Api, "provider", (handlers) =>
    handlers
      .handle("list", () => ProviderHttpApi.handlers.list())
      .handle("auth", () => ProviderHttpApi.handlers.auth())
      .handle("api", (request) => ProviderHttpApi.handlers.api(request))
      .handle("removeAuth", (request) => ProviderHttpApi.handlers.removeAuth(request))
      .handle("oauthAuthorize", (request) => ProviderHttpApi.handlers.oauthAuthorize(request))
      .handle("oauthCallback", (request) => ProviderHttpApi.handlers.oauthCallback(request)),
  )

  const PtyHandlersLive = HttpApiBuilder.group(Api, "pty", (handlers) =>
    handlers
      .handle("list", () => PtyHttpApi.handlers.list())
      .handle("create", (request) => PtyHttpApi.handlers.create(request))
      .handle("get", (request) => PtyHttpApi.handlers.get(request))
      .handle("update", (request) => PtyHttpApi.handlers.update(request))
      .handle("remove", (request) => PtyHttpApi.handlers.remove(request)),
  )

  const LoopHandlersLive = HttpApiBuilder.group(Api, "loop", (handlers) =>
    handlers
      .handle("list", () => LoopHttpApi.handlers.list())
      .handle("templates", () => LoopHttpApi.handlers.templates())
      .handle("generate", (request) => LoopHttpApi.handlers.generate(request))
      .handle("recentRuns", (request) => LoopHttpApi.handlers.recentRuns(request))
      .handle("get", (request) => LoopHttpApi.handlers.get(request))
      .handle("upsert", (request) => LoopHttpApi.handlers.upsert(request))
      .handle("update", (request) => LoopHttpApi.handlers.update(request))
      .handle("remove", (request) => LoopHttpApi.handlers.remove(request))
      .handle("toggle", (request) => LoopHttpApi.handlers.toggle(request))
      .handle("run", (request) => LoopHttpApi.handlers.run(request))
      .handle("abort", (request) => LoopHttpApi.handlers.abort(request))
      .handle("pause", (request) => LoopHttpApi.handlers.pause(request))
      .handle("resume", (request) => LoopHttpApi.handlers.resume(request))
      .handle("runs", (request) => LoopHttpApi.handlers.runs(request)),
  )

  const DoctorHandlersLive = HttpApiBuilder.group(Api, "doctor", (handlers) =>
    handlers.handle("run", () => DoctorHttpApi.handlers.run()),
  )

  const AppHandlersLive = HttpApiBuilder.group(Api, "app", (handlers) =>
    handlers
      .handle("log", (request) => AppHttpApi.handlers.log(request))
      .handle("skillCreate", (request) => AppHttpApi.handlers.skillCreate(request))
      .handle("skillDelete", (request) => AppHttpApi.handlers.skillDelete(request)),
  )

  const GlobalHandlersLive = HttpApiBuilder.group(Api, "global", (handlers) =>
    handlers
      .handle("health", () => GlobalHttpApi.handlers.health())
      .handle("dispose", () => GlobalHttpApi.handlers.dispose()),
  )

  const BrainHandlersLive = HttpApiBuilder.group(Api, "brain", (handlers) =>
    handlers
      .handle("status", () => BrainHttpApi.handlers.status())
      .handle("trigger", (request) => BrainHttpApi.handlers.trigger(request)),
  )

  const ChatbotHandlersLive = HttpApiBuilder.group(Api, "chatbot", (handlers) =>
    handlers
      .handle("bots", () => ChatbotHttpApi.handlers.bots())
      .handle("start", (request) => ChatbotHttpApi.handlers.start(request))
      .handle("stop", (request) => ChatbotHttpApi.handlers.stop(request)),
  )

  const DiscordHandlersLive = HttpApiBuilder.group(Api, "discord", (handlers) =>
    handlers
      .handle("status", () => DiscordHttpApi.handlers.status())
      .handle("setup", (request) => DiscordHttpApi.handlers.setup(request))
      .handle("start", () => DiscordHttpApi.handlers.start())
      .handle("stop", () => DiscordHttpApi.handlers.stop()),
  )

  const VoiceHandlersLive = HttpApiBuilder.group(Api, "voice", (handlers) =>
    handlers.handle("transcribe", (request) => VoiceHttpApi.handlers.transcribe(request)),
  )

  const ProfileHandlersLive = HttpApiBuilder.group(Api, "profile", (handlers) =>
    handlers
      .handle("get", () => ProfileHttpApi.handlers.get())
      .handle("patch", (request) => ProfileHttpApi.handlers.patch(request))
      .handle("clear", () => ProfileHttpApi.handlers.clear())
      .handle("habits", (request) => ProfileHttpApi.handlers.habits(request))
      .handle("preview", (request) => ProfileHttpApi.handlers.preview(request))
      .handle("clearHabits", (request) => ProfileHttpApi.handlers.clearHabits(request)),
  )

  const ConnectorsHandlersLive = HttpApiBuilder.group(Api, "connectors", (handlers) =>
    handlers
      .handle("status", () => ConnectorsHttpApi.handlers.status())
      .handle("authSet", (request) => ConnectorsHttpApi.handlers.authSet(request))
      .handle("authRemove", (request) => ConnectorsHttpApi.handlers.authRemove(request))
      .handle("invalidate", (request) => ConnectorsHttpApi.handlers.invalidate(request)),
  )

  const AnalyticsHandlersLive = HttpApiBuilder.group(Api, "analytics", (handlers) =>
    handlers
      .handle("global", () => AnalyticsHttpApi.handlers.global())
      .handle("daily", (request) => AnalyticsHttpApi.handlers.daily(request))
      .handle("session", (request) => AnalyticsHttpApi.handlers.session(request))
      .handle("sessions", () => AnalyticsHttpApi.handlers.sessions())
      .handle("leaderboard", () => AnalyticsHttpApi.handlers.leaderboard())
      .handle("data", (request) => AnalyticsHttpApi.handlers.data(request)),
  )

  const MissionHandlersLive = HttpApiBuilder.group(Api, "mission", (handlers) =>
    handlers
      .handle("list", () => MissionHttpApi.handlers.list())
      .handle("templates", () => MissionHttpApi.handlers.templates())
      .handle("generate", (request) => MissionHttpApi.handlers.generate(request))
      .handle("recentExecs", (request) => MissionHttpApi.handlers.recentExecs(request))
      .handle("get", (request) => MissionHttpApi.handlers.get(request))
      .handle("upsert", (request) => MissionHttpApi.handlers.upsert(request))
      .handle("update", (request) => MissionHttpApi.handlers.update(request))
      .handle("remove", (request) => MissionHttpApi.handlers.remove(request))
      .handle("start", (request) => MissionHttpApi.handlers.start(request))
      .handle("pause", (request) => MissionHttpApi.handlers.pause(request))
      .handle("cancel", (request) => MissionHttpApi.handlers.cancel(request))
      .handle("featureMutate", (request) => MissionHttpApi.handlers.featureMutate(request))
      .handle("execs", (request) => MissionHttpApi.handlers.execs(request)),
  )

  const SessionHandlersLive = HttpApiBuilder.group(Api, "session", (handlers) =>
    handlers
      .handle("list", (request) => SessionHttpApi.handlers.list(request))
      .handle("create", (request) => SessionHttpApi.handlers.create(request))
      .handle("status", () => SessionHttpApi.handlers.status())
      .handle("get", (request) => SessionHttpApi.handlers.get(request))
      .handle("remove", (request) => SessionHttpApi.handlers.remove(request))
      .handle("update", (request) => SessionHttpApi.handlers.update(request))
      .handle("fork", (request) => SessionHttpApi.handlers.fork(request))
      .handle("abort", (request) => SessionHttpApi.handlers.abort(request))
      .handle("revert", (request) => SessionHttpApi.handlers.revert(request))
      .handle("unrevert", (request) => SessionHttpApi.handlers.unrevert(request))
      .handle("share", (request) => SessionHttpApi.handlers.share(request))
      .handle("unshare", (request) => SessionHttpApi.handlers.unshare(request))
      .handle("summarize", (request) => SessionHttpApi.handlers.summarize(request))
      .handle("command", (request) => SessionHttpApi.handlers.command(request))
      .handle("shell", (request) => SessionHttpApi.handlers.shell(request))
      .handle("permissionRespond", (request) => SessionHttpApi.handlers.permissionRespond(request))
      .handle("children", (request) => SessionHttpApi.handlers.children(request))
      .handle("todo", (request) => SessionHttpApi.handlers.todo(request))
      .handle("diff", (request) => SessionHttpApi.handlers.diff(request))
      .handle("messages", (request) => SessionHttpApi.handlers.messages(request))
      .handle("pending", (request) => SessionHttpApi.handlers.pending(request))
      .handle("pendingSteer", (request) => SessionHttpApi.handlers.pendingSteer(request))
      .handle("message", (request) => SessionHttpApi.handlers.message(request))
      .handle("messageRemove", (request) => SessionHttpApi.handlers.messageRemove(request))
      .handle("partRemove", (request) => SessionHttpApi.handlers.partRemove(request))
      .handle("partUpdate", (request) => SessionHttpApi.handlers.partUpdate(request))
      .handle("v2Entries", (request) => SessionHttpApi.handlers.v2Entries(request))
      .handle("v2State", (request) => SessionHttpApi.handlers.v2State(request))
      .handle("v2Events", (request) => SessionHttpApi.handlers.v2Events(request))
      .handle("instructions", (request) => SessionHttpApi.handlers.instructions(request))
      .handle("contextBreakdown", (request) => SessionHttpApi.handlers.contextBreakdown(request))
      .handle("contextToggle", (request) => SessionHttpApi.handlers.contextToggle(request))
      .handle("goal", (request) => SessionHttpApi.handlers.goal(request))
      .handle("background", (request) => SessionHttpApi.handlers.background(request))
      .handle("backgroundInspect", (request) => SessionHttpApi.handlers.backgroundInspect(request))
      .handle("backgroundRead", (request) => SessionHttpApi.handlers.backgroundRead(request))
      .handle("backgroundCancel", (request) => SessionHttpApi.handlers.backgroundCancel(request))
      .handle("backgroundResume", (request) => SessionHttpApi.handlers.backgroundResume(request))
      .handle("monitor", (request) => SessionHttpApi.handlers.monitor(request))
      .handle("monitorLog", (request) => SessionHttpApi.handlers.monitorLog(request))
      .handle("monitorCancel", (request) => SessionHttpApi.handlers.monitorCancel(request)),
  )

  // /account/* — raw `Response` handlers because the eight `{ error }` bodies
  // cannot round-trip the HttpApi error encoder. The `AccountHttp.handle`
  // dispatcher still answers; this just registers the dispatch path on the
  // encoded router so the contract describes it and a 404 falls through to
  // the website proxy instead of an opaque Response.
  const AccountHandlersLive = HttpApiBuilder.group(Api, "account", (handlers) =>
    handlers
      .handleRaw("active", ({ request }) =>
        Effect.promise(async () =>
          HttpServerResponse.fromWeb(
            (await AccountHttp.handle(request.source as Request)) ?? new Response("Not Found", { status: 404 }),
          ),
        ),
      )
      .handleRaw("login", ({ request }) =>
        Effect.promise(async () =>
          HttpServerResponse.fromWeb(
            (await AccountHttp.handle(request.source as Request)) ?? new Response("Not Found", { status: 404 }),
          ),
        ),
      )
      .handleRaw("complete", ({ request }) =>
        Effect.promise(async () =>
          HttpServerResponse.fromWeb(
            (await AccountHttp.handle(request.source as Request)) ?? new Response("Not Found", { status: 404 }),
          ),
        ),
      ),
  )

  export const layer = ApiLive.pipe(
    Layer.provide(
      Layer.mergeAll(
        TopLevelHandlersLive.pipe(Layer.provide(TopLevelHttpApi.DependenciesLive)),
        AnalyticsHandlersLive,
        AppHandlersLive.pipe(Layer.provide(AppHttpApi.DependenciesLive)),
        BrainHandlersLive,
        ChatbotHandlersLive,
        DiscordHandlersLive.pipe(Layer.provide(DiscordHttpApi.DependenciesLive)),
        VoiceHandlersLive,
        ProfileHandlersLive,
        ConfigHandlersLive.pipe(Layer.provide(ConfigHttpApi.DependenciesLive)),
        ConnectorsHandlersLive.pipe(Layer.provide(ConnectorsHttpApi.DependenciesLive)),
        DoctorHandlersLive.pipe(Layer.provide(DoctorHttpApi.DependenciesLive)),
        ExperimentalHandlersLive.pipe(Layer.provide(ExperimentalHttpApi.DependenciesLive)),
        FileHandlersLive.pipe(Layer.provide(FileHttpApi.DependenciesLive)),
        GlobalHandlersLive,
        McpHandlersLive.pipe(Layer.provide(McpHttpApi.DependenciesLive)),
        ProjectHandlersLive.pipe(Layer.provide(ProjectCopy.defaultLayer)),
        ProviderHandlersLive.pipe(Layer.provide(ProviderHttpApi.DependenciesLive)),
        PtyHandlersLive.pipe(Layer.provide(PtyHttpApi.DependenciesLive)),
        QuestionHandlersLive.pipe(Layer.provide(Question.defaultLayer)),
        PermissionHandlersLive.pipe(Layer.provide(PermissionNext.defaultLayer)),
        LoopHandlersLive,
        MissionHandlersLive,
        MobileHandlersLive,
        SessionHandlersLive.pipe(Layer.provide(SessionHttpApi.DependenciesLive)),
        SyncHttpApi.HandlersLive,
        TuiHandlersLive.pipe(Layer.provide(TuiHttpApi.DependenciesLive)),
        WorkspaceHandlersLive,
        AccountHandlersLive,
      ).pipe(
        // The security middleware has to be in scope **while each group layer
        // is built**, not merely provided to `ApiLive`: `HttpApiBuilder.group`
        // captures `Effect.context()` at construction and `applyMiddleware`
        // resolves the middleware service out of that captured context when it
        // turns a handler into a route. Providing it only to `ApiLive` builds
        // fine and then fails every protected request at runtime with
        // "Service not found: nikcli/HttpApiAuth" (H8).
        Layer.provide(HttpApiAuth.layer),
      ),
    ),
  )
}

/**
 * Authoritative public contract used for OpenAPI/SDK generation and by the
 * generated Effect clients. Superset of the served `PublicHttpApi.Api`:
 * contract-only groups describe routes served as raw Request/Response handlers,
 * so they have schemas here but no Effect HttpApi handlers.
 */
export const PublicApi = PublicHttpApi.Api.add(ContractExtraHttpApi.AuthGroup.middleware(HttpApiAuth.Middleware))
  .add(ContractExtraHttpApi.ConfigManagementGroup.middleware(HttpApiAuth.Middleware))
  .add(ContractExtraHttpApi.SessionPromptGroup.middleware(HttpApiAuth.Middleware))
  // `/s/:id`, `/share/:id` and `/api/share/:id` are answered by
  // `PublicRoutes.publicRequest`, which runs *ahead* of authentication — a
  // shared conversation opens without credentials, so the contract must not
  // claim otherwise.
  .add(ContractExtraHttpApi.ShareGroup)
  .add(ContractExtraHttpApi.EventsGroup.middleware(HttpApiAuth.Middleware))
  .add(ContractExtraHttpApi.WorkspaceExtraGroup.middleware(HttpApiAuth.Middleware))
  .add(ContractExtraHttpApi.UsersGroup)
  .add(ContractExtraHttpApi.PtyConnectGroup.middleware(HttpApiAuth.Middleware))
  .add(ContractExtraHttpApi.AccountGroup)
