// OmaBond service: local daemon lifecycle and QML-friendly command queue.
import QtQuick
import Quickshell
import Quickshell.Io

Item {
  id: root

  property var shell: null
  property var manifest: null
  property bool ready: false
  property bool busy: false
  property string activeOperation: ""
  property string errorText: ""
  property string pairingCode: ""
  property var tailscale: null
  property string tailscaleError: ""
  property bool paired: false
  property var selfProfile: ({ name: "", emoji: "💛", status: "" })
  property var peer: null
  property bool peerOnline: false
  property var peerProfile: null
  property string peerLastSeen: ""
  property var messages: []
  property int queued: 0
  property var operationQueue: []
  property var currentRequest: null

  readonly property string pluginDir: manifest && manifest.__sourceDir ? String(manifest.__sourceDir) : ""
  readonly property string workerPath: pluginDir ? pluginDir + "/scripts/omabond.mjs" : ""

  function applyPayload(payload) {
    if (!payload || payload.ok !== true) {
      errorText = payload && payload.error ? String(payload.error) : "OmaBond request failed"
      return
    }
    errorText = ""
    ready = payload.serviceReady === true
    if (payload.tailscale !== undefined) tailscale = payload.tailscale
    if (payload.tailscaleError !== undefined) tailscaleError = String(payload.tailscaleError || "")
    if (payload.paired !== undefined) paired = payload.paired === true
    if (payload.self !== undefined) selfProfile = payload.self || selfProfile
    if (payload.peer !== undefined) peer = payload.peer
    if (payload.peerOnline !== undefined) peerOnline = payload.peerOnline === true
    if (payload.peerProfile !== undefined) peerProfile = payload.peerProfile
    if (payload.peerLastSeen !== undefined) peerLastSeen = String(payload.peerLastSeen || "")
    if (Array.isArray(payload.messages)) messages = payload.messages
    if (payload.queued !== undefined) queued = Math.max(0, Number(payload.queued) || 0)
    if (payload.pairingCode !== undefined) pairingCode = String(payload.pairingCode || "")
  }

  function enqueue(operation, input) {
    var request = { operation: String(operation), input: input || {} }
    var next = operationQueue.slice()
    if (request.operation === "status" || request.operation === "sync") {
      next = next.filter(function(item) { return item.operation !== request.operation })
    }
    next.push(request)
    operationQueue = next
    runNext()
  }

  function runNext() {
    if (client.running || currentRequest || operationQueue.length === 0 || workerPath === "") return
    var next = operationQueue.slice()
    currentRequest = next.shift()
    operationQueue = next
    activeOperation = currentRequest.operation
    busy = currentRequest.operation !== "status" && currentRequest.operation !== "sync"
    client.command = ["node", workerPath, currentRequest.operation]
    client.stdinEnabled = true
    client.running = true
  }

  function finishRequest(exitCode) {
    var raw = String(clientStdout.text || "").trim()
    if (raw !== "") {
      try { applyPayload(JSON.parse(raw.split("\n").pop())) }
      catch (_) { errorText = "Could not read the OmaBond response" }
    } else if (exitCode !== 0 && activeOperation !== "status") {
      errorText = String(clientStderr.text || "").trim() || "Could not reach the OmaBond service"
    }
    currentRequest = null
    activeOperation = ""
    busy = false
    Qt.callLater(runNext)
  }

  function status() { enqueue("status", {}) }
  function createPairingCode() { enqueue("pair-create", {}) }
  function showPairingCode() { enqueue("pair-code", {}) }
  function joinPair(code) { enqueue("pair-import", { code: String(code || "").trim() }) }
  function saveProfile(name, emoji, statusText) {
    enqueue("profile", { name: String(name || ""), emoji: String(emoji || ""), status: String(statusText || "") })
  }
  function sendMessage(text) { enqueue("message", { text: String(text || "") }) }
  function sendNudge(emoji) { enqueue("nudge", { text: String(emoji || "💛") }) }
  function unpair() { pairingCode = ""; enqueue("unpair", {}) }
  function sync() { enqueue("sync", {}) }

  Process {
    id: daemon
    command: root.workerPath ? ["node", root.workerPath, "daemon"] : []
    stdout: SplitParser { onRead: function(_) { root.status() } }
    stderr: StdioCollector { id: daemonStderr; waitForEnd: true }
    onExited: function(exitCode) {
      if (exitCode !== 0) root.errorText = String(daemonStderr.text || "OmaBond service stopped").trim()
      daemonRestart.start()
    }
  }

  Timer {
    id: daemonRestart
    interval: 2000
    repeat: false
    onTriggered: if (root.workerPath !== "" && !daemon.running) daemon.running = true
  }

  Process {
    id: client
    stdout: StdioCollector { id: clientStdout; waitForEnd: true }
    stderr: StdioCollector { id: clientStderr; waitForEnd: true }
    onStarted: {
      write(JSON.stringify(root.currentRequest ? root.currentRequest.input : {}) + "\n")
      stdinEnabled = false
    }
    onExited: function(exitCode) { root.finishRequest(exitCode) }
  }

  Timer {
    interval: 5000
    running: true
    repeat: true
    onTriggered: root.status()
  }

  IpcHandler {
    target: "zen.omabond"
    function status(): string {
      return JSON.stringify({ ready: root.ready, paired: root.paired, peerOnline: root.peerOnline,
        peer: root.peerProfile ? root.peerProfile.name : "", queued: root.queued, error: root.errorText })
    }
    function sync(): string { root.sync(); return "ok" }
    function nudge(emoji: string): string { root.sendNudge(emoji); return "ok" }
  }

  onWorkerPathChanged: {
    if (workerPath !== "" && !daemon.running) daemon.running = true
  }

  Component.onCompleted: if (workerPath !== "" && !daemon.running) daemon.running = true
}
