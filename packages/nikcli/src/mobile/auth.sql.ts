import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core"

// ============================================================================
// Mobile Auth Tokens (also used for cli-sync scope)
// ============================================================================

export const mobileTokens = sqliteTable(
  "mobile_tokens",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    hash: text("hash").notNull(),
    createdAt: integer("created_at").notNull(),
    lastUsedAt: integer("last_used_at"),
    expiresAt: integer("expires_at"),
    /**
     * Token scope: `mobile` (default, paired mobile device), `cli-sync`
     * (CLI↔server sync token, e.g. for https://s.nikcli-ai.dev), `studio`
     * (desktop UI). The server-side middleware enforces scope per route.
     */
    scope: text("scope").notNull().default("mobile"),
  },
  (table) => ({
    scopeIdx: index("idx_mobile_tokens_scope").on(table.scope),
  }),
)
