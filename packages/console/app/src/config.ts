/**
 * Application-wide constants and configuration
 */
export const config = {
  // Base URL
  baseUrl: "https://nikcli-ai.dev",

  // GitHub
  github: {
    repoUrl: "https://github.com/nikcli/nikcli",
    starsFormatted: {
      compact: "95K",
      full: "95,000",
    },
  },

  // Social links
  social: {
    twitter: "https://x.com/nikcli",
    discord: "https://discord.gg/nikcli",
  },

  // Static stats (used on landing page)
  stats: {
    contributors: "650",
    commits: "8,500",
    monthlyUsers: "2.5M",
  },
} as const
