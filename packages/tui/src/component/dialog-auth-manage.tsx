import { useKeyboard } from "@opentui/solid"
import { TextAttributes } from "@opentui/core"
import { Clipboard } from "@tui/util/clipboard"
import { createMemo, createResource, For, onMount, Show } from "solid-js"
import { DialogSelect, type DialogSelectOption } from "@tui/ui/dialog-select"
import { useDialog, type DialogContext } from "@tui/ui/dialog"
import { DialogPrompt } from "@tui/ui/dialog-prompt"
import { useToast } from "@tui/ui/toast"
import { DialogProvider } from "./dialog-provider"
import { useSDK } from "@tui/context/sdk"
import { UserApi } from "@tui/util/user-api"
import { UserSession } from "@nikcli-ai/util/user-session"
import type { UserSchema } from "@nikcli-ai/util/user-schema"
import { useTheme } from "@tui/context/theme"
import { DialogLogin } from "@tui/component/dialog-login"

type ProfileNotice = {
  message: string
  tone: "info" | "success" | "warning"
}

export function DialogAuthManage() {
  const dialog = useDialog()
  const sdk = useSDK()

  // The session used to be verified in-process against the user tables. It is
  // now `GET /user/me`, which means the answer arrives a frame late — and the
  // wrong branch rendered meanwhile would offer "Sign in" to someone already
  // signed in. Hold the menu until it lands; over worker RPC that is one frame.
  const [account] = createResource(() => UserApi.me(sdk))

  const options = createMemo<DialogSelectOption[]>(() => {
    if (account.loading) {
      return [
        {
          title: "Checking account…",
          value: "loading",
          category: "Account",
          disabled: true,
        },
      ]
    }

    const user = account()
    const items: DialogSelectOption[] = []

    if (user) {
      const displayName = user.display_name?.trim()
      items.push(
        {
          title: "View Profile",
          value: "profile",
          category: "Account",
          description: displayName ? `${displayName} · ${user.email}` : user.email,
          footer: getRoleLabel(user.role),
          onSelect: () => showProfile(dialog, user),
        },
        {
          title: "Change Display Name",
          value: "update_name",
          category: "Account",
          description: displayName ? `Current: ${displayName}` : "Set the name shown in chat and account views",
          onSelect: async () => {
            await updateDisplayName(dialog, sdk, user.id, user.display_name)
            dialog.replace(() => <DialogAuthManage />)
          },
        },
        {
          title: "Change Password",
          value: "update_password",
          category: "Account",
          description: "Update the password stored for this local account",
          onSelect: async () => {
            await updatePassword(dialog, sdk)
            dialog.replace(() => <DialogAuthManage />)
          },
        },
        {
          title: "Logout",
          value: "logout",
          category: "Account",
          description: `Signed in as ${user.username}`,
          onSelect: async () => {
            await logout(sdk)
            dialog.replace(() => <DialogAuthManage />)
          },
        },
      )
    } else {
      items.push({
        title: "Sign in",
        value: "login",
        category: "Account",
        description: "Continue with nikcli (browser) or use a local password",
        onSelect: async () => {
          await DialogLogin.run(dialog, sdk)
          dialog.replace(() => <DialogAuthManage />)
        },
      })
    }

    items.push({
      title: "Connect Provider",
      value: "connect_provider",
      category: "System",
      description: "Manage model provider credentials and connection state",
      onSelect: () => dialog.replace(() => <DialogProvider />),
    })

    return items
  })

  return <DialogSelect title="Account" options={options()} />
}

function showProfile(dialog: DialogContext, user: UserSchema.PublicUser, notice?: ProfileNotice) {
  dialog.replace(() => <DialogProfile user={user} notice={notice} />)
}

function DialogProfile(props: { user: UserSchema.PublicUser; notice?: ProfileNotice }) {
  const dialog = useDialog()
  const toast = useToast()
  const sdk = useSDK()
  const { theme } = useTheme()

  onMount(() => dialog.setSize("large"))

  const displayName = createMemo(() => props.user.display_name?.trim() || props.user.username)
  const subtitle = createMemo(() => {
    if (props.user.display_name?.trim()) return `@${props.user.username} · local profile`
    return `@${props.user.username} · add a display name for a friendlier handle`
  })
  // Counters come from the caller's own session (`GET /user/me/stats`), so they
  // arrive after the first paint. `—` is the honest placeholder: `0` would read
  // as "no contacts" before anything has been counted.
  const [counters] = createResource(() => UserApi.stats(sdk))
  const counter = (pick: (value: UserSchema.Stats) => number) => {
    const value = counters()
    return value ? String(pick(value)) : "—"
  }
  const memberFor = createMemo(() => formatRelativeAge(props.user.created_at))

  const restoreProfile = async (notice?: ProfileNotice, nextUser?: UserSchema.PublicUser | null) => {
    showProfile(dialog, nextUser ?? (await UserApi.me(sdk)) ?? props.user, notice)
  }

  const copyValue = async (value: string, label: string) => {
    await Clipboard.copy(value)
      .then(() =>
        toast.show({
          message: `${label} copied to clipboard`,
          variant: "info",
        }),
      )
      .catch(toast.error)
  }

  const handleDisplayName = async () => {
    const result = await updateDisplayName(dialog, sdk, props.user.id, props.user.display_name)
    const updated = result.cancelled ? null : result.user
    await restoreProfile(
      updated
        ? {
            tone: "success",
            message: updated.display_name ? "Display name updated." : "Display name cleared.",
          }
        : undefined,
      updated,
    )
  }

  const handlePassword = async () => {
    const changed = await updatePassword(dialog, sdk)
    await restoreProfile(changed ? { tone: "success", message: "Password updated." } : undefined)
  }

  const handleLogout = async () => {
    await logout(sdk)
    dialog.replace(() => <DialogAuthManage />)
  }

  const actions = createMemo(() => [
    {
      shortcut: "n",
      title: "Edit display name",
      description: props.user.display_name?.trim() || "Add a public-facing label for chat and account views",
      tone: "accent" as const,
      onSelect: () => {
        void handleDisplayName()
      },
    },
    {
      shortcut: "p",
      title: "Change password",
      description: "Rotate the password stored for this local account",
      tone: "warning" as const,
      onSelect: () => {
        void handlePassword()
      },
    },
    {
      shortcut: "c",
      title: "Copy email",
      description: props.user.email,
      tone: "info" as const,
      onSelect: () => {
        void copyValue(props.user.email, "Email")
      },
    },
    {
      shortcut: "u",
      title: "Copy username",
      description: props.user.username,
      tone: "default" as const,
      onSelect: () => {
        void copyValue(props.user.username, "Username")
      },
    },
    {
      shortcut: "l",
      title: "Logout",
      description: "Sign out of this device and return to the account menu",
      tone: "error" as const,
      onSelect: () => {
        void handleLogout()
      },
    },
  ])

  useKeyboard((evt) => {
    if (evt.name === "return") {
      evt.preventDefault()
      evt.stopPropagation()
      dialog.replace(() => <DialogAuthManage />)
      return
    }

    const action = actions().find((item) => item.shortcut === evt.name)
    if (!action) return
    evt.preventDefault()
    evt.stopPropagation()
    action.onSelect()
  })

  return (
    <box gap={1} paddingBottom={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD} fg={theme.foreground.default}>
          Profile
        </text>
        <text fg={theme.foreground.muted}>esc</text>
      </box>

      <box
        backgroundColor={theme.surface.offset}
        paddingLeft={1}
        paddingRight={1}
        paddingTop={1}
        paddingBottom={1}
        gap={1}
      >
        <box flexDirection="row" justifyContent="space-between" gap={2}>
          <box gap={0}>
            <text fg={theme.foreground.default} attributes={TextAttributes.BOLD}>
              {displayName()}
            </text>
            <text fg={theme.foreground.muted}>{subtitle()}</text>
          </box>
          <box backgroundColor={theme.surface.panel} paddingLeft={1} paddingRight={1} alignSelf="flex-start">
            <text fg={props.user.role === "admin" ? theme.status.warning.fg : theme.accent.alt}>
              {getRoleLabel(props.user.role)}
            </text>
          </box>
        </box>
        <text fg={theme.foreground.default}>{props.user.email}</text>
        <Show
          when={props.user.display_name?.trim()}
          fallback={
            <text fg={theme.foreground.muted}>
              Set a display name to make your local identity easier to recognize in chat.
            </text>
          }
        >
          <text fg={theme.foreground.muted}>
            Your display name is already configured and shown wherever this profile appears.
          </text>
        </Show>
      </box>

      <Show when={props.notice}>{(notice) => <ProfileNoticeBox notice={notice()} />}</Show>

      <box flexDirection="row" gap={1}>
        <ProfileStat label="Contacts" value={counter((value) => value.contacts)} tone="accent" />
        <ProfileStat
          label="Unread"
          value={counter((value) => value.unread)}
          tone={(counters()?.unread ?? 0) > 0 ? "warning" : "default"}
        />
        <ProfileStat label="Member For" value={memberFor()} tone="success" />
      </box>

      <box gap={1}>
        <text fg={theme.accent.alt} attributes={TextAttributes.BOLD}>
          Details
        </text>
        <box
          backgroundColor={theme.surface.offset}
          paddingLeft={1}
          paddingRight={1}
          paddingTop={1}
          paddingBottom={1}
          gap={1}
        >
          <ProfileField label="Username" value={props.user.username} />
          <ProfileField label="Display" value={props.user.display_name?.trim() || "Not set"} />
          <ProfileField label="Email" value={props.user.email} />
          <ProfileField label="Role" value={getRoleLabel(props.user.role)} />
          <ProfileField label="Joined" value={formatDate(props.user.created_at)} />
          <ProfileField label="Updated" value={formatDate(props.user.updated_at)} />
        </box>
      </box>

      <box gap={1}>
        <text fg={theme.accent.alt} attributes={TextAttributes.BOLD}>
          Quick Actions
        </text>
        <box gap={1}>
          <For each={actions()}>{(action) => <ProfileActionRow {...action} />}</For>
        </box>
      </box>

      <text fg={theme.foreground.muted}>
        <span style={{ fg: theme.accent.fg }}>enter</span> back to account menu ·{" "}
        <span style={{ fg: theme.accent.fg }}>esc</span> close
      </text>
    </box>
  )
}

function ProfileNoticeBox(props: { notice: ProfileNotice }) {
  const { theme } = useTheme()

  const color = createMemo(() => {
    if (props.notice.tone === "success") return theme.status.success.fg
    if (props.notice.tone === "warning") return theme.status.warning.fg
    return theme.status.info.fg
  })

  return (
    <box backgroundColor={theme.surface.offset} paddingLeft={1} paddingRight={1} paddingTop={1} paddingBottom={1}>
      <text fg={color()}>{props.notice.message}</text>
    </box>
  )
}

function ProfileStat(props: { label: string; value: string; tone: "default" | "accent" | "warning" | "success" }) {
  const { theme } = useTheme()

  const color = createMemo(() => {
    if (props.tone === "accent") return theme.accent.alt
    if (props.tone === "warning") return theme.status.warning.fg
    if (props.tone === "success") return theme.status.success.fg
    return theme.foreground.default
  })

  return (
    <box
      flexGrow={1}
      backgroundColor={theme.surface.offset}
      paddingLeft={1}
      paddingRight={1}
      paddingTop={1}
      paddingBottom={1}
    >
      <box gap={0}>
        <text fg={theme.foreground.muted}>{props.label}</text>
        <text fg={color()} attributes={TextAttributes.BOLD}>
          {props.value}
        </text>
      </box>
    </box>
  )
}

function ProfileField(props: { label: string; value: string }) {
  const { theme } = useTheme()

  return (
    <box flexDirection="row" gap={2}>
      <box width={12} flexShrink={0}>
        <text fg={theme.foreground.muted}>{props.label}</text>
      </box>
      <text fg={theme.foreground.default} wrapMode="word">
        {props.value}
      </text>
    </box>
  )
}

function ProfileActionRow(props: {
  shortcut: string
  title: string
  description: string
  tone: "default" | "accent" | "info" | "warning" | "error"
  onSelect: () => void
}) {
  const { theme } = useTheme()

  const color = createMemo(() => {
    if (props.tone === "accent") return theme.accent.alt
    if (props.tone === "info") return theme.status.info.fg
    if (props.tone === "warning") return theme.status.warning.fg
    if (props.tone === "error") return theme.status.error.fg
    return theme.foreground.default
  })

  return (
    <box
      backgroundColor={theme.surface.offset}
      paddingLeft={1}
      paddingRight={1}
      paddingTop={1}
      paddingBottom={1}
      onMouseUp={() => props.onSelect()}
    >
      <box gap={0}>
        <text fg={theme.foreground.default}>
          <span style={{ fg: color(), attributes: TextAttributes.BOLD }}>{props.shortcut}</span> {props.title}
        </text>
        <text fg={theme.foreground.muted} wrapMode="word">
          {props.description}
        </text>
      </box>
    </box>
  )
}

/**
 * Backing out and a failed update are different answers, and this used to give
 * the same one: `undefined` on cancel, `null` when the update failed. Two falsy
 * values a caller cannot tell apart.
 *
 * Not a cue to skip reopening the menu — in this codebase a nested flow
 * *replaces* its parent, so the caller restoring it afterwards is how the user
 * gets back, on cancel exactly as on success.
 */
type DisplayNameResult = { cancelled: true } | { cancelled: false; user: UserSchema.PublicUser | null }

async function updateDisplayName(
  dialog: DialogContext,
  sdk: UserApi.Sdk,
  userId: string,
  currentName: string | null,
): Promise<DisplayNameResult> {
  const value = await DialogPrompt.show(dialog, "Change Display Name", {
    placeholder: "Enter display name (leave empty to remove)",
    value: currentName ?? "",
    allowEmpty: true,
  })
  if (value === null) return { cancelled: true }

  const updated = await UserApi.update(sdk, userId, { displayName: value })
  return { cancelled: false, user: updated.ok ? updated.data : null }
}

async function updatePassword(dialog: DialogContext, sdk: UserApi.Sdk): Promise<boolean> {
  const current = await DialogPrompt.show(dialog, "Change Password — Current", {
    placeholder: "Enter current password",
  })
  if (current === null) return false

  const newPass = await DialogPrompt.show(dialog, "Change Password — New", {
    placeholder: "Enter new password (min 8 chars)",
  })
  if (newPass === null) return false

  if (newPass.length < 8) {
    const retry = await DialogPrompt.show(dialog, "Password too short. Press Enter to retry.", {
      placeholder: "Press Enter",
    })
    if (retry === null) return false
    return updatePassword(dialog, sdk)
  }

  const confirm = await DialogPrompt.show(dialog, "Change Password — Confirm", {
    placeholder: "Confirm new password",
  })
  if (confirm === null) return false

  if (newPass !== confirm) {
    const retry = await DialogPrompt.show(dialog, "Passwords do not match. Press Enter to retry.", {
      placeholder: "Press Enter",
    })
    if (retry === null) return false
    return updatePassword(dialog, sdk)
  }

  // The current password is checked where the hash lives, not here: a wrong one
  // comes back as the route's own message rather than a local guess.
  const changed = await UserApi.changePassword(sdk, { current, next: newPass })
  if (!changed.ok) {
    const retry = await DialogPrompt.show(dialog, `${changed.error}. Press Enter to retry.`, {
      placeholder: "Press Enter",
    })
    if (retry === null) return false
    return updatePassword(dialog, sdk)
  }
  return true
}

async function logout(sdk: UserApi.Sdk) {
  // Revoke server-side first; the local token is dropped either way, so a failed
  // round trip still signs this machine out rather than leaving it half-signed-in.
  await UserApi.logout(sdk)
  await UserSession.clear()
}

function getRoleLabel(role: UserSchema.Role) {
  return role === "admin" ? "Administrator" : "User"
}

function formatDate(value: number) {
  return new Date(value).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  })
}

function formatRelativeAge(value: number) {
  const diff = Math.max(0, Date.now() - value)
  const days = Math.floor(diff / (24 * 60 * 60 * 1000))

  if (days <= 0) return "Today"
  if (days < 30) return `${days}d`

  const months = Math.floor(days / 30)
  if (months < 12) return `${months}mo`

  return `${Math.floor(days / 365)}y`
}
