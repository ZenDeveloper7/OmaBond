# OmaBond

OmaBond is a private Omarchy Quattro bar widget for two people. It shares presence, short statuses, nudges, and messages directly between two Omarchy systems through Tailscale—without a hosted relay or central message database. An explicitly enabled local-network mode is available for same-LAN testing.

The plugin ID is `zen.omabond`.

## Features

- Pair two systems with a one-time `omabond:v1` code.
- See online state, last contact, emoji, and a short status.
- Send heartbeats, waves, hugs, sparkles, and coffee nudges.
- Exchange messages up to 500 characters.
- Queue up to 50 outgoing items locally while the other device is offline.
- Keep the most recent 100 conversation items on each device.
- Unpair with confirmation and remove the local conversation and pairing secret.

## Requirements

- Omarchy 4 (Quattro)
- Node.js 20 or newer
- Tailscale connected on both systems
- `libsecret` and a working desktop keyring (`secret-tool`)
- `notify-send` for optional incoming-message notifications

OmaBond does not install, enable, or reconfigure these dependencies.

### Local-network test mode

For testing two systems on the same trusted LAN without Tailscale, start the Omarchy shell with:

```bash
OMABOND_TRANSPORT=lan omarchy restart shell
```

If the system has more than one private IPv4 address, select the one shared with the other system:

```bash
OMABOND_TRANSPORT=lan OMABOND_LAN_IP=192.168.1.50 omarchy restart shell
```

Both systems must use LAN mode and must be able to reach each other on TCP port `42831`. For a VM, use a bridged or host-only adapter rather than plain VirtualBox NAT. LAN mode is deliberately opt-in and does not encrypt message traffic; use it only on a trusted network for testing. Restart the shell normally to return to the default Tailscale mode.

## Install

```bash
omarchy plugin add https://github.com/ZenDeveloper7/OmaBond.git --enable
```

## Connect two systems

The two devices must either belong to the same tailnet or be mutually shared between separate Tailscale accounts. Device sharing must be mutual because a shared device can respond to the recipient but cannot initiate a connection back across tailnets.

1. Install and enable OmaBond on both Omarchy systems.
2. Confirm that both systems appear online in Tailscale.
3. If the systems use separate tailnets, each person shares their OmaBond device with the other person and accepts the incoming share.
4. On the first system, open OmaBond and choose **Create pairing code**.
5. Send the complete code through a trusted private channel. Anyone who obtains this code can authenticate to that OmaBond service until it is replaced or unpaired.
6. On the second system, paste the code and choose **Join this bond**.
7. Keep both systems online briefly. The second system introduces its Tailscale address to the first and the bond completes in both directions.

OmaBond uses TCP port `42831` on each device's Tailscale IPv4 address. A restrictive tailnet policy must permit the paired users or devices to reach that port. OmaBond never binds the peer service to a LAN address and does not modify Tailscale Serve, Funnel, grants, or device-sharing settings.

## Privacy and security model

Tailscale provides authenticated WireGuard transport encryption between the devices. OmaBond adds a randomly generated 256-bit pairing secret stored in the desktop keyring and requires it on every peer request. The peer listener accepts only Tailscale CGNAT addresses from pairing codes, rate-limits requests with bounded bookkeeping, caps request and response bodies, applies short HTTP timeouts, and validates all stored fields.

The local QML client talks to the helper through an owner-only Unix socket under `XDG_RUNTIME_DIR`. The peer service binds only to the local device's Tailscale IPv4 address. Pairing secrets and message text are passed to helper commands through standard input instead of process arguments.

Messages are not additionally encrypted at the application layer; they rely on Tailscale's encrypted tunnel while in transit. Conversation history is stored as plaintext JSON with user-only permissions at:

```text
${XDG_STATE_HOME:-~/.local/state}/omarchy-omabond/state.json
```

There is no hosted relay. An offline message remains only in the sender's local queue and is delivered when both devices are online at the same time. Unpairing clears the keyring secret and local conversation, but it cannot erase history already stored on the other person's system.

## Remove

Use **Unpair** inside OmaBond first if you want to clear the local pairing secret and conversation. Then remove the plugin:

```bash
omarchy plugin remove zen.omabond
```

Plugin removal intentionally leaves the local state directory untouched. This prevents uninstalling code from silently deleting user data. Remove the `omarchy-omabond` state directory manually if it is no longer needed.

## Validate

```bash
node tests/omabond.test.mjs
qmllint -I /usr/share/omarchy/shell Service.qml BarWidget.qml
omarchy plugin validate .
```

## License

MIT
