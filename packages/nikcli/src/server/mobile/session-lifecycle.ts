import { Effect } from "effect"
import type { JsonValue } from "@/util/json"
import { GlobalBus } from "@nikcli-ai/util/global-bus"
import { GithubApi } from "@/connectors/api/github"
import { withInstanceAsync } from "@/effect"
import { MobileGithubRepo } from "@/mobile/github-repo"
import { Session } from "@/session"
import { SessionStatus } from "@/session/status"
import { Worktree } from "@/worktree"
import { Workspace } from "@/workspace"
import {
  MobileGithubPublishInput,
  defaultPullRequestBody,
  extractSessionIDs,
  githubToken,
  runSession,
  runSessionForSession,
  runStatus,
  runWorktree,
} from "./helpers"
import { MobileHttpError } from "./request"
import { EventFeed } from "../httpapi/event-feed"

type SessionStreamEvent = {
  type?: string
  properties?: JsonValue
}

function sessionEventStream(request: Request, sessionID: string): Response {
  const stream = EventFeed.filtered({
    signal: request.signal,
    envelope: (event) => event,
    greeting: EventFeed.frame({ type: "server.connected", properties: { sessionID } }),
    heartbeat: { frame: EventFeed.frame({ type: "server.heartbeat", properties: { sessionID } }), intervalMs: 30_000 },
    subscribe(offer) {
      const onEvent = (event: { payload?: SessionStreamEvent }) => {
        const payload = event?.payload
        if (!payload?.type) return
        const ids = extractSessionIDs(payload.properties ?? null)
        if (!ids.includes(sessionID)) return
        offer(payload, payload.type)
      }
      GlobalBus.on("event", onEvent)
      return () => GlobalBus.off("event", onEvent)
    },
  })
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    },
  })
}

/** Raw SSE route — the one session route that cannot go through the encoder. */
export function handleSessionStreamRequest(request: Request): Response | undefined {
  const path = new URL(request.url).pathname
  const stream = path.match(/^\/mobile\/session\/([^/]+)\/stream$/)
  if (stream && request.method === "GET") return sessionEventStream(request, decodeURIComponent(stream[1]))
}

export async function sessionPublish(sessionID: string, input: typeof MobileGithubPublishInput._output | void) {
  const token = (await githubToken()) ?? undefined
  if (!token) throw new MobileHttpError("GitHub token not configured", 401)
  const bodyInput = input ?? {}

  const sessionInfo = await runSession(
    Effect.gen(function* () {
      const service = yield* Session.Service
      return yield* service.getAnyProject(sessionID)
    }),
  )
  if (!sessionInfo.github) throw new MobileHttpError("Session is not linked to GitHub", 400)
  if (sessionInfo.github.worktree.cleanedAt) throw new MobileHttpError("Session worktree has already been cleaned", 400)

  return withInstanceAsync({ directory: sessionInfo.directory }, async () => {
    const session = await runSession(
      Effect.gen(function* () {
        const service = yield* Session.Service
        return yield* service.get(sessionInfo.id)
      }),
    )
    const github = session.github
    if (!github) throw new MobileHttpError("Session is not linked to GitHub", 400)
    const status = await runStatus(
      Effect.gen(function* () {
        const sessionStatus = yield* SessionStatus.Service
        return yield* sessionStatus.get(session.id)
      }),
    )
    if (status.type !== "idle") {
      throw new MobileHttpError("Wait for the session to become idle before publishing", 400)
    }

    await MobileGithubRepo.runGit(["fetch", "origin", github.baseBranch, "--prune"], {
      cwd: session.directory,
      token,
    })

    const dirty = await MobileGithubRepo.runGit(["status", "--porcelain"], {
      cwd: session.directory,
      token,
    })

    if (dirty.trim()) {
      await MobileGithubRepo.runGit(["add", "-A"], { cwd: session.directory, token })
      await MobileGithubRepo.runGit(
        ["commit", "-m", bodyInput.commitMessage?.trim() || session.title.trim() || `Update ${github.fullName}`],
        {
          cwd: session.directory,
          token,
        },
      )
    }

    await MobileGithubRepo.runGit(["push", "--set-upstream", "origin", github.headBranch], {
      cwd: session.directory,
      token,
    })

    const ahead = await MobileGithubRepo.runGit(
      ["rev-list", "--left-right", "--count", `origin/${github.baseBranch}...HEAD`],
      {
        cwd: session.directory,
        token,
      },
    )
    const [, aheadCountText = "0"] = ahead.trim().split(/\s+/)
    const aheadCount = Number.parseInt(aheadCountText, 10) || 0

    const commitSha = await MobileGithubRepo.runGit(["rev-parse", "HEAD"], {
      cwd: session.directory,
      token,
    })

    const existingPullRequest =
      github.pullRequest ||
      (await GithubApi.findPullRequestByHead(token, github.owner, github.repo, `${github.owner}:${github.headBranch}`)
        .then((value) =>
          value
            ? {
                number: value.number,
                url: value.html_url,
                title: value.title,
              }
            : undefined,
        )
        .catch(() => undefined))

    const pullRequest =
      existingPullRequest ||
      (aheadCount > 0
        ? await GithubApi.createPullRequest(
            token,
            github.owner,
            github.repo,
            bodyInput.title?.trim() || session.title.trim() || `${github.fullName} changes`,
            github.headBranch,
            github.baseBranch,
            bodyInput.body?.trim() || defaultPullRequestBody(session),
          ).then((value) => ({
            number: value.number,
            url: value.html_url,
            title: value.title,
          }))
        : undefined)

    if (!pullRequest) {
      throw new MobileHttpError("Create changes in the worktree before publishing a pull request", 400)
    }

    await runSessionForSession(
      session,
      Effect.gen(function* () {
        const service = yield* Session.Service
        yield* service.update(session.id, (draft) => {
          if (!draft.github) return
          draft.github.pullRequest = pullRequest
          draft.github.lastCommitSha = commitSha.trim()
          draft.github.publishedAt = Date.now()
          delete draft.github.publishError
        })
      }),
    )

    return {
      commitSha: commitSha.trim(),
      branch: github.headBranch,
      pullRequest,
    }
  })
}

export async function sessionCleanup(sessionID: string) {
  const sessionInfo = await runSession(
    Effect.gen(function* () {
      const service = yield* Session.Service
      return yield* service.getAnyProject(sessionID)
    }),
  )
  const worktreeInfo = sessionInfo.github?.worktree ?? sessionInfo.worktree
  if (!worktreeInfo) throw new MobileHttpError("Session has no isolated worktree to clean up", 400)
  if (worktreeInfo.cleanedAt) return { success: true as const }

  const repositoryDirectory =
    sessionInfo.github?.repositoryDirectory || worktreeInfo.repositoryDirectory || worktreeInfo.directory
  const idle = await withInstanceAsync({ directory: sessionInfo.directory }, async () => {
    const status = await runStatus(
      Effect.gen(function* () {
        const sessionStatus = yield* SessionStatus.Service
        return yield* sessionStatus.get(sessionInfo.id)
      }),
    )
    return status.type === "idle"
  })
  if (!idle) {
    throw new MobileHttpError("Wait for the session to become idle before cleaning up the worktree", 400)
  }

  await withInstanceAsync({ directory: repositoryDirectory }, async () => {
    if (sessionInfo.workspaceID) {
      await Workspace.remove(sessionInfo.workspaceID).catch(() => undefined)
    }
    await runWorktree(
      Effect.gen(function* () {
        const service = yield* Worktree.Service
        yield* service.remove({ directory: worktreeInfo.directory })
      }),
    )
  })

  await withInstanceAsync({ directory: repositoryDirectory }, async () => {
    await runSessionForSession(
      sessionInfo,
      Effect.gen(function* () {
        const service = yield* Session.Service
        yield* service.update(sessionInfo.id, (draft) => {
          if (draft.github) {
            draft.github.worktree.cleanedAt = Date.now()
            return
          }
          if (draft.worktree) draft.worktree.cleanedAt = Date.now()
        })
      }),
    )
  })

  return { success: true as const }
}

export async function sessionRename(sessionID: string, input: { title: string }) {
  const session = await runSession(
    Effect.gen(function* () {
      const service = yield* Session.Service
      return yield* service.getAnyProject(sessionID)
    }),
  ).catch(() => undefined)
  if (!session) throw new MobileHttpError("not found", 404)
  await withInstanceAsync({ directory: session.directory }, async () => {
    await runSessionForSession(
      session,
      Effect.gen(function* () {
        const service = yield* Session.Service
        yield* service.update(sessionID, (draft) => {
          draft.title = input.title.trim()
        })
      }),
    )
  })
  return { success: true as const }
}
