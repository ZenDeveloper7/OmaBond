# Security policy

Please report suspected vulnerabilities through GitHub's private vulnerability reporting feature for the OmaBond repository. Do not include pairing codes, message contents, Tailscale addresses, account names, or other private data in a public issue.

Tailscale is the default and recommended transport. The opt-in `OMABOND_TRANSPORT=lan` mode is intended only for short-lived testing on a trusted local network. LAN mode binds TCP port `42831` to a private RFC1918 address and retains OmaBond's bearer-secret authentication, rate limits, request-size limits, and input validation, but it does not encrypt traffic in transit. Do not use LAN mode on public, shared, or untrusted networks.

Peer HTTP requests reject redirects, so a peer cannot redirect an authenticated request to another origin. Unpairing clears the desktop-keyring secret before clearing local pairing state; a keyring deletion failure is reported and leaves the pairing visibly intact.

Include the affected OmaBond version and commit, the observed behavior, and reproduction steps with sensitive values removed. Tailscale product vulnerabilities should also be reported through Tailscale's security process.

OmaBond is unsandboxed user-level code loaded by Omarchy Shell. Review the repository before installation. The project does not claim that marketplace validation is a security audit or warranty.
