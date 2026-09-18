import open from "open"
import type { DialogContext } from "@tui/ui/dialog"
import { DialogConfirm } from "@tui/ui/dialog-confirm"
import { DialogPrompt } from "@tui/ui/dialog-prompt"
import { DialogSelect, type DialogSelectOption } from "@tui/ui/dialog-select"
import type { useToast } from "@tui/ui/toast"
import { Clipboard } from "@tui/util/clipboard"
import type { Theme } from "@tui/context/theme"
import { buildRepoActions, type RepoAction, type RepoActionID } from "./repo-actions"
import {
  dirtyCount,
  formatAheadBehind,
  remoteWebUrl,
  run,
  runErrorMessage,
  runText,
  type RepoStatus,
} from "./repo-status"

export type RepoActionContext = {
  dialog: DialogContext
  toast: ReturnType<typeof useToast>
  theme: Theme
  directory: () => string
  status: () => RepoStatus | undefined
  refresh: () => void
}

function ghAvailable() {
  return Bun.which("gh") !== null
}

/** Status line under the menu title: branch, drift and working-tree state. */
function subtitle(status: RepoStatus | undefined) {
  if (!status) return "loading…"
  if (status.error) return status.error
  const parts = [status.branch]
  const drift = formatAheadBehind(status.ahead, status.behind)
  if (drift) parts.push(drift)
  if (!status.upstream && !status.detached) parts.push("no upstream")
  const dirty = dirtyCount(status.dirty)
  parts.push(dirty === 0 ? "clean" : `${dirty} change${dirty === 1 ? "" : "s"}`)
  if (status.stashes > 0) parts.push(`${status.stashes} stashed`)
  return parts.join(" · ")
}

export function openRepoActions(ctx: RepoActionContext) {
  const actions = buildRepoActions(ctx.status(), { gh: ghAvailable() })
  const options: DialogSelectOption<RepoAction>[] = actions.map((action) => ({
    title: action.title,
    value: action,
    category: action.category,
    description: action.disabled ?? action.description,
    disabled: !!action.disabled,
    searchText: `${action.category} ${action.title} ${action.description ?? ""}`,
  }))

  ctx.dialog.setSize("large")
  ctx.dialog.replace(
    () => (
      <DialogSelect
        title={`Repository · ${subtitle(ctx.status())}`}
        placeholder="search actions"
        options={options}
        onSelect={(option) => {
          if (option.value.disabled) return
          ctx.dialog.clear()
          void runRepoAction(option.value, ctx)
        }}
      />
    ),
    () => {},
  )
}

/** Run `git`/`gh` and report the outcome, then refresh the status strip. */
async function exec(ctx: RepoActionContext, label: string, binary: string, args: string[], quiet = false) {
  const result = await run(binary, args, ctx.directory())
  if (result.exitCode !== 0) {
    ctx.toast.show({ variant: "error", message: `${label}: ${runErrorMessage(result)}` })
    ctx.refresh()
    return false
  }
  if (!quiet) ctx.toast.show({ variant: "success", message: label })
  ctx.refresh()
  return true
}

function confirm(ctx: RepoActionContext, title: string, message: string, onConfirm: () => void) {
  ctx.dialog.setSize("medium")
  ctx.dialog.replace(
    () => (
      <DialogConfirm
        title={title}
        message={message}
        onConfirm={() => {
          ctx.dialog.clear()
          onConfirm()
        }}
        onCancel={() => ctx.dialog.clear()}
      />
    ),
    () => {},
  )
}

function prompt(
  ctx: RepoActionContext,
  input: { title: string; placeholder?: string; value?: string; hint?: string },
  onConfirm: (value: string) => void,
) {
  ctx.dialog.setSize("medium")
  ctx.dialog.replace(
    () => (
      <DialogPrompt
        title={input.title}
        placeholder={input.placeholder}
        value={input.value}
        description={input.hint ? () => <text fg={ctx.theme.foreground.muted}>{input.hint}</text> : undefined}
        onConfirm={(value) => {
          ctx.dialog.clear()
          const trimmed = value.trim()
          if (!trimmed) return
          onConfirm(trimmed)
        }}
        onCancel={() => ctx.dialog.clear()}
      />
    ),
    () => {},
  )
}

type LocalBranch = { name: string; current: boolean; upstream?: string; subject?: string }

const FIELD = "\x1f"

async function localBranches(directory: string): Promise<LocalBranch[]> {
  const out = await runText(
    "git",
    ["branch", "--format", ["%(HEAD)", "%(refname:short)", "%(upstream:short)", "%(contents:subject)"].join(FIELD)],
    directory,
  )
  if (!out) return []
  return out
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      const [head = "", name = "", upstream = "", subject = ""] = line.split(FIELD)
      return { name, current: head.trim() === "*", upstream: upstream || undefined, subject: subject || undefined }
    })
    .filter((branch) => branch.name.length > 0)
}

async function pickBranch(
  ctx: RepoActionContext,
  input: { title: string; placeholder: string; excludeCurrent?: boolean },
  onPick: (branch: LocalBranch) => void,
) {
  const branches = await localBranches(ctx.directory())
  const list = input.excludeCurrent ? branches.filter((b) => !b.current) : branches
  if (list.length === 0) {
    ctx.toast.show({ variant: "info", message: "No branches available" })
    return
  }
  const options: DialogSelectOption<LocalBranch>[] = list.map((branch) => ({
    title: branch.current ? `${branch.name} (current)` : branch.name,
    value: branch,
    description: branch.upstream ?? branch.subject,
    bg: branch.current ? ctx.theme.surface.offset : undefined,
  }))
  ctx.dialog.setSize("large")
  ctx.dialog.replace(
    () => (
      <DialogSelect
        title={input.title}
        placeholder={input.placeholder}
        options={options}
        onSelect={(option) => {
          ctx.dialog.clear()
          onPick(option.value)
        }}
      />
    ),
    () => {},
  )
}

export async function runRepoAction(action: RepoAction, ctx: RepoActionContext) {
  const status = ctx.status()
  const branch = status?.branch ?? "HEAD"
  const id: RepoActionID = action.id

  switch (id) {
    case "fetch":
      await exec(ctx, "Fetched", "git", ["fetch", "--all", "--prune"])
      return
    case "pull":
      await exec(ctx, "Pulled", "git", ["pull", "--ff-only"])
      return
    case "pull-rebase":
      await exec(ctx, "Pulled (rebase)", "git", ["pull", "--rebase"])
      return
    case "push":
      await exec(ctx, "Pushed", "git", ["push"])
      return
    case "publish":
      await exec(ctx, `Published ${branch}`, "git", ["push", "-u", "origin", branch])
      return
    case "push-force":
      confirm(
        ctx,
        "Force push",
        `Overwrite origin/${branch} with your local branch? Commits only on the remote are lost.`,
        () => void exec(ctx, "Force pushed", "git", ["push", "--force-with-lease"]),
      )
      return
    case "branch-create":
      prompt(
        ctx,
        { title: "Create branch", placeholder: "feature/my-branch", hint: `Branch from ${branch}` },
        (name) => void exec(ctx, `Created ${name}`, "git", ["checkout", "-b", name]),
      )
      return
    case "branch-switch":
      await pickBranch(ctx, { title: "Switch branch", placeholder: "search branches" }, (picked) => {
        if (picked.current) return
        void exec(ctx, `Switched to ${picked.name}`, "git", ["checkout", picked.name])
      })
      return
    case "branch-rename":
      prompt(
        ctx,
        { title: "Rename branch", placeholder: branch, value: branch, hint: `Renames ${branch}` },
        (name) => void exec(ctx, `Renamed to ${name}`, "git", ["branch", "-m", name]),
      )
      return
    case "branch-delete":
      await pickBranch(
        ctx,
        { title: "Delete branch", placeholder: "search branches", excludeCurrent: true },
        (picked) => {
          confirm(ctx, "Delete branch", `Delete local branch "${picked.name}"?`, async () => {
            const result = await run("git", ["branch", "-d", picked.name], ctx.directory())
            if (result.exitCode === 0) {
              ctx.toast.show({ variant: "success", message: `Deleted ${picked.name}` })
              ctx.refresh()
              return
            }
            // git refuses an unmerged branch by design; offer the force path
            // rather than making the user retype the command elsewhere.
            if (/not fully merged/i.test(result.stderr)) {
              confirm(
                ctx,
                "Delete unmerged branch",
                `"${picked.name}" is not fully merged. Delete it anyway and lose its commits?`,
                () => void exec(ctx, `Deleted ${picked.name}`, "git", ["branch", "-D", picked.name]),
              )
              return
            }
            ctx.toast.show({ variant: "error", message: runErrorMessage(result) })
          })
        },
      )
      return
    case "stage-all":
      await exec(ctx, "Staged all changes", "git", ["add", "-A"])
      return
    case "unstage-all":
      await exec(ctx, "Unstaged all changes", "git", ["reset"])
      return
    case "commit":
      prompt(
        ctx,
        {
          title: "Commit",
          placeholder: "commit message",
          hint:
            status && status.dirty.staged === 0
              ? "Nothing staged — everything will be staged first"
              : `${status?.dirty.staged ?? 0} staged`,
        },
        async (message) => {
          if (status && status.dirty.staged === 0) {
            const staged = await exec(ctx, "Staged", "git", ["add", "-A"], true)
            if (!staged) return
          }
          await exec(ctx, "Committed", "git", ["commit", "-m", message])
        },
      )
      return
    case "amend":
      confirm(
        ctx,
        "Amend last commit",
        `Fold the staged changes into "${status?.lastCommit?.subject ?? "the last commit"}"? Its hash changes.`,
        () => void exec(ctx, "Amended", "git", ["commit", "--amend", "--no-edit"]),
      )
      return
    case "stash":
      await exec(ctx, "Stashed", "git", ["stash", "push", "--include-untracked"])
      return
    case "stash-pop":
      await exec(ctx, "Popped stash", "git", ["stash", "pop"])
      return
    case "discard":
      confirm(
        ctx,
        "Discard all changes",
        "Reset tracked files to HEAD and delete untracked ones? This cannot be undone.",
        async () => {
          const reset = await exec(ctx, "Discarded", "git", ["reset", "--hard", "HEAD"], true)
          if (!reset) return
          await exec(ctx, "Discarded all changes", "git", ["clean", "-fd"])
        },
      )
      return
    case "pr-create":
      await exec(ctx, "Opened PR draft in browser", "gh", ["pr", "create", "--web"])
      return
    case "pr-view":
      await exec(ctx, "Opened PR in browser", "gh", ["pr", "view", "--web"])
      return
    case "open-remote": {
      const url = remoteWebUrl(status?.remoteUrl)
      if (!url) {
        ctx.toast.show({ variant: "info", message: "No web URL for this remote" })
        return
      }
      open(url).catch(() => ctx.toast.show({ variant: "error", message: "Could not open the browser" }))
      return
    }
    case "copy-remote":
      if (!status?.remoteUrl) return
      Clipboard.copy(status.remoteUrl)
        .then(() => ctx.toast.show({ variant: "info", message: "Copied remote URL" }))
        .catch(ctx.toast.error)
      return
    case "copy-branch":
      Clipboard.copy(branch)
        .then(() => ctx.toast.show({ variant: "info", message: `Copied ${branch}` }))
        .catch(ctx.toast.error)
      return
    case "refresh":
      ctx.refresh()
      return
  }
}
