import { A } from "@solidjs/router"

export default function NotFound() {
  return (
    <main class="min-h-screen w-full bg-background-base text-text-base flex flex-col items-center justify-center gap-4 p-6 text-center">
      <h1 class="text-24-medium text-text-strong">Share not found</h1>
      <p class="max-w-140 text-14-regular text-text-weaker">The link is invalid, expired, or no longer available.</p>
      <div class="flex items-center gap-4 text-14-medium">
        <A href="/" class="text-text-strong hover:text-text-base">
          Service home
        </A>
        <a href="https://nikcli-ai.dev" class="text-text-strong hover:text-text-base">
          nikcli-ai.dev
        </a>
      </div>
    </main>
  )
}
