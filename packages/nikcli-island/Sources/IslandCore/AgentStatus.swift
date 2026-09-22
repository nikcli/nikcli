import Foundation

/// nikcli is the only agent this island shows (unlike Pookify, which supports several
/// coding agents). Kept as an enum for parity with that design and in case a future
/// agent is added, but there is exactly one case today.
public enum Provider: String, Codable, Sendable, CaseIterable {
    case nikcli

    public var displayName: String { "nikcli" }

    /// Brand accent as sRGB components — nikcli's companion-UI blue (#58a6ff), the same
    /// accent already used in the web companion (src/server/routes/companion.ts).
    public var accentRGB: (r: Double, g: Double, b: Double) { (0.345, 0.651, 1.0) }
}

/// The normalized lifecycle state of a single session, mirrored from nikcli's own event
/// bus (session.status / permission.asked / permission.replied / message.part.updated)
/// by the CLI-side bridge — see packages/nikcli/src/plugin/island/bridge.ts.
public enum AgentState: String, Codable, Sendable {
    case idle        // session open, nothing happening
    case thinking    // model is reasoning between tools
    case tool        // running a tool (see `label`/`tool` for which)
    case permission  // blocked, awaiting the user's approval
    case done        // a turn just finished (transient -> collapses to idle)
    case error       // a turn ended on an error (transient)

    /// Higher = more important to surface when several sessions are live.
    public var priority: Int {
        switch self {
        case .permission:        return 3
        case .tool, .thinking:   return 2
        case .error, .done:      return 1
        case .idle:              return 0
        }
    }

    public var isWorking: Bool { self == .thinking || self == .tool }
}

/// One session's state, written by the nikcli CLI bridge and read by the app. This is
/// the entire on-disk contract — a flat, human-readable JSON file per session.
public struct SessionSnapshot: Codable, Sendable {
    public var schema: Int
    public var provider: Provider
    public var sessionId: String
    public var state: AgentState
    public var label: String        // human label, e.g. "Editing", "Awaiting permission"
    public var tool: String         // raw tool name, e.g. "Edit" (empty when not in a tool)
    public var project: String      // basename of cwd
    public var cwd: String
    public var pid: Int32           // the nikcli process; kill(pid,0) drives liveness
    public var port: Int32          // this process's local server port (0 = none/unknown)
    public var authorization: String // Authorization header that server requires (empty = none)
    public var startedAt: Double    // unix seconds the current turn began (0 = no active turn)
    public var ts: Double           // unix seconds this snapshot was written
    public var toolEndsAt: Double   // for a `tool` state: 0 = still running; >0 = finished,
                                    // keep the label until this time, then treat as thinking
    public var detail: String       // small context under the label, e.g. a file basename
    public var permissionId: String // set while state == .permission; used to reply
    public var parentId: String     // non-empty when this session is a subagent spawned
                                     // via delegation — the parent's own sessionID
    public var agentTitle: String   // the session's own title, shown for subagent rows

    public init(schema: Int = Island.stateSchema,
                provider: Provider = .nikcli,
                sessionId: String,
                state: AgentState,
                label: String = "",
                tool: String = "",
                project: String = "",
                cwd: String = "",
                pid: Int32 = 0,
                port: Int32 = 0,
                authorization: String = "",
                startedAt: Double = 0,
                ts: Double = 0,
                toolEndsAt: Double = 0,
                detail: String = "",
                permissionId: String = "",
                parentId: String = "",
                agentTitle: String = "") {
        self.schema = schema
        self.provider = provider
        self.sessionId = sessionId
        self.state = state
        self.label = label
        self.tool = tool
        self.project = project
        self.cwd = cwd
        self.pid = pid
        self.port = port
        self.authorization = authorization
        self.startedAt = startedAt
        self.ts = ts
        self.toolEndsAt = toolEndsAt
        self.detail = detail
        self.permissionId = permissionId
        self.parentId = parentId
        self.agentTitle = agentTitle
    }

    private enum CodingKeys: String, CodingKey {
        case schema, provider, state, label, tool, project, cwd, pid, port, authorization, startedAt, ts, toolEndsAt, detail, agentTitle
        case sessionId = "sessionID"
        case permissionId = "permissionID"
        case parentId = "parentID"
    }

    /// Tolerate older/newer files: unknown provider/state decode to safe defaults rather
    /// than failing the whole read.
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        schema       = (try? c.decode(Int.self, forKey: .schema)) ?? 1
        provider     = (try? c.decode(Provider.self, forKey: .provider)) ?? .nikcli
        sessionId    = (try? c.decode(String.self, forKey: .sessionId)) ?? ""
        state        = (try? c.decode(AgentState.self, forKey: .state)) ?? .idle
        label        = (try? c.decode(String.self, forKey: .label)) ?? ""
        tool         = (try? c.decode(String.self, forKey: .tool)) ?? ""
        project      = (try? c.decode(String.self, forKey: .project)) ?? ""
        cwd          = (try? c.decode(String.self, forKey: .cwd)) ?? ""
        pid          = (try? c.decode(Int32.self, forKey: .pid)) ?? 0
        port         = (try? c.decode(Int32.self, forKey: .port)) ?? 0
        authorization = (try? c.decode(String.self, forKey: .authorization)) ?? ""
        startedAt    = (try? c.decode(Double.self, forKey: .startedAt)) ?? 0
        ts           = (try? c.decode(Double.self, forKey: .ts)) ?? 0
        toolEndsAt   = (try? c.decode(Double.self, forKey: .toolEndsAt)) ?? 0
        detail       = (try? c.decode(String.self, forKey: .detail)) ?? ""
        permissionId = (try? c.decode(String.self, forKey: .permissionId)) ?? ""
        parentId     = (try? c.decode(String.self, forKey: .parentId)) ?? ""
        agentTitle   = (try? c.decode(String.self, forKey: .agentTitle)) ?? ""
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(schema, forKey: .schema)
        try c.encode(provider, forKey: .provider)
        try c.encode(sessionId, forKey: .sessionId)
        try c.encode(state, forKey: .state)
        try c.encode(label, forKey: .label)
        try c.encode(tool, forKey: .tool)
        try c.encode(project, forKey: .project)
        try c.encode(cwd, forKey: .cwd)
        try c.encode(pid, forKey: .pid)
        try c.encode(port, forKey: .port)
        try c.encode(authorization, forKey: .authorization)
        try c.encode(startedAt, forKey: .startedAt)
        try c.encode(ts, forKey: .ts)
        try c.encode(toolEndsAt, forKey: .toolEndsAt)
        try c.encode(detail, forKey: .detail)
        try c.encode(permissionId, forKey: .permissionId)
        try c.encode(parentId, forKey: .parentId)
        try c.encode(agentTitle, forKey: .agentTitle)
    }
}
