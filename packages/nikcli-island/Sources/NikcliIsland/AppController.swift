import AppKit
import SwiftUI
import IslandCore

/// Ties everything together: polls the session files, drives the island model, shows
/// the menu, replies to permission requests, and self-quits when nothing is running so
/// there's no idle process to manage.
@MainActor
final class AppController: NSObject, NSApplicationDelegate {
    private let model = IslandModel()
    private lazy var windowController = NotchWindowController(model: model)
    private var pollTimer: Timer?

    private let launchedAt = Date()
    private var notNeededSince: Date?
    private let launchGrace: TimeInterval = 5
    private let idleQuitDelay: TimeInterval = 4

    func applicationDidFinishLaunching(_ notification: Notification) {
        Island.ensureDirs()

        // Single instance: if another live NikcliIsland already owns the notch, bow out.
        if let s = try? String(contentsOf: Island.appPidFile, encoding: .utf8),
           let pid = Int32(s.trimmingCharacters(in: .whitespacesAndNewlines)), pid > 0,
           pid != ProcessInfo.processInfo.processIdentifier,
           kill(pid, 0) == 0,
           let other = NSRunningApplication(processIdentifier: pid),
           other.executableURL?.lastPathComponent == Island.executableName {
            NSApp.terminate(nil)
            return
        }
        try? "\(ProcessInfo.processInfo.processIdentifier)"
            .write(to: Island.appPidFile, atomically: true, encoding: .utf8)

        model.onActivate = { [weak self] in self?.toggleExpanded() }
        model.onSelectSession = { [weak self] id in self?.selectSession(id) }
        model.onQuit = { [weak self] in self?.quit() }
        model.onChooseDisplay = { [weak self] id in self?.chooseDisplay(id) }
        model.onReplyPermission = { [weak self] reply, permissionId, port in
            self?.replyPermission(reply, permissionId: permissionId, port: port)
        }
        windowController.install()

        if ProcessInfo.processInfo.environment["ISLAND_FORCE_EXPAND"] == "1" {
            model.userExpanded = true
        }

        let t = Timer(timeInterval: 0.4, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.tick() }
        }
        RunLoop.main.add(t, forMode: .common)
        pollTimer = t
        tick()
    }

    // MARK: poll loop

    private var pollInFlight = false

    private func tick() {
        guard !pollInFlight else { return }
        pollInFlight = true
        DispatchQueue.global(qos: .utility).async { [weak self] in
            let decision = SessionAggregator.evaluate()
            DispatchQueue.main.async {
                MainActor.assumeIsolated {
                    guard let self else { return }
                    self.pollInFlight = false
                    self.apply(decision)
                    self.checkLifecycle(liveCount: decision.liveCount)
                }
            }
        }
    }

    private var hidePending = false
    private var hideWork: DispatchWorkItem?
    private var openingWork: DispatchWorkItem?
    private var lastDecision: IslandDecision?

    /// Picks which session the pill's single-detail fields (label/detail/permissionId/…)
    /// reflect. A pin is only overridden by auto-surfacing the top-priority session when
    /// the pin *isn't itself* the thing demanding attention — otherwise two simultaneous
    /// permission requests (e.g. two subagents blocked at once) would fight over the
    /// display and whichever one the user pinned second would become unreachable.
    private func displayedSession(_ d: IslandDecision) -> SessionInfo? {
        guard let top = d.sessions.first else { return nil }
        if let pin = model.pinnedId, let pinned = d.sessions.first(where: { $0.id == pin }) {
            if pinned.state == .permission || top.state != .permission { return pinned }
        }
        return top
    }

    private func selectSession(_ id: String) {
        model.pinnedId = (model.pinnedId == id) ? nil : id
        if let d = lastDecision { apply(d) }
    }

    private func apply(_ d: IslandDecision) {
        lastDecision = d
        let wasVisible = model.isVisible

        if let pin = model.pinnedId, !d.sessions.contains(where: { $0.id == pin }) {
            model.pinnedId = nil
        }

        if d.visible {
            hidePending = false
            hideWork?.cancel(); hideWork = nil
            if model.collapsing { model.collapsing = false }
            if !model.isVisible {
                model.isVisible = true
                model.opening = true
                openingWork?.cancel()
                let work = DispatchWorkItem { [weak self] in
                    MainActor.assumeIsolated {
                        guard let self else { return }
                        self.model.opening = false
                        self.openingWork = nil
                    }
                }
                openingWork = work
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.55, execute: work)
            }
            let shown = displayedSession(d)!
            if model.sessions != d.sessions {
                let countChanged = model.sessions.count != d.sessions.count
                model.sessions = d.sessions
                if countChanged { windowController.refreshInteractivity() }
            }
            if model.displayedId != shown.id { model.displayedId = shown.id }
            if model.provider != shown.provider { model.provider = shown.provider }
            if model.state != shown.state { model.state = shown.state }
            if model.label != shown.label { model.label = shown.label }
            if model.detail != shown.detail { model.detail = shown.detail }
            if model.startedAt != shown.startedAt { model.startedAt = shown.startedAt }
            if model.permissionId != shown.permissionId { model.permissionId = shown.permissionId }
            if model.permissionPort != shown.port { model.permissionPort = shown.port }
            let wasForce = model.forceExpand
            if model.forceExpand != d.forceExpand { model.forceExpand = d.forceExpand }
            if d.forceExpand && !wasForce { setExpanded(true) }
            else if !d.forceExpand && wasForce { setExpanded(false) }
        } else if model.isVisible && !hidePending {
            if model.isTall {
                hidePending = true
                openingWork?.cancel(); openingWork = nil
                model.opening = false
                if model.forceExpand { model.forceExpand = false }
                model.collapsing = true
                setExpanded(false)
                let work = DispatchWorkItem { [weak self] in
                    MainActor.assumeIsolated {
                        guard let self else { return }
                        self.model.isVisible = false
                        self.model.collapsing = false
                        self.hidePending = false
                        self.hideWork = nil
                        self.windowController.refreshInteractivity()
                    }
                }
                hideWork = work
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.5, execute: work)
            } else {
                model.isVisible = false
            }
        }

        if wasVisible != model.isVisible { windowController.refreshInteractivity() }
    }

    // MARK: expand / collapse

    private var clickMonitor: Any?

    private func toggleExpanded() { setExpanded(!model.userExpanded) }

    private func setExpanded(_ on: Bool) {
        if model.userExpanded != on { model.userExpanded = on }
        if on {
            if clickMonitor == nil {
                clickMonitor = NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown]) { [weak self] _ in
                    MainActor.assumeIsolated { self?.setExpanded(false) }
                }
            }
        } else if let m = clickMonitor {
            NSEvent.removeMonitor(m)
            clickMonitor = nil
        }
    }

    private func checkLifecycle(liveCount: Int) {
        let now = Date()
        if now.timeIntervalSince(launchedAt) < launchGrace { return }
        if liveCount > 0 { notNeededSince = nil; return }
        if let since = notNeededSince {
            if now.timeIntervalSince(since) >= idleQuitDelay { NSApp.terminate(nil) }
        } else {
            notNeededSince = now
        }
    }

    /// Move the island to a chosen display (nil = automatic).
    private func chooseDisplay(_ id: CGDirectDisplayID?) {
        NSScreen.preferredDisplayID = id
        windowController.relocate()
    }

    // MARK: permission reply

    /// POST the reply straight to the nikcli process that asked, using the port the
    /// bridge stamped into the session's snapshot file. Best-effort: nikcli already
    /// times permission requests out on its own if nobody answers, so a failed POST
    /// here just means the user tries again (or answers in the terminal instead).
    ///
    /// Takes the target permissionId/port explicitly (rather than reading model's
    /// singular `permissionId`/`permissionPort`) because several sessions can each have
    /// their own pending request shown at once — replying to one must not touch the
    /// others still waiting.
    private func replyPermission(_ reply: String, permissionId: String, port: Int32) {
        guard port > 0, !permissionId.isEmpty else { return }
        guard let url = URL(string: "http://127.0.0.1:\(port)/permission/\(permissionId)/reply") else { return }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        // The server may require a password (the background service always
        // does); the bridge stamps the header it needs into the snapshot.
        if let authorization = model.sessions.first(where: { $0.permissionId == permissionId })?.authorization,
           !authorization.isEmpty {
            req.setValue(authorization, forHTTPHeaderField: "Authorization")
        }
        req.httpBody = try? JSONSerialization.data(withJSONObject: ["reply": reply])
        URLSession.shared.dataTask(with: req).resume()
        // Optimistic: clear just this request immediately rather than waiting the ~0.4s
        // poll for permission.replied to land in a fresh snapshot.
        if let idx = model.sessions.firstIndex(where: { $0.permissionId == permissionId }) {
            model.sessions[idx].state = .thinking
            model.sessions[idx].permissionId = ""
        }
        if model.permissionId == permissionId {
            model.state = .thinking
            model.permissionId = ""
        }
        // Only drop back to the slim pill once nothing else is still waiting.
        if !model.sessions.contains(where: { $0.state == .permission }) {
            setExpanded(false)
        }
    }

    /// Quit gracefully: de-expand to the slim bar, retract into the notch, and only
    /// then terminate.
    @objc private func quit() {
        guard model.isVisible, !quitting else {
            if !quitting { NSApp.terminate(nil) }
            return
        }
        quitting = true
        pollTimer?.invalidate(); pollTimer = nil
        hideWork?.cancel(); hideWork = nil
        model.forceExpand = false
        model.collapsing = true
        setExpanded(false)
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in
            MainActor.assumeIsolated {
                guard let self else { return }
                self.model.isVisible = false
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.45) {
                    MainActor.assumeIsolated { NSApp.terminate(nil) }
                }
            }
        }
    }
    private var quitting = false

    func applicationWillTerminate(_ notification: Notification) {
        pollTimer?.invalidate()
        pollTimer = nil
        if let m = clickMonitor { NSEvent.removeMonitor(m); clickMonitor = nil }
        windowController.tearDown()
        if let s = try? String(contentsOf: Island.appPidFile, encoding: .utf8),
           Int32(s.trimmingCharacters(in: .whitespacesAndNewlines)) == ProcessInfo.processInfo.processIdentifier {
            try? FileManager.default.removeItem(at: Island.appPidFile)
        }
    }
}
