import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  MAX_MESSAGE_LENGTH,
  PORT,
  cleanText,
  fetchPeer,
  normalizeHost,
  normalizeMessage,
  normalizeProfile,
  normalizeState,
  pairingCode,
  parsePairingCode,
  readStdinJson,
  requireKeyringSuccess,
  secretMatches
} from "../scripts/omabond.mjs";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));

test("uses a dedicated unprivileged port", () => {
  assert.equal(PORT, 42831);
  assert.ok(PORT > 1024);
});

test("accepts only Tailscale CGNAT addresses", () => {
  assert.equal(normalizeHost("100.64.0.1"), "100.64.0.1");
  assert.equal(normalizeHost("100.127.255.254"), "100.127.255.254");
  assert.throws(() => normalizeHost("100.63.0.1"), /invalid Tailscale address/);
  assert.throws(() => normalizeHost("192.168.1.5"), /invalid Tailscale address/);
  assert.throws(() => normalizeHost("example.com"), /invalid Tailscale address/);
});

test("LAN test mode accepts only RFC1918 addresses", () => {
  assert.equal(normalizeHost("10.0.2.15", "lan"), "10.0.2.15");
  assert.equal(normalizeHost("172.16.0.1", "lan"), "172.16.0.1");
  assert.equal(normalizeHost("192.168.1.5", "lan"), "192.168.1.5");
  assert.throws(() => normalizeHost("100.64.0.1", "lan"), /invalid local network address/);
  assert.throws(() => normalizeHost("127.0.0.1", "lan"), /invalid local network address/);
  assert.throws(() => normalizeHost("8.8.8.8", "lan"), /invalid local network address/);
});

test("pairing codes round trip without weakening the secret", () => {
  const token = "A".repeat(43);
  const code = pairingCode({ host: "100.86.194.24", name: "Zen", token });
  assert.ok(code.startsWith("omabond:v1:"));
  assert.deepEqual(parsePairingCode(code), { transport: "tailscale", host: "100.86.194.24", name: "Zen", token });
  assert.throws(() => parsePairingCode("omabond:v1:not-json"), /Invalid OmaBond pairing code/);
});

test("LAN pairing codes retain their transport", () => {
  const token = "B".repeat(43);
  const code = pairingCode({ transport: "lan", host: "192.168.50.12", name: "Thor", token });
  assert.deepEqual(parsePairingCode(code), { transport: "lan", host: "192.168.50.12", name: "Thor", token });
});

test("bearer comparison rejects missing and partial secrets", () => {
  const secret = "z".repeat(43);
  assert.equal(secretMatches(`Bearer ${secret}`, secret), true);
  assert.equal(secretMatches(secret, secret), true);
  assert.equal(secretMatches(`Bearer ${secret.slice(1)}`, secret), false);
  assert.equal(secretMatches("", secret), false);
});

test("peer requests reject redirects before sending follow-up requests", async () => {
  const originalFetch = globalThis.fetch;
  let requestOptions;
  globalThis.fetch = async (_url, options) => {
    requestOptions = options;
    return new Response('{"ok":true}', { status: 200, headers: { "Content-Type": "application/json" } });
  };
  try {
    assert.deepEqual(await fetchPeer("100.64.0.1", "/v1/snapshot", "S".repeat(43)), { ok: true });
    assert.equal(requestOptions.redirect, "error");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("failed keyring mutations are never treated as successful", () => {
  assert.doesNotThrow(() => requireKeyringSuccess({ status: 0 }, "fallback"));
  assert.throws(() => requireKeyringSuccess({ status: 1, stderr: "keyring locked" }, "fallback"), /keyring locked/);
  assert.throws(() => requireKeyringSuccess({ status: null, error: { code: "ENOENT" } }, "fallback"), /secret-tool is required/);
});

test("profiles and messages are bounded and strip control characters", () => {
  const profile = normalizeProfile({ name: " A\u0000lice ", emoji: "💛", status: "x".repeat(200) });
  assert.equal(profile.name, "A lice");
  assert.equal(profile.status.length, 80);

  const message = normalizeMessage({
    id: "12345678-1234-1234-1234-123456789abc",
    type: "message",
    text: `hello\n${"x".repeat(MAX_MESSAGE_LENGTH)}`,
    direction: "out"
  });
  assert.equal(message.text.length, MAX_MESSAGE_LENGTH);
  assert.equal(message.direction, "out");
  assert.equal(normalizeMessage({ id: "unsafe", text: "hi" }), null);
  assert.equal(cleanText(" a\tb ", 20), "a b");
});

test("state normalization rejects unsafe peers and caps history", () => {
  const messages = Array.from({ length: 120 }, (_, index) => ({
    id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    text: `message ${index}`
  }));
  const state = normalizeState({ peer: { host: "127.0.0.1", name: "unsafe" }, messages });
  assert.equal(state.peer, null);
  assert.equal(state.messages.length, 100);
  assert.equal(state.messages[0].text, "message 20");
});

test("client input is parsed from stdin instead of command arguments", async () => {
  const input = Readable.from(['{"text":"private hello"}\n']);
  assert.deepEqual(await readStdinJson(input), { text: "private hello" });
  await assert.rejects(readStdinJson(Readable.from(["not-json\n"])), /input must be JSON/);
});

test("peer-controlled QML Text values are always rendered as plain text", () => {
  const source = fs.readFileSync(path.join(TEST_DIR, "..", "BarWidget.qml"), "utf8");
  const dynamicTextBlocks = [
    /text: root\.bondService && root\.bondService\.paired \? root\.peerEmoji\(\)[\s\S]{0,160}textFormat: Text\.PlainText/,
    /text: root\.bondService && root\.bondService\.paired \? root\.peerName\(\)[\s\S]{0,160}textFormat: Text\.PlainText/,
    /text: !root\.bondService \? "Starting…"[\s\S]{0,700}textFormat: Text\.PlainText/,
    /text: root\.bondService \? root\.bondService\.errorText[\s\S]{0,160}textFormat: Text\.PlainText/,
    /text: root\.peerEmoji\(\) \+ "  "[\s\S]{0,320}textFormat: Text\.PlainText/,
    /text: \(modelData\.direction === "out"[\s\S]{0,360}textFormat: Text\.PlainText/,
    /text: modelData\.text[\s\S]{0,120}textFormat: Text\.PlainText/
  ];
  for (const pattern of dynamicTextBlocks) assert.match(source, pattern);
});
