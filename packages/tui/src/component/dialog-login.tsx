import { DialogPrompt } from "@tui/ui/dialog-prompt"
import type { DialogContext } from "@tui/ui/dialog"
import { DialogSelect } from "@tui/ui/dialog-select"
import { UserApi } from "@tui/util/user-api"
import { UserSession } from "@nikcli-ai/util/user-session"
import type { UserSchema } from "@nikcli-ai/util/user-schema"
import { DialogAccountLogin } from "@tui/component/dialog-account-login"

type LoginChoice = "oauth" | "local"

function choose(dialog: DialogContext, hasUsers: boolean): Promise<LoginChoice | null> {
  return new Promise((resolve) => {
    dialog.replace(
      () => (
        <DialogSelect
          title="Sign in to nikcli"
          options={[
            {
              title: "Continue with nikcli",
              value: "oauth" as LoginChoice,
              description: "Sign in through your browser with GitHub or an email code.",
            },
            {
              title: hasUsers ? "Use a local password" : "Create a local account",
              value: "local" as LoginChoice,
              description: hasUsers
                ? "Legacy sign-in against this machine's local account."
                : "Offline fallback — a password-based account stored on this machine.",
            },
          ]}
          onSelect={(option) => resolve(option.value)}
        />
      ),
      () => resolve(null),
    )
  })
}

function oauthLogin(dialog: DialogContext): Promise<UserSchema.PublicUser | null> {
  return new Promise((resolve) => {
    dialog.replace(
      () => <DialogAccountLogin onComplete={resolve} />,
      () => resolve(null),
    )
  })
}

/**
 * Startup sign-in flow. OAuth (device code against auth.nikcli-ai.dev) is the
 * primary path — it links the identity to the local user database so the TUI
 * session works exactly as before. The password flow remains as the offline
 * fallback for self-hosted machines.
 * Returns the authenticated PublicUser or null if the user cancels.
 */
export const DialogLogin = {
  async run(dialog: DialogContext, sdk: UserApi.Sdk): Promise<UserSchema.PublicUser | null> {
    // `useSDK()` cannot be read here: this runs from an async continuation, where
    // Solid's owner is gone and `useContext` would return undefined. The caller
    // holds the context and passes the transport in.
    const hasUsers = (await UserApi.hasUsers(sdk)) ?? false
    const choice = await choose(dialog, hasUsers)
    if (choice === null) return null
    if (choice === "oauth") {
      const user = await oauthLogin(dialog)
      if (user) return user
      // Cancelled or failed — back to the chooser rather than dead-ending.
      return DialogLogin.run(dialog, sdk)
    }
    return DialogLogin.runLocal(dialog, sdk)
  },

  async runLocal(dialog: DialogContext, sdk: UserApi.Sdk): Promise<UserSchema.PublicUser | null> {
    const hasUsers = (await UserApi.hasUsers(sdk)) ?? false

    if (!hasUsers) {
      // Registration flow — first user becomes admin
      const username = await DialogPrompt.show(dialog, "Create nikcli account — Username", {
        placeholder: "Enter a username (min 2 chars)",
      })
      if (!username || username.trim().length < 2) return null

      const email = await DialogPrompt.show(dialog, "Create nikcli account — Email", {
        placeholder: "Enter your email address",
      })
      if (!email || !email.includes("@")) return null

      const password = await DialogPrompt.show(dialog, "Create nikcli account — Password", {
        placeholder: "Enter a password (min 8 chars)",
      })
      if (!password || password.trim().length < 8) return null

      const created = await UserApi.register(sdk, {
        username: username.trim(),
        email: email.trim().toLowerCase(),
        password,
      })
      if (!created.ok) {
        await DialogPrompt.show(dialog, `Registration failed: ${created.error}. Press Enter to retry.`, {
          placeholder: "Press Enter",
        })
        return DialogLogin.runLocal(dialog, sdk)
      }
      await UserSession.save(created.data.token)
      dialog.clear()
      return created.data.user
    } else {
      // Login flow
      const email = await DialogPrompt.show(dialog, "Sign in to nikcli — Email", {
        placeholder: "Enter your email address",
      })
      if (!email) return null

      const password = await DialogPrompt.show(dialog, "Sign in to nikcli — Password", {
        placeholder: "Enter your password",
      })
      if (password === null) return null

      // One message for both an unknown email and a wrong password: the route
      // answers the same "Invalid credentials" for each, so it does not confirm
      // whether an address has an account on this machine.
      const session = await UserApi.login(sdk, { email: email.trim().toLowerCase(), password })
      if (!session.ok) {
        await DialogPrompt.show(dialog, `${session.error}. Press Enter to retry.`, {
          placeholder: "Press Enter",
        })
        return DialogLogin.runLocal(dialog, sdk)
      }

      await UserSession.save(session.data.token)
      dialog.clear()
      return session.data.user
    }
  },
}
