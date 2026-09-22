import Foundation
import IslandCore

/// One session as the UI shows it: its effective (display) state plus the strings the
/// pill and the session stack render. `id` is the bridge's session id, so a row keeps
/// its identity across polls (SwiftUI diffing, pinning).
struct SessionInfo: Identifiable, Equatable {
    let id: String
    var provider: Provider
    var state: AgentState    // effective state (caps/lingers applied), never .idle here
    var label: String        // "Editing", "Thinking…", "Awaiting permission", …
    var detail: String       // file basename while in a tool, else empty
    var project: String      // basename of the session's cwd
    var startedAt: Double    // turn clock start (0 = no active turn)
    var permissionId: String // non-empty while state == .permission
    var port: Int32          // local server port to POST the permission reply to (0 = none)
    var authorization: String // Authorization header that server requires (empty = none)
    var isSubagent: Bool     // true when spawned via delegation (has a parent session)
    var agentTitle: String   // this session's own title — distinguishes subagent rows
                             // that would otherwise show the same `project` as their parent
}

/// Turns the set of on-disk session files into a single decision about what the island
/// should show. Stateless: it reaps dead sessions and surfaces every live one, ordered
/// by urgency (a permission request always beats one merely working).
///
/// Unlike Pookify (which has to infer liveness from hook files alone, with no signal
/// between events), nikcli's bridge writes a fresh snapshot on every real state change
/// AND clears the file outright on session end / process exit — so this aggregator
/// doesn't need transcript-mtime heuristics or interruption-marker scanning. It keeps
/// the same generous linger/backstop caps Pookify uses, purely so a session that stops
/// updating (a killed terminal, a crashed process) doesn't stay on screen forever.
struct IslandDecision {
    var sessions: [SessionInfo]
    var visible: Bool
    var liveCount: Int
    var forceExpand: Bool

    static let hidden = IslandDecision(sessions: [], visible: false, liveCount: 0, forceExpand: false)
}

enum SessionAggregator {

    static let doneLinger: TimeInterval = 2.5
    static let errorLinger: TimeInterval = 3.5
    // A tool still running (toolEndsAt == 0) gets a long window; quiet reasoning goes
    // idle much sooner; permission may legitimately sit for a long time.
    static let permissionCap: TimeInterval = 7200
    // Backstop: nikcli's own idle/error events should always clear a session promptly,
    // so this only bites a true zombie (a process that died mid-write, or a missed exit
    // handler). Generous so a genuinely long silent think is never hidden early.
    static let workBackstopCap: TimeInterval = 900
    // How long past its last update a session keeps the app alive.
    static let appHold: TimeInterval = 300
    // Hard reap: delete a file this old no matter what.
    static let reapCap: TimeInterval = 7200

    static func pidAlive(_ pid: Int32) -> Bool {
        if pid <= 0 { return false }
        return kill(pid, 0) == 0 || errno == EPERM
    }

    static func effectiveState(_ s: SessionSnapshot, now: Double) -> AgentState {
        func aliveWithin(_ cap: TimeInterval) -> Bool { now - s.ts <= cap }
        switch s.state {
        case .thinking:
            return aliveWithin(workBackstopCap) ? .thinking : .idle
        case .tool:
            if s.toolEndsAt > 0 && now > s.toolEndsAt {
                return aliveWithin(workBackstopCap) ? .thinking : .idle
            }
            return aliveWithin(workBackstopCap) ? .tool : .idle
        case .permission:
            return (now - s.ts > permissionCap) ? .idle : .permission
        case .done:
            return (now - s.ts <= doneLinger) ? .done : .idle
        case .error:
            return (now - s.ts <= errorLinger) ? .error : .idle
        case .idle:
            return .idle
        }
    }

    /// Read all files, reap dead ones, and decide what to surface.
    static func evaluate(now: Double = Date().timeIntervalSince1970) -> IslandDecision {
        var live: [SessionSnapshot] = []
        for url in StateStore.listFiles() {
            guard let snap = StateStore.read(url) else { continue }
            let processGone = snap.pid > 0 && !pidAlive(snap.pid)
            if processGone || now - snap.ts > reapCap {
                try? FileManager.default.removeItem(at: url)
                continue
            }
            live.append(snap)
        }

        let liveCount = live.filter {
            effectiveState($0, now: now) != .idle || now - $0.ts <= appHold
        }.count
        guard !live.isEmpty else { return .hidden }

        // Idle sessions are kept (not dropped) so a nikcli that's open but between turns
        // still surfaces the closed pill instead of the island retracting to nothing —
        // it only fully hides once the session file itself is gone (process exited).
        let sessions: [SessionInfo] = live.map { s in
            let eff = effectiveState(s, now: now)
            return SessionInfo(
                id: s.sessionId,
                provider: s.provider,
                state: eff,
                label: (s.state == .tool && eff == .thinking) ? "Thinking…" : s.label,
                detail: eff == .tool ? s.detail : "",
                project: s.project,
                startedAt: s.startedAt,
                permissionId: eff == .permission ? s.permissionId : "",
                port: s.port,
                authorization: s.authorization,
                isSubagent: !s.parentId.isEmpty,
                agentTitle: s.agentTitle
            )
        }.sorted { a, b in
            if a.state.priority != b.state.priority { return a.state.priority > b.state.priority }
            if a.startedAt != b.startedAt { return a.startedAt > b.startedAt }
            return a.id < b.id
        }

        return IslandDecision(
            sessions: sessions,
            visible: !sessions.isEmpty,
            liveCount: liveCount,
            forceExpand: sessions.first?.state == .permission
        )
    }
}
