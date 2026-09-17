import { Show } from "solid-js"
import type { Project } from "../host/project"
import { t } from "../i18n"

export interface ProjectBarProps {
  project?: Project
}

/**
 * Which project ADE is pointed at, in the top bar.
 *
 * The "senza isolamento" mark is the point of this component: outside a git
 * repository there are no worktrees to hand out, so every agent edits the
 * user's own files. That is a fact about their work, not a technical footnote,
 * and it belongs where they can see it without asking.
 */
export function ProjectBar(props: ProjectBarProps) {
  return (
    <Show when={props.project}>
      {(project) => (
        <div data-slot="ade-project">
          <Show when={project().name && project().name.toLowerCase() !== "nikcli"}>
            <span data-slot="ade-project-name">{project().name}</span>
          </Show>
          <Show when={project().branch}>
            {(branch) => (
              <span data-slot="ade-project-branch">
                <svg
                  viewBox="0 0 16 16"
                  width="11"
                  height="11"
                  aria-hidden="true"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.3"
                  stroke-linecap="round"
                >
                  <path d="M4 2v8" />
                  <circle cx="12" cy="4" r="2" />
                  <circle cx="4" cy="12" r="2" />
                  <path d="M12 6a6 6 0 0 1-6 6" />
                </svg>
                {branch()}
              </span>
            )}
          </Show>
          <Show when={!project().git}>
            <span data-slot="ade-project-warning" title={t("projectBar.noGit")}>
              {t("projectBar.noGit.short")}
            </span>
          </Show>
        </div>
      )}
    </Show>
  )
}
