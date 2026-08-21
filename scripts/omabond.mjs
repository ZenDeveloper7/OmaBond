#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const APP_ID = "zen.omabond";
const PORT = 42831;
const TRANSPORT_MODE = process.env.OMABOND_TRANSPORT === "lan" ? "lan" : "tailscale";
const LAN_IP_OVERRIDE = String(process.env.OMABOND_LAN_IP || "").trim();
const MAX_BODY_BYTES = 16 * 1024;
const MAX_MESSAGES = 100;
const MAX_OUTBOX = 50;
const MAX_MESSAGE_LENGTH = 500;
const MAX_STATUS_LENGTH = 80;
const SYNC_INTERVAL_MS = 5000;
const STATE_HOME = process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state");
const RUNTIME_HOME = process.env.XDG_RUNTIME_DIR || path.join(STATE_HOME, "runtime");
const STATE_DIR = process.env.OMABOND_STATE_DIR || path.join(STATE_HOME, "omarchy-omabond");
const STATE_FILE = path.join(STATE_DIR, "state.json");
const SOCKET_PATH = process.env.OMABOND_SOCKET_PATH || path.join(RUNTIME_HOME, "omabond.sock");
const KEYRING_ATTRIBUTES = ["service", APP_ID, "credential", "pair-secret"];

function nowIso() { return new Date().toISOString(); }

function cleanText(value, limit) {
  return String(value || "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, limit);
}

function normalizeHost(value, mode = TRANSPORT_MODE) {
  const host = String(value || "").trim().replace(/\.$/, "").toLowerCase();
  const parts = /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) ? host.split(".").map(Number) : [];
  const valid = parts.length === 4 && parts.every(part => part >= 0 && part <= 255);
  if (mode === "tailscale" && valid && parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) return host;
  if (mode === "lan" && valid && (
    parts[0] === 10
    || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
    || (parts[0] === 192 && parts[1] === 168)
  )) return host;
  throw new Error(`Pairing code contains an invalid ${mode === "lan" ? "local network" : "Tailscale"} address`);
}

function normalizeProfile(raw = {}) {
  return {
    name: cleanText(raw.name || os.userInfo().username || "OmaBond friend", 40),
    emoji: cleanText(raw.emoji || "💛", 8) || "💛",
    status: cleanText(raw.status, MAX_STATUS_LENGTH),
    updatedAt: String(raw.updatedAt || nowIso())
  };
}

function normalizeMessage(raw) {
  if (!raw || typeof raw !== "object") return null;
  const id = String(raw.id || "");
  const type = raw.type === "nudge" ? "nudge" : "message";
  const text = cleanText(raw.text, type === "nudge" ? 8 : MAX_MESSAGE_LENGTH);
  if (!/^[a-f0-9-]{36}$/.test(id) || !text) return null;
  return {
    id,
    type,
    text,
    direction: raw.direction === "out" ? "out" : "in",
    sender: cleanText(raw.sender, 40),
    sentAt: String(raw.sentAt || nowIso()),
    delivered: raw.delivered === true
  };
}

function defaultState() {
  return {
    schemaVersion: 1,
    profile: normalizeProfile(),
    peer: null,
    peerOnline: false,
    peerProfile: null,
    peerLastSeen: "",
    messages: [],
    outbox: []
  };
}

function normalizeState(raw) {
  const base = defaultState();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return base;
  let peer = null;
  if (raw.peer && typeof raw.peer === "object") {
    try {
      const transport = raw.peer.transport === "lan" ? "lan" : "tailscale";
      if (transport !== TRANSPORT_MODE) throw new Error("Stored peer uses a different transport");
      peer = {
        host: normalizeHost(raw.peer.host, transport),
        transport,
        name: cleanText(raw.peer.name, 40),
        pairedAt: String(raw.peer.pairedAt || nowIso())
      };
    } catch (_) {}
  }
  return {
    schemaVersion: 1,
    profile: normalizeProfile(raw.profile),
    peer,
    peerOnline: raw.peerOnline === true,
    peerProfile: raw.peerProfile ? normalizeProfile(raw.peerProfile) : null,
    peerLastSeen: String(raw.peerLastSeen || ""),
    messages: (Array.isArray(raw.messages) ? raw.messages : []).map(normalizeMessage).filter(Boolean).slice(-MAX_MESSAGES),
    outbox: (Array.isArray(raw.outbox) ? raw.outbox : []).map(normalizeMessage).filter(Boolean).slice(-MAX_OUTBOX)
  };
}

function loadState() {
  try { return normalizeState(JSON.parse(fs.readFileSync(STATE_FILE, "utf8"))); }
  catch (_) { return defaultState(); }
}

function saveState(state) {
  fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  const temporary = `${STATE_FILE}.${process.pid}`;
  fs.writeFileSync(temporary, `${JSON.stringify(normalizeState(state), null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(temporary, 0o600);
  fs.renameSync(temporary, STATE_FILE);
}

function keyring(args, input = undefined) {
  return spawnSync("secret-tool", args, { input, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], timeout: 5000 });
}

function requireKeyringSuccess(result, fallbackMessage) {
  if (result.error?.code === "ENOENT") throw new Error("secret-tool is required but is not installed");
  if (result.status !== 0) throw new Error(cleanText(result.stderr || fallbackMessage, 300));
}

function getPairSecret() {
  const result = keyring(["lookup", ...KEYRING_ATTRIBUTES]);
  if (result.error?.code === "ENOENT") throw new Error("secret-tool is required but is not installed");
  return result.status === 0 ? String(result.stdout || "").trim() : "";
}

function storePairSecret(secret) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(secret)) throw new Error("Invalid pairing secret");
  const result = keyring(["store", "--label=OmaBond pairing secret", ...KEYRING_ATTRIBUTES], `${secret}\n`);
  requireKeyringSuccess(result, "Could not store the pairing secret");
}

function clearPairSecret() {
  const result = keyring(["clear", ...KEYRING_ATTRIBUTES]);
  requireKeyringSuccess(result, "Could not remove the pairing secret from the keyring");
}

function tailscaleInfo() {
  const result = spawnSync("tailscale", ["status", "--json"], { encoding: "utf8", timeout: 5000 });
  if (result.error?.code === "ENOENT") throw new Error("Tailscale is required but is not installed");
  if (result.status !== 0) throw new Error("Tailscale is not connected");
  let payload;
  try { payload = JSON.parse(result.stdout); }
  catch (_) { throw new Error("Could not read Tailscale status"); }
  const addresses = Array.isArray(payload?.Self?.TailscaleIPs) ? payload.Self.TailscaleIPs : [];
  const ipv4 = addresses.find(value => /^100\./.test(String(value || "")));
  if (payload.BackendState !== "Running" || !ipv4) throw new Error("Tailscale is not connected");
  return {
    online: payload?.Self?.Online !== false,
    ip: normalizeHost(ipv4),
    dnsName: String(payload?.Self?.DNSName || "").replace(/\.$/, ""),
    peerCount: payload.Peer && typeof payload.Peer === "object" ? Object.keys(payload.Peer).length : 0
  };
}

function lanInfo() {
  const candidates = [];
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry.family !== "IPv4" || entry.internal) continue;
      try { candidates.push(normalizeHost(entry.address, "lan")); }
      catch (_) {}
    }
  }
  const unique = [...new Set(candidates)];
  if (LAN_IP_OVERRIDE) {
    const ip = normalizeHost(LAN_IP_OVERRIDE, "lan");
    if (!unique.includes(ip)) throw new Error(`OMABOND_LAN_IP ${ip} is not assigned to this device`);
    return { online: true, ip, dnsName: os.hostname(), peerCount: 0, mode: "lan" };
  }
  if (unique.length === 0) throw new Error("No private local network IPv4 address is available");
  if (unique.length > 1) throw new Error(`Multiple local addresses found; set OMABOND_LAN_IP to one of: ${unique.join(", ")}`);
  return { online: true, ip: unique[0], dnsName: os.hostname(), peerCount: 0, mode: "lan" };
}

function transportInfo() {
  return TRANSPORT_MODE === "lan" ? lanInfo() : { ...tailscaleInfo(), mode: "tailscale" };
}

function pairingCode(payload) {
  const transport = payload.transport === "lan" ? "lan" : "tailscale";
  const json = JSON.stringify({ v: 1, transport, host: normalizeHost(payload.host, transport), name: cleanText(payload.name, 40), token: payload.token });
  return `omabond:v1:${Buffer.from(json).toString("base64url")}`;
}

function parsePairingCode(value) {
  const input = String(value || "").trim();
  if (!input.startsWith("omabond:v1:") || input.length > 1024) throw new Error("Invalid OmaBond pairing code");
  let payload;
  try { payload = JSON.parse(Buffer.from(input.slice(11), "base64url").toString("utf8")); }
  catch (_) { throw new Error("Invalid OmaBond pairing code"); }
  if (payload?.v !== 1 || !/^[A-Za-z0-9_-]{43}$/.test(String(payload?.token || ""))) throw new Error("Invalid OmaBond pairing code");
  const transport = payload.transport === "lan" ? "lan" : "tailscale";
  return { transport, host: normalizeHost(payload.host, transport), name: cleanText(payload.name, 40), token: String(payload.token) };
}

function secretMatches(header, secret) {
  const supplied = String(header || "").replace(/^Bearer\s+/i, "");
  const left = Buffer.from(supplied);
  const right = Buffer.from(String(secret || ""));
  return left.length === right.length && left.length > 0 && crypto.timingSafeEqual(left, right);
}

async function readJsonBody(request) {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > MAX_BODY_BYTES) throw new Error("Request is too large");
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch (_) { throw new Error("Request body must be JSON"); }
}

function sendJson(response, status, payload) {
  const body = `${JSON.stringify(payload)}\n`;
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });
  response.end(body);
}

async function fetchPeer(host, route, secret, options = {}) {
  const response = await fetch(`http://${normalizeHost(host, TRANSPORT_MODE)}:${PORT}${route}`, {
    method: options.method || "GET",
    redirect: "error",
    headers: {
      Authorization: `Bearer ${secret}`,
      Accept: "application/json",
      ...(options.body ? { "Content-Type": "application/json" } : {})
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
    signal: AbortSignal.timeout(4000)
  });
  let payload;
  try { payload = await response.json(); }
  catch (_) { throw new Error(`Peer returned an unreadable response (${response.status})`); }
  if (!response.ok || payload.ok !== true) throw new Error(cleanText(payload.error || `Peer request failed (${response.status})`, 300));
  return payload;
}

function publicState(state, daemon) {
  return {
    serviceReady: true,
    transportMode: TRANSPORT_MODE,
    network: daemon.networkInfo || null,
    networkError: daemon.networkError || "",
    paired: Boolean(state.peer && daemon.secret),
    self: state.profile,
    peer: state.peer,
    peerOnline: state.peerOnline,
    peerProfile: state.peerProfile,
    peerLastSeen: state.peerLastSeen,
    messages: state.messages.slice(-MAX_MESSAGES),
    queued: state.outbox.length,
    listenPort: PORT
  };
}

function notify(title, body) {
  spawnSync("notify-send", ["--app-name=OmaBond", "--icon=dialog-information", cleanText(title, 80), cleanText(body, 300)], {
    encoding: "utf8",
    timeout: 3000
  });
}

class OmaBondDaemon {
  constructor() {
    this.state = loadState();
    this.secret = "";
    this.networkInfo = null;
    this.networkError = "";
    this.localServer = null;
    this.peerServer = null;
    this.listenAddress = "";
    this.syncing = false;
    this.rate = new Map();
  }

  refreshSecret() {
    this.secret = getPairSecret();
  }

  persist() { saveState(this.state); }

  rateAllowed(address) {
    const key = String(address || "unknown");
    const now = Date.now();
    const entry = this.rate.get(key) || { started: now, count: 0 };
    if (now - entry.started >= 60000) { entry.started = now; entry.count = 0; }
    entry.count++;
    this.rate.set(key, entry);
    return entry.count <= 120;
  }

  async localCommand(operation, input) {
    switch (operation) {
      case "status":
        return publicState(this.state, this);
      case "pair-code": {
        if (!this.networkInfo) throw new Error(this.networkError || "Transport is not ready");
        let secret = this.secret;
        if (!secret) {
          secret = crypto.randomBytes(32).toString("base64url");
          storePairSecret(secret);
          this.secret = secret;
        }
        return { ...publicState(this.state, this), pairingCode: pairingCode({ transport: TRANSPORT_MODE, host: this.networkInfo.ip, name: this.state.profile.name, token: secret }) };
      }
      case "pair-create": {
        if (!this.networkInfo) throw new Error(this.networkError || "Transport is not ready");
        const secret = crypto.randomBytes(32).toString("base64url");
        storePairSecret(secret);
        this.secret = secret;
        this.state.peer = null;
        this.state.peerOnline = false;
        this.state.peerProfile = null;
        this.state.peerLastSeen = "";
        this.state.messages = [];
        this.state.outbox = [];
        this.persist();
        return { ...publicState(this.state, this), pairingCode: pairingCode({ transport: TRANSPORT_MODE, host: this.networkInfo.ip, name: this.state.profile.name, token: secret }) };
      }
      case "pair-import": {
        const parsed = parsePairingCode(input.code);
        if (parsed.transport !== TRANSPORT_MODE) throw new Error(`That pairing code uses ${parsed.transport}; this device uses ${TRANSPORT_MODE}`);
        if (this.networkInfo && parsed.host === this.networkInfo.ip) throw new Error("That pairing code belongs to this device");
        storePairSecret(parsed.token);
        this.secret = parsed.token;
        this.state.peer = { host: parsed.host, transport: parsed.transport, name: parsed.name, pairedAt: nowIso() };
        this.state.peerOnline = false;
        this.state.peerProfile = null;
        this.state.peerLastSeen = "";
        this.state.messages = [];
        this.state.outbox = [];
        this.persist();
        void this.syncPeer();
        return publicState(this.state, this);
      }
      case "profile":
        this.state.profile = normalizeProfile({ ...this.state.profile, name: input.name, emoji: input.emoji, status: input.status, updatedAt: nowIso() });
        this.persist();
        void this.syncPeer();
        return publicState(this.state, this);
      case "message":
      case "nudge": {
        if (!this.state.peer || !this.secret) throw new Error("Pair with someone first");
        const type = operation === "nudge" ? "nudge" : "message";
        const text = cleanText(input.text, type === "nudge" ? 8 : MAX_MESSAGE_LENGTH);
        if (!text) throw new Error(type === "nudge" ? "Choose a nudge" : "Write a message first");
        if (this.state.outbox.length >= MAX_OUTBOX) throw new Error("The offline queue is full; wait for your person to come online");
        const event = normalizeMessage({ id: crypto.randomUUID(), type, text, direction: "out", sender: this.state.profile.name, sentAt: nowIso(), delivered: false });
        this.state.messages.push(event);
        this.state.messages = this.state.messages.slice(-MAX_MESSAGES);
        this.state.outbox.push(event);
        this.persist();
        void this.syncPeer();
        return publicState(this.state, this);
      }
      case "sync":
        await this.syncPeer();
        return publicState(this.state, this);
      case "unpair":
        clearPairSecret();
        this.secret = "";
        this.state = { ...defaultState(), profile: this.state.profile };
        this.persist();
        return publicState(this.state, this);
      default:
        throw new Error(`Unknown operation: ${operation}`);
    }
  }

  async handleLocal(request, response) {
    if (request.method !== "POST" || request.url !== "/command") return sendJson(response, 404, { ok: false, error: "Not found" });
    try {
      const body = await readJsonBody(request);
      const result = await this.localCommand(String(body.operation || ""), body.input || {});
      sendJson(response, 200, { ok: true, ...result });
    } catch (error) {
      sendJson(response, 400, { ok: false, error: cleanText(error.message || error, 300) });
    }
  }

  async handleRemote(request, response) {
    if (!this.rateAllowed(request.socket.remoteAddress)) return sendJson(response, 429, { ok: false, error: "Too many requests" });
    if (!this.secret || !secretMatches(request.headers.authorization, this.secret)) return sendJson(response, 401, { ok: false, error: "Pairing authentication failed" });
    try {
      if (request.method === "GET" && request.url === "/v1/snapshot") {
        return sendJson(response, 200, { ok: true, profile: this.state.profile, endpoint: this.networkInfo?.ip || "", seenAt: nowIso() });
      }
      if (request.method === "POST" && request.url === "/v1/hello") {
        const body = await readJsonBody(request);
        const host = normalizeHost(body.host, TRANSPORT_MODE);
        if (this.networkInfo && host === this.networkInfo.ip) throw new Error("Peer endpoint cannot be this device");
        if (this.state.peer && this.state.peer.host !== host) return sendJson(response, 409, { ok: false, error: "This device is already paired" });
        this.state.peer = { host, transport: TRANSPORT_MODE, name: cleanText(body.name, 40), pairedAt: this.state.peer?.pairedAt || nowIso() };
        this.state.peerProfile = normalizeProfile(body.profile || { name: body.name });
        this.state.peerOnline = true;
        this.state.peerLastSeen = nowIso();
        this.persist();
        return sendJson(response, 200, { ok: true });
      }
      if (request.method === "POST" && request.url === "/v1/event") {
        const body = await readJsonBody(request);
        const event = normalizeMessage({ ...body, direction: "in", delivered: true });
        if (!event) throw new Error("Invalid event");
        if (!this.state.messages.some(item => item.id === event.id)) {
          this.state.messages.push(event);
          this.state.messages = this.state.messages.slice(-MAX_MESSAGES);
          this.state.peerOnline = true;
          this.state.peerLastSeen = nowIso();
          this.persist();
          notify(event.type === "nudge" ? `${event.sender || "Your person"} sent a nudge` : event.sender || "OmaBond", event.text);
        }
        return sendJson(response, 200, { ok: true });
      }
      sendJson(response, 404, { ok: false, error: "Not found" });
    } catch (error) {
      sendJson(response, 400, { ok: false, error: cleanText(error.message || error, 300) });
    }
  }

  async syncPeer() {
    if (this.syncing || !this.state.peer || !this.secret || !this.networkInfo) return;
    this.syncing = true;
    try {
      await fetchPeer(this.state.peer.host, "/v1/hello", this.secret, {
        method: "POST",
        body: { host: this.networkInfo.ip, name: this.state.profile.name, profile: this.state.profile }
      });
      const snapshot = await fetchPeer(this.state.peer.host, "/v1/snapshot", this.secret);
      this.state.peerProfile = normalizeProfile(snapshot.profile);
      this.state.peerOnline = true;
      this.state.peerLastSeen = String(snapshot.seenAt || nowIso());
      const remaining = [];
      for (const event of this.state.outbox) {
        try {
          await fetchPeer(this.state.peer.host, "/v1/event", this.secret, { method: "POST", body: event });
          const stored = this.state.messages.find(item => item.id === event.id);
          if (stored) stored.delivered = true;
        } catch (_) { remaining.push(event); }
      }
      this.state.outbox = remaining;
      this.persist();
    } catch (_) {
      this.state.peerOnline = false;
      this.persist();
    } finally {
      this.syncing = false;
    }
  }

  refreshTransport() {
    try {
      const info = transportInfo();
      this.networkInfo = info;
      this.networkError = "";
      if (this.listenAddress !== info.ip) this.startPeerServer(info.ip);
    } catch (error) {
      this.networkInfo = null;
      this.networkError = cleanText(error.message || error, 300);
      if (this.peerServer) { this.peerServer.close(); this.peerServer = null; this.listenAddress = ""; }
    }
  }

  startPeerServer(address) {
    if (this.peerServer) this.peerServer.close();
    const server = http.createServer((request, response) => void this.handleRemote(request, response));
    server.on("error", error => { this.networkError = `Could not listen on ${TRANSPORT_MODE}: ${cleanText(error.message, 180)}`; });
    server.listen(PORT, address, () => { this.peerServer = server; this.listenAddress = address; });
  }

  async start() {
    this.refreshSecret();
    fs.mkdirSync(path.dirname(SOCKET_PATH), { recursive: true, mode: 0o700 });
    try {
      const details = fs.lstatSync(SOCKET_PATH);
      if (details.isSocket()) fs.unlinkSync(SOCKET_PATH);
      else throw new Error("OmaBond runtime path exists and is not a socket");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    this.localServer = http.createServer((request, response) => void this.handleLocal(request, response));
    await new Promise((resolve, reject) => {
      this.localServer.once("error", reject);
      this.localServer.listen(SOCKET_PATH, resolve);
    });
    fs.chmodSync(SOCKET_PATH, 0o600);
    this.refreshTransport();
    setInterval(() => { this.refreshTransport(); void this.syncPeer(); }, SYNC_INTERVAL_MS).unref();
    process.stdout.write(`${JSON.stringify({ ok: true, operation: "daemon", socket: SOCKET_PATH, port: PORT })}\n`);
  }
}

async function readStdinJson(input = process.stdin) {
  const reader = readline.createInterface({ input, crlfDelay: Infinity });
  for await (const line of reader) {
    const text = String(line || "").trim();
    if (!text) return {};
    try { return JSON.parse(text); }
    catch (_) { throw new Error("OmaBond input must be JSON"); }
  }
  return {};
}

async function localRequest(operation, input = {}) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ operation, input });
    const request = http.request({ socketPath: SOCKET_PATH, path: "/command", method: "POST", headers: {
      "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body)
    } }, response => {
      const chunks = [];
      response.on("data", chunk => chunks.push(chunk));
      response.on("end", () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
        catch (_) { reject(new Error("OmaBond service returned an unreadable response")); }
      });
    });
    request.setTimeout(5000, () => request.destroy(new Error("OmaBond service timed out")));
    request.on("error", reject);
    request.end(body);
  });
}

async function main() {
  const operation = process.argv[2] || "status";
  if (operation === "daemon") {
    const daemon = new OmaBondDaemon();
    await daemon.start();
    return;
  }
  try {
    const input = await readStdinJson();
    const payload = await localRequest(operation, input);
    process.stdout.write(`${JSON.stringify({ operation, ...payload })}\n`);
    if (payload.ok !== true) process.exitCode = 1;
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ ok: false, operation, error: cleanText(error.message || error, 300) })}\n`);
    process.exitCode = 1;
  }
}

const isMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) await main();

export {
  MAX_MESSAGE_LENGTH,
  PORT,
  TRANSPORT_MODE,
  cleanText,
  lanInfo,
  normalizeHost,
  normalizeMessage,
  normalizeProfile,
  normalizeState,
  pairingCode,
  parsePairingCode,
  readStdinJson,
  requireKeyringSuccess,
  fetchPeer,
  secretMatches
};
