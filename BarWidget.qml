// OmaBond: private two-person presence, nudges, and chat over a selected transport.
import QtQuick
import QtQuick.Controls as QQC
import Quickshell
import qs.Commons
import qs.Ui

BarWidget {
  id: root
  moduleName: "zen.omabond"

  readonly property var bondService: bar && bar.shell ? bar.shell.serviceFor(moduleName) : null
  readonly property bool opened: popupOpen
  property bool popupOpen: false
  property bool unpairConfirmOpen: false

  function open() { popupOpen = true }
  function close() { popupOpen = false; unpairConfirmOpen = false }
  function closeForPopoutSwitch() { close() }
  function toggle() { popupOpen ? close() : open() }
  function peerName() {
    if (!bondService) return "Your person"
    if (bondService.peerProfile && bondService.peerProfile.name) return bondService.peerProfile.name
    if (bondService.peer && bondService.peer.name) return bondService.peer.name
    return "Your person"
  }
  function peerEmoji() {
    return bondService && bondService.peerProfile && bondService.peerProfile.emoji
      ? bondService.peerProfile.emoji : "💛"
  }
  function formatTime(value) {
    var date = new Date(String(value || ""))
    if (isNaN(date.getTime())) return ""
    return Qt.formatDateTime(date, "ddd HH:mm")
  }
  function syncProfileFields() {
    if (!bondService || !bondService.selfProfile) return
    nameField.text = String(bondService.selfProfile.name || "")
    emojiField.text = String(bondService.selfProfile.emoji || "💛")
    statusField.text = String(bondService.selfProfile.status || "")
  }

  implicitWidth: widgetButton.implicitWidth
  implicitHeight: widgetButton.implicitHeight
  onBondServiceChanged: syncProfileFields()

  WidgetButton {
    id: widgetButton
    anchors.fill: parent
    bar: root.bar
    text: root.bondService && root.bondService.paired ? root.peerEmoji() : "󰌷"
    foreground: root.bondService && root.bondService.peerOnline ? Color.accent
      : (root.bar ? root.bar.barForeground : Color.foreground)
    active: root.bondService ? root.bondService.peerOnline : false
    tooltipText: root.bondService && root.bondService.paired
      ? root.peerName() + (root.bondService.peerOnline ? " · online" : " · offline")
      : "OmaBond · Pair your person"
    onPressed: root.toggle()
  }

  KeyboardPanel {
    id: popup
    anchorItem: widgetButton
    bar: root.bar
    owner: root
    open: root.popupOpen
    centerOnBar: true
    focusTarget: root.bondService && root.bondService.paired ? messageField : pairCodeField
    contentWidth: popup.fittedContentWidth(Style.space(500))
    contentHeight: popup.cappedContentHeight(Style.space(680))
    onOpenChanged: if (open) { root.syncProfileFields(); if (root.bondService) root.bondService.sync() }

    Item {
      anchors.fill: parent

      Column {
        id: header
        anchors.left: parent.left
        anchors.right: parent.right
        anchors.top: parent.top
        spacing: Style.space(4)

        Row {
          width: parent.width
          spacing: Style.space(8)

          Text {
            text: root.bondService && root.bondService.paired ? root.peerEmoji() : "💛"
            textFormat: Text.PlainText
            color: root.bar ? root.bar.foreground : Color.foreground
            font.pixelSize: Style.font.title
          }

          Column {
            width: parent.width - syncButton.width - parent.spacing * 2 - Style.space(32)

            Text {
              text: root.bondService && root.bondService.paired ? root.peerName() : "OmaBond"
              textFormat: Text.PlainText
              color: root.bar ? root.bar.foreground : Color.foreground
              font.family: Style.font.family
              font.pixelSize: Style.font.subtitle
              font.bold: true
            }

            Text {
              width: parent.width
              text: !root.bondService ? "Starting…"
                : root.bondService.networkError ? root.bondService.networkError
                : root.bondService.paired
                  ? (root.bondService.peerOnline ? (root.bondService.transportMode === "lan" ? "Online on local network" : "Online through Tailscale")
                    : "Offline" + (root.bondService.peerLastSeen ? " · last seen " + root.formatTime(root.bondService.peerLastSeen) : ""))
                  : (root.bondService.network
                    ? (root.bondService.transportMode === "lan" ? "Local test mode · " : "Tailscale ready · ") + root.bondService.network.ip
                    : "Checking network…")
              textFormat: Text.PlainText
              color: root.bondService && root.bondService.peerOnline ? Color.accent
                : Qt.darker(root.bar ? root.bar.foreground : Color.foreground, 1.35)
              font.family: Style.font.family
              font.pixelSize: Style.font.caption
              elide: Text.ElideRight
            }
          }

          Button {
            id: syncButton
            iconText: "󰑓"
            tooltipText: "Sync now"
            foreground: root.bar ? root.bar.foreground : Color.foreground
            enabled: root.bondService && !root.bondService.busy
            opacity: enabled ? 1 : 0.45
            onClicked: root.bondService.sync()
          }
        }

        Text {
          width: parent.width
          visible: root.bondService && root.bondService.errorText !== ""
          text: root.bondService ? root.bondService.errorText : ""
          textFormat: Text.PlainText
          color: Color.urgent
          font.family: Style.font.family
          font.pixelSize: Style.font.bodySmall
          wrapMode: Text.Wrap
        }
      }

      QQC.ScrollView {
        id: scrollView
        anchors.top: header.bottom
        anchors.topMargin: Style.space(10)
        anchors.left: parent.left
        anchors.right: parent.right
        anchors.bottom: parent.bottom
        clip: true

        Column {
          width: scrollView.availableWidth
          spacing: Style.space(12)

          Column {
            width: parent.width
            spacing: Style.space(8)

            Text {
              text: "YOUR PROFILE"
              color: Qt.darker(root.bar ? root.bar.foreground : Color.foreground, 1.25)
              font.family: Style.font.family
              font.pixelSize: Style.font.caption
              font.bold: true
            }

            Row {
              width: parent.width
              spacing: Style.space(6)

              TextField {
                id: emojiField
                width: Style.space(54)
                placeholderText: "💛"
                foreground: root.bar ? root.bar.foreground : Color.foreground
              }

              TextField {
                id: nameField
                width: parent.width - emojiField.width - parent.spacing
                placeholderText: "Your name"
                foreground: root.bar ? root.bar.foreground : Color.foreground
              }
            }

            TextField {
              id: statusField
              width: parent.width
              placeholderText: "What are you up to?"
              foreground: root.bar ? root.bar.foreground : Color.foreground
              onAccepted: saveProfileButton.clicked()
            }

            Button {
              id: saveProfileButton
              text: "Update my status"
              foreground: root.bar ? root.bar.foreground : Color.foreground
              bordered: true
              enabled: root.bondService && !root.bondService.busy && nameField.text.trim().length > 0
              opacity: enabled ? 1 : 0.45
              onClicked: root.bondService.saveProfile(nameField.text, emojiField.text, statusField.text)
            }
          }

          Column {
            width: parent.width
            spacing: Style.space(9)
            visible: root.bondService && !root.bondService.paired

            Text {
              text: "PAIR TWO OMARCHY SYSTEMS"
              color: Qt.darker(root.bar ? root.bar.foreground : Color.foreground, 1.25)
              font.family: Style.font.family
              font.pixelSize: Style.font.caption
              font.bold: true
            }

            Text {
              width: parent.width
              text: root.bondService && root.bondService.transportMode === "lan"
                ? "Local test mode is unencrypted. Use it only on a trusted LAN, then switch back to Tailscale."
                : "Both devices must be on the same tailnet, or mutually shared in Tailscale. Send the pairing code through a trusted private channel."
              color: root.bar ? root.bar.foreground : Color.foreground
              font.family: Style.font.family
              font.pixelSize: Style.font.bodySmall
              wrapMode: Text.Wrap
            }

            Row {
              spacing: Style.space(6)

              Button {
                text: root.bondService && root.bondService.pairingCode ? "Replace pairing code" : "Create pairing code"
                foreground: root.bar ? root.bar.foreground : Color.foreground
                bordered: true
                enabled: root.bondService && root.bondService.network && !root.bondService.busy
                opacity: enabled ? 1 : 0.45
                onClicked: root.bondService.createPairingCode()
              }

              Button {
                visible: root.bondService && root.bondService.pairingCode === ""
                text: "Show existing code"
                foreground: root.bar ? root.bar.foreground : Color.foreground
                enabled: root.bondService && root.bondService.network && !root.bondService.busy
                onClicked: root.bondService.showPairingCode()
              }
            }

            QQC.TextArea {
              width: parent.width
              visible: root.bondService && root.bondService.pairingCode !== ""
              text: root.bondService ? root.bondService.pairingCode : ""
              readOnly: true
              selectByMouse: true
              wrapMode: Text.WrapAnywhere
              color: root.bar ? root.bar.foreground : Color.foreground
              background: Rectangle { color: Util.alpha(root.bar ? root.bar.foreground : Color.foreground, 0.06) }
            }

            TextField {
              id: pairCodeField
              width: parent.width
              placeholderText: "Paste their omabond:v1 pairing code"
              foreground: root.bar ? root.bar.foreground : Color.foreground
              password: true
              onAccepted: joinButton.clicked()
            }

            Button {
              id: joinButton
              text: "Join this bond"
              foreground: root.bar ? root.bar.foreground : Color.foreground
              bordered: true
              enabled: root.bondService && !root.bondService.busy && pairCodeField.text.trim().length > 20
              opacity: enabled ? 1 : 0.45
              onClicked: {
                root.bondService.joinPair(pairCodeField.text)
                pairCodeField.text = ""
              }
            }
          }

          Column {
            width: parent.width
            spacing: Style.space(10)
            visible: root.bondService && root.bondService.paired

            BorderSurface {
              width: parent.width
              height: peerStatus.implicitHeight + Style.space(20)
              color: "transparent"
              radius: Style.cornerRadius
              borderSpec: Border.controlSpec("normal", root.bar ? root.bar.foreground : Color.foreground, Color.accent)

              Text {
                id: peerStatus
                anchors.fill: parent
                anchors.margins: Style.space(10)
                text: root.peerEmoji() + "  " + (root.bondService && root.bondService.peerProfile && root.bondService.peerProfile.status
                  ? root.bondService.peerProfile.status : root.peerName() + " has not set a status yet")
                textFormat: Text.PlainText
                color: root.bar ? root.bar.foreground : Color.foreground
                font.family: Style.font.family
                font.pixelSize: Style.font.body
                wrapMode: Text.Wrap
              }
            }

            Text {
              text: "SEND A NUDGE"
              color: Qt.darker(root.bar ? root.bar.foreground : Color.foreground, 1.25)
              font.family: Style.font.family
              font.pixelSize: Style.font.caption
              font.bold: true
            }

            Row {
              spacing: Style.space(8)
              Repeater {
                model: ["💛", "👋", "🤗", "✨", "☕"]
                Button {
                  required property string modelData
                  text: modelData
                  foreground: root.bar ? root.bar.foreground : Color.foreground
                  bordered: true
                  enabled: root.bondService && !root.bondService.busy
                  onClicked: root.bondService.sendNudge(modelData)
                }
              }
            }

            Text {
              text: "MESSAGES" + (root.bondService && root.bondService.queued > 0 ? " · " + root.bondService.queued + " queued" : "")
              color: Qt.darker(root.bar ? root.bar.foreground : Color.foreground, 1.25)
              font.family: Style.font.family
              font.pixelSize: Style.font.caption
              font.bold: true
            }

            Repeater {
              model: root.bondService ? root.bondService.messages.slice(-20) : []

              Rectangle {
                required property var modelData
                width: parent.width
                height: messageColumn.implicitHeight + Style.space(14)
                radius: Style.cornerRadius
                color: modelData.direction === "out" ? Util.alpha(Color.accent, 0.14)
                  : Util.alpha(root.bar ? root.bar.foreground : Color.foreground, 0.07)

                Column {
                  id: messageColumn
                  anchors.left: parent.left
                  anchors.right: parent.right
                  anchors.verticalCenter: parent.verticalCenter
                  anchors.margins: Style.space(7)

                  Text {
                    width: parent.width
                    text: (modelData.direction === "out" ? "You" : (modelData.sender || root.peerName()))
                      + " · " + root.formatTime(modelData.sentAt)
                      + (modelData.direction === "out" && !modelData.delivered ? " · queued" : "")
                    textFormat: Text.PlainText
                    color: Qt.darker(root.bar ? root.bar.foreground : Color.foreground, 1.35)
                    font.family: Style.font.family
                    font.pixelSize: Style.font.caption
                  }

                  Text {
                    width: parent.width
                    text: modelData.text
                    textFormat: Text.PlainText
                    color: root.bar ? root.bar.foreground : Color.foreground
                    font.family: Style.font.family
                    font.pixelSize: modelData.type === "nudge" ? Style.font.title : Style.font.bodySmall
                    wrapMode: Text.Wrap
                  }
                }
              }
            }

            Row {
              width: parent.width
              spacing: Style.space(6)

              TextField {
                id: messageField
                width: parent.width - sendButton.width - parent.spacing
                placeholderText: root.bondService && root.bondService.peerOnline ? "Write a message…" : "Write now; it will send when online"
                foreground: root.bar ? root.bar.foreground : Color.foreground
                onAccepted: sendButton.clicked()
              }

              Button {
                id: sendButton
                text: "Send"
                foreground: root.bar ? root.bar.foreground : Color.foreground
                bordered: true
                enabled: root.bondService && !root.bondService.busy && messageField.text.trim().length > 0
                opacity: enabled ? 1 : 0.45
                onClicked: {
                  root.bondService.sendMessage(messageField.text)
                  messageField.text = ""
                }
              }
            }

            Button {
              text: "Unpair"
              foreground: Color.urgent
              enabled: root.bondService && !root.bondService.busy
              onClicked: root.unpairConfirmOpen = true
            }
          }
        }
      }

      ConfirmDialog {
        anchors.fill: parent
        opened: root.unpairConfirmOpen
        z: 10
        message: "Unpair " + root.peerName() + " and delete the local conversation? This cannot be undone."
        confirmText: "Unpair"
        background: root.bar ? root.bar.background : Color.background
        foreground: root.bar ? root.bar.foreground : Color.foreground
        onCanceled: root.unpairConfirmOpen = false
        onConfirmed: {
          root.unpairConfirmOpen = false
          if (root.bondService) root.bondService.unpair()
        }
      }
    }
  }
}
