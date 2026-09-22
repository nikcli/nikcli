import { describe, expect, it } from "bun:test"
import { Session } from "@/session/index"

describe("Session", () => {
  describe("Info schema", () => {
    it("validates valid session info", () => {
      const validInfo = {
        id: "ses_abc123",
        slug: "test-session",
        projectID: "proj_123",
        directory: "/test/dir",
        title: "Test Session",
        version: "1.0.0",
        time: {
          created: Date.now(),
          updated: Date.now(),
        },
      }

      const parsed = Session.Info.parse(validInfo)
      expect(parsed.slug).toBe("test-session")
    })

    it("rejects invalid id format", () => {
      const invalidInfo = {
        id: "invalid-id",
        slug: "test",
        projectID: "proj_123",
        directory: "/test",
        title: "Test",
        version: "1.0.0",
        time: { created: Date.now(), updated: Date.now() },
      }

      expect(() => Session.Info.parse(invalidInfo)).toThrow()
    })

    it("accepts optional fields", () => {
      const infoWithOptionals = {
        id: "ses_abc123",
        slug: "test",
        projectID: "proj_123",
        directory: "/test",
        title: "Test",
        version: "1.0.0",
        time: { created: Date.now(), updated: Date.now() },
        parentID: "ses_parent123",
        workspaceID: "wrk_123",
        skills: ["skill1", "skill2"],
      }

      const parsed = Session.Info.parse(infoWithOptionals)
      expect(parsed.parentID).toBe("ses_parent123")
      expect(parsed.skills).toEqual(["skill1", "skill2"])
    })
  })

  describe("isDefaultTitle", () => {
    it("returns true for default parent session titles", () => {
      const defaultTitle = "New session - 2024-01-01T00:00:00.000Z"
      expect(Session.isDefaultTitle(defaultTitle)).toBe(true)
    })

    it("returns true for default child session titles", () => {
      const childTitle = "Child session - 2024-06-20T15:45:30.123Z"
      expect(Session.isDefaultTitle(childTitle)).toBe(true)
    })

    it("returns false for custom titles", () => {
      expect(Session.isDefaultTitle("My Session")).toBe(false)
      expect(Session.isDefaultTitle("Working on feature")).toBe(false)
      expect(Session.isDefaultTitle("new session - 2024-01-01T00:00:00.000Z")).toBe(false)
    })

    it("returns false for partial matches", () => {
      expect(Session.isDefaultTitle("New session")).toBe(false)
      expect(Session.isDefaultTitle("session - 2024-01-01T00:00:00.000Z")).toBe(false)
    })
  })

  describe("ShareInfo schema", () => {
    it("validates valid share info", () => {
      const validShare = {
        id: "share_123",
        mode: "local" as const,
        url: "https://nikcli-ai.dev/s/share123",
      }

      const parsed = Session.ShareInfo.parse(validShare)
      expect(parsed.mode).toBe("local")
      expect(parsed.url).toBe("https://nikcli-ai.dev/s/share123")
    })

    it("accepts minimal share info with only url", () => {
      const minimalShare = { url: "https://example.com/share" }
      const parsed = Session.ShareInfo.parse(minimalShare)
      expect(parsed.url).toBe("https://example.com/share")
    })
  })

  describe("Event definitions", () => {
    it("has Created event defined", () => {
      expect(Session.Event.Created).toBeDefined()
      expect(Session.Event.Created.type).toBe("session.created")
    })

    it("has Updated event defined", () => {
      expect(Session.Event.Updated).toBeDefined()
      expect(Session.Event.Updated.type).toBe("session.updated")
    })

    it("has Deleted event defined", () => {
      expect(Session.Event.Deleted).toBeDefined()
      expect(Session.Event.Deleted.type).toBe("session.deleted")
    })

    it("has Diff event defined", () => {
      expect(Session.Event.Diff).toBeDefined()
      expect(Session.Event.Diff.type).toBe("session.diff")
    })

    it("has Error event defined", () => {
      expect(Session.Event.Error).toBeDefined()
      expect(Session.Event.Error.type).toBe("session.error")
    })
  })

  describe("service contract schemas", () => {
    it("CreateInput schema is defined", () => {
      expect(Session.CreateInput).toBeDefined()
    })

    it("ID schema is defined", () => {
      expect(Session.ID).toBeDefined()
    })
  })
})
