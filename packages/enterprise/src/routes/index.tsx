import { Mark } from "@nikcli-ai/ui/logo"

export default function () {
  return (
    <main class="min-h-screen w-full bg-background-base text-text-base flex flex-col items-center justify-center gap-6 px-6 text-center">
      <a href="https://nikcli-ai.dev" class="inline-flex items-center gap-2 text-text-strong hover:text-text-base">
        <Mark class="w-4" />
        <span class="text-14-mono">nikcli</span>
      </a>
      <h1 class="text-24-medium text-text-strong">Nikcli share service</h1>
      <p class="max-w-140 text-14-regular text-text-weaker">
        This domain serves published Nikcli sessions. Open a valid share URL in the form
        <span class="text-text-base"> /share/&lt;id&gt;</span>.
      </p>
      <a
        href="https://nikcli-ai.dev"
        class="px-4 py-2 rounded-md bg-surface-strong border border-border-weak-base text-14-medium text-text-strong hover:bg-surface-stronger"
      >
        Go to nikcli-ai.dev
      </a>
    </main>
  )
}
