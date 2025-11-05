import express from "express";
import http from "http";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";
import { WebSocketServer, WebSocket } from "ws";
import { PROPS, isStreet, groupMembers, CHANCE_CARDS, CHEST_CARDS } from "./public/js/props.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SCHEMA_VERSION = 1;
const STATE_FILE = path.join(__dirname, "state.json");
const PUBLIC_DIR = path.join(__dirname, "public");
const SAVE_DEBOUNCE_MS = 100;
const SESSION_COOKIE = "monoSession";
const SESSION_TTL_MS = 1000 * 60 * 60 * 6; // 6 hours
const HEARTBEAT_INTERVAL_MS = 30_000;
const COOKIE_OPTIONS = { httpOnly: true, sameSite: "lax", path: "/", maxAge: SESSION_TTL_MS };
const fsp = fs.promises;
let saveTimer = null;
const sessions = new Map();
let heartbeatTimer = null;

const AUDIT_LOG_MAX = 300;
const AUDIT_LOG = [];
let AUDIT_SEQ = 1;
const SYSTEM_ACTOR = Object.freeze({ role: "system", idx: -1, session: null, addr: null });

function sanitizePayload(payload){
  if (payload == null) return null;
  if (typeof payload === "object"){
    try { return JSON.parse(JSON.stringify(payload)); }
    catch { return { summary: String(payload) }; }
  }
  if (typeof payload === "string" || typeof payload === "number" || typeof payload === "boolean") {
    return payload;
  }
  return String(payload);
}

function normalizeActor(raw){
  if (!raw || typeof raw !== "object") return { ...SYSTEM_ACTOR };
  const role = typeof raw.role === "string" ? raw.role : "viewer";
  const idx = Number.isFinite(raw.idx) ? Math.trunc(raw.idx) : -1;
  const session = raw.session ? String(raw.session) : null;
  const addr = raw.addr ? String(raw.addr) : null;
  const label = raw.label ? String(raw.label) : null;
  return { role, idx, session, addr, label };
}

function actorFromWS(ws){
  if (!ws || typeof ws !== "object") return { ...SYSTEM_ACTOR };
  return normalizeActor({
    role: typeof ws._role === "string" ? ws._role : "viewer",
    idx: Number.isFinite(ws._idx) ? Math.trunc(ws._idx) : -1,
    session: ws._sessionId || null,
    addr: ws._remoteAddr || null,
  });
}

function deriveActorFromPayload(payload){
  if (!payload || typeof payload !== "object") return null;
  if (payload.actor && typeof payload.actor === "object") return normalizeActor(payload.actor);
  if (Number.isFinite(payload.by)) return normalizeActor({ role: "player", idx: Math.trunc(payload.by) });
  if (Number.isFinite(payload.player)) return normalizeActor({ role: "player", idx: Math.trunc(payload.player) });
  if (payload.requested && typeof payload.requested === "object" && typeof payload.requested.role === "string" && Number.isFinite(payload.requested.idx)) {
    return normalizeActor({ role: payload.requested.role, idx: Math.trunc(payload.requested.idx) });
  }
  if (payload.applied && typeof payload.applied === "object" && typeof payload.applied.role === "string" && Number.isFinite(payload.applied.idx)) {
    return normalizeActor({ role: payload.applied.role, idx: Math.trunc(payload.applied.idx) });
  }
  if (typeof payload.role === "string" && Number.isFinite(payload.idx)) {
    return normalizeActor({ role: payload.role, idx: Math.trunc(payload.idx) });
  }
  return null;
}

function pushAuditEntry(entry){
  if (!entry) return;
  AUDIT_LOG.push(entry);
  if (AUDIT_LOG.length > AUDIT_LOG_MAX) AUDIT_LOG.splice(0, AUDIT_LOG.length - AUDIT_LOG_MAX);
}

function recordAudit(tag, payload, actor, options = {}){
  const entry = {
    id: AUDIT_SEQ++,
    at: now(),
    tag: String(tag || ""),
    payload: sanitizePayload(payload),
    actor: actor ? normalizeActor(actor) : { ...SYSTEM_ACTOR },
  };
  pushAuditEntry(entry);
  if (options.persist !== false) scheduleSave();
  if (options.broadcast !== false) broadcastAudit([entry]);
  return entry;
}

function exportAuditLog(){
  return AUDIT_LOG.map(entry => ({
    id: entry.id,
    at: entry.at,
    tag: entry.tag,
    payload: entry.payload,
    actor: entry.actor ? normalizeActor(entry.actor) : { ...SYSTEM_ACTOR },
  }));
}

const app = express();

function parseCookies(header = "") {
  const out = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const key = decodeURIComponent(part.slice(0, idx).trim());
    if (!key) continue;
    const value = decodeURIComponent(part.slice(idx + 1).trim());
    out[key] = value;
  }
  return out;
}

function normalizeSession(role, idx) {
  if (role === "gm") return { role: "gm", idx: -1 };
  if (role === "player") {
    const num = Number(idx);
    if (Number.isFinite(num)) {
      const n = Math.trunc(num);
      if (n >= 0 && n <= 5) return { role: "player", idx: n };
    }
  }
  return { role: "viewer", idx: -1 };
}

function cleanupSessions() {
  const now = Date.now();
  for (const [id, entry] of sessions.entries()) {
    const touched = entry?.touchedAt ?? entry?.createdAt ?? now;
    if ((now - touched) > SESSION_TTL_MS) {
      sessions.delete(id);
    }
  }
}

function ensureSession(req, res, wantedRole, idx = -1) {
  cleanupSessions();
  const normalized = normalizeSession(wantedRole, idx);
  const cookies = parseCookies(req.headers?.cookie || "");
  const existingId = cookies[SESSION_COOKIE];
  let entry = null;
  if (existingId) {
    entry = sessions.get(existingId) || null;
    if (entry) {
      const now = Date.now();
      if ((now - entry.touchedAt) <= SESSION_TTL_MS) {
        entry.role = normalized.role;
        entry.idx = normalized.idx;
        entry.touchedAt = now;
      } else {
        sessions.delete(existingId);
        entry = null;
      }
    }
  }
  if (!entry) {
    entry = {
      id: crypto.randomUUID(),
      role: normalized.role,
      idx: normalized.idx,
      createdAt: Date.now(),
      touchedAt: Date.now(),
    };
    sessions.set(entry.id, entry);
  }
  res.cookie(SESSION_COOKIE, entry.id, COOKIE_OPTIONS);
  return entry;
}

function resolveSession(req) {
  cleanupSessions();
  const cookies = parseCookies(req.headers?.cookie || "");
  const id = cookies[SESSION_COOKIE];
  if (!id) return { id: null, role: "viewer", idx: -1 };
  const entry = sessions.get(id);
  if (!entry) return { id: null, role: "viewer", idx: -1 };
  const now = Date.now();
  if ((now - entry.touchedAt) > SESSION_TTL_MS) {
    sessions.delete(id);
    return { id: null, role: "viewer", idx: -1 };
  }
  entry.touchedAt = now;
  return { id, role: entry.role, idx: entry.idx };
}

function derivePlayerIdx(query = {}) {
  const keys = Object.keys(query);
  if (query.p != null) {
    const val = Number(query.p);
    if (Number.isFinite(val)) {
      const n = Math.trunc(val);
      if (n >= 1 && n <= 6) return n - 1;
    }
  }
  if (query.player != null) {
    const val = Number(query.player);
    if (Number.isFinite(val)) {
      const n = Math.trunc(val);
      if (n >= 1 && n <= 6) return n - 1;
    }
  }
  for (const key of keys) {
    let m = /^p([1-6])$/i.exec(key);
    if (m) return parseInt(m[1], 10) - 1;
    m = /^([1-6])$/.exec(key);
    if (m) return parseInt(m[1], 10) - 1;
  }
  return -1;
}

function sendStaticFile(res, file) {
  res.sendFile(path.join(PUBLIC_DIR, file));
}

app.get("/", (req, res) => {
  ensureSession(req, res, "gm", -1);
  sendStaticFile(res, "index.html");
});

app.get("/index.html", (req, res) => {
  ensureSession(req, res, "gm", -1);
  sendStaticFile(res, "index.html");
});

app.get("/player.html", (req, res) => {
  const idx = derivePlayerIdx(req.query || {});
  const role = idx >= 0 ? "player" : "viewer";
  ensureSession(req, res, role, idx);
  sendStaticFile(res, "player.html");
});

app.use(express.static(PUBLIC_DIR));

const server = http.createServer(app);
// Bind WS to a stable path so clients can always connect at /ws
const wss = new WebSocketServer({ server, path: "/ws" });

heartbeatTimer = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      dbg("ws:terminate:stale", { addr: ws._remoteAddr, role: ws._role, idx: ws._idx });
      try { ws.terminate(); } catch { }
      continue;
    }
    ws.isAlive = false;
    try { ws.ping(); } catch (err) {
      dbg("ws:ping:error", err?.message || err);
      try { ws.terminate(); } catch { }
    }
  }
}, HEARTBEAT_INTERVAL_MS);
wss.on("close", () => {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
});

/* ------------ Helpers ------------ */
const clamp = (n,a,b) => Math.max(a, Math.min(b, n|0));
const clampPos = (v) => { v = v|0; v %= 40; return v < 0 ? v + 40 : v; };
function uniqPlayers(arr){
  const out=[]; const seen=new Set();
  for(const n of arr||[]){ const x=n|0; if(x>=0&&x<6&&!seen.has(x)){ seen.add(x); out.push(x); } }
  return out.length ? out : [0,1,2,3,4,5];
}
function now() { return new Date().toISOString().replace("T"," ").replace("Z",""); }
function dbg(tag, payload){ console.log(`[${now()}] ${tag}`, payload ?? ""); }
function withMeta(obj){
  if (!obj || typeof obj !== "object") return obj;
  const root = { ...obj, stateRev: STATE?.stateRev ?? 0, schemaVersion: SCHEMA_VERSION };
  if (obj.payload && typeof obj.payload === "object"){
    root.payload = { ...obj.payload, stateRev: STATE?.stateRev ?? 0, schemaVersion: SCHEMA_VERSION };
  }
  return root;
}
function broadcast(obj){
  const msg = JSON.stringify(withMeta(obj));
  wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(msg); });
}
function send(ws, obj){
  try { ws.send(JSON.stringify(withMeta(obj))); } catch {}
}
function buildPatchPayload(){
  const names = Array.from({ length: 6 }, (_, i) =>
    String(STATE.playerNames?.[i] ?? `P${i+1}`).slice(0, 18)
  );
  const positions = Array.from({ length: 6 }, (_, i) => clampPos(STATE.playerPos?.[i] ?? 0));
  const properties = Array.from({ length: STATE.properties.length }, (_, i) => {
    const p = STATE.properties?.[i] ?? {};
    const hotel = (p.hotel ?? 0) ? 1 : 0;
    return {
      owner: clamp(p.owner ?? 0, 0, 6),
      houses: hotel ? 0 : clamp(p.houses ?? 0, 0, 4),
      hotel,
    };
  });
  const dice = {
    a: STATE.dice?.a|0,
    b: STATE.dice?.b|0,
    by: (STATE.dice?.by ?? -1)|0,
    at: STATE.dice?.at|0,
    seq: STATE.dice?.seq|0,
  };
  const order = Array.isArray(STATE.turn?.order) ? uniqPlayers(STATE.turn.order) : [0,1,2,3,4,5];
  const activeMax = Math.max(0, order.length - 1);
  const turn = {
    order,
    active: clamp(STATE.turn?.active ?? 0, 0, activeMax),
    rev: STATE.turn?.rev|0,
    doublesBy: clamp(STATE.turn?.doublesBy ?? -1, -1, 5),
    doublesCount: clamp(STATE.turn?.doublesCount ?? 0, 0, 10),
  };
  const cardsLast = STATE.cards?.last ?? null;
  return {
    schemaVersion: SCHEMA_VERSION,
    stateRev: STATE.stateRev|0,
    nameEpoch: STATE.nameEpoch|0,
    playerNames: names,
    playerPos: positions,
    properties,
    dice,
    turn,
    enabled: Array.from({ length: 6 }, (_, i) => !!(STATE.enabled?.[i] ?? true)),
    money: Array.from({ length: 6 }, (_, i) => (STATE.money?.[i] ?? 1500)|0),
    inJail: Array.from({ length: 6 }, (_, i) => !!(STATE.inJail?.[i] ?? false)),
    jailTries: Array.from({ length: 6 }, (_, i) => (STATE.jailTries?.[i] ?? 0)|0),
    debugForceDoubles: !!STATE.debugForceDoubles,
    cardsLast: cardsLast ? {
      deck: String(cardsLast.deck ?? ""),
      id: String(cardsLast.id ?? ""),
      text: String(cardsLast.text ?? ""),
      by: clamp(cardsLast.by ?? -1, -1, 5),
      at: cardsLast.at|0,
      action: cardsLast.action ? String(cardsLast.action) : "",
    } : null,
    cardsHolding: {
      chanceGOJ: clamp(STATE.cards?.chance?.gojHolder ?? -1, -1, 5),
      chestGOJ:  clamp(STATE.cards?.chest?.gojHolder  ?? -1, -1, 5),
    },
  };
}
function broadcastPatch(){
  broadcast({ type: "patch", payload: buildPatchPayload() });
}
function exportState(){
  const base = buildPatchPayload();
  const chance = STATE.cards?.chance ?? {};
  const chest = STATE.cards?.chest ?? {};
  const last = base.cardsLast ?? { deck:"", id:"", text:"", by:-1, at:0, action:"" };
  return {
    ...base,
    cards: {
      chance: {
        draw: Array.isArray(chance.draw) ? [...chance.draw] : [],
        discard: Array.isArray(chance.discard) ? [...chance.discard] : [],
        gojHolder: clamp(chance.gojHolder ?? -1, -1, 5),
      },
      chest: {
        draw: Array.isArray(chest.draw) ? [...chest.draw] : [],
        discard: Array.isArray(chest.discard) ? [...chest.discard] : [],
        gojHolder: clamp(chest.gojHolder ?? -1, -1, 5),
      },
      last,
    },
  };
}
async function writeState(){
  const data = JSON.stringify(exportState(), null, 2);
  try {
    await fsp.writeFile(STATE_FILE, data, "utf8");
  } catch (err) {
    console.error("[state] persist failed", err);
  }
}
function scheduleSave(){
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    writeState();
  }, SAVE_DEBOUNCE_MS);
}
function touchState(){
  STATE.stateRev = Math.max((STATE.stateRev|0) + 1, 1);
  scheduleSave();
}
function loadStateFromDisk(){
  try {
    if (!fs.existsSync(STATE_FILE)) return;
    const raw = fs.readFileSync(STATE_FILE, "utf8");
    if (!raw.trim()) return;
    const data = JSON.parse(raw);
    if ((data?.schemaVersion ?? 0) !== SCHEMA_VERSION) {
      console.warn("[state] ignoring persisted state due to schema mismatch", { expected: SCHEMA_VERSION, found: data?.schemaVersion ?? null });
      return;
    }
    if (typeof data.stateRev === "number") STATE.stateRev = Math.max(data.stateRev|0, STATE.stateRev|0);
    if (typeof data.nameEpoch === "number") STATE.nameEpoch = data.nameEpoch|0;
    if (Array.isArray(data.playerNames)) {
      for (let i=0;i<6;i++){
        STATE.playerNames[i] = String(data.playerNames[i] ?? `P${i+1}`).slice(0, 18);
      }
    }
    if (Array.isArray(data.playerPos)) {
      for (let i=0;i<6;i++){
        STATE.playerPos[i] = clampPos(data.playerPos[i] ?? STATE.playerPos[i]);
      }
    }
    if (Array.isArray(data.properties)) {
      const len = Math.min(STATE.properties.length, data.properties.length);
      for (let i=0;i<len;i++){
        const src = data.properties[i] || {};
        const dst = STATE.properties[i];
        const hotel = (src.hotel ?? dst.hotel) ? 1 : 0;
        dst.owner = clamp(src.owner ?? dst.owner, 0, 6);
        dst.houses = hotel ? 0 : clamp(src.houses ?? dst.houses, 0, 4);
        dst.hotel = hotel;
      }
    }
    if (data.dice) {
      STATE.dice = {
        a: data.dice.a|0,
        b: data.dice.b|0,
        by: (data.dice.by ?? -1)|0,
        at: data.dice.at|0,
        seq: data.dice.seq|0,
      };
    }
    if (data.turn) {
      const ord = Array.isArray(data.turn.order) ? uniqPlayers(data.turn.order) : STATE.turn.order;
      STATE.turn.order = ord;
      STATE.turn.active = clamp(data.turn.active ?? STATE.turn.active, 0, Math.max(0, ord.length-1));
      STATE.turn.rev = (data.turn.rev ?? STATE.turn.rev)|0;
      STATE.turn.doublesBy = clamp(data.turn.doublesBy ?? STATE.turn.doublesBy ?? -1, -1, 5);
      STATE.turn.doublesCount = clamp(data.turn.doublesCount ?? STATE.turn.doublesCount ?? 0, 0, 10);
    }
    if (Array.isArray(data.money)) {
      for (let i=0;i<6;i++) STATE.money[i] = (data.money[i] ?? STATE.money[i])|0;
    }
    if (Array.isArray(data.inJail)) {
      for (let i=0;i<6;i++) STATE.inJail[i] = !!data.inJail[i];
    }
    if (Array.isArray(data.jailTries)) {
      for (let i=0;i<6;i++) STATE.jailTries[i] = (data.jailTries[i] ?? STATE.jailTries[i])|0;
    }
    if (Array.isArray(data.enabled)) {
      for (let i=0;i<6;i++) STATE.enabled[i] = !!data.enabled[i];
    }
    if (typeof data.debugForceDoubles === "boolean") {
      STATE.debugForceDoubles = data.debugForceDoubles;
    }
    if (data.cards) {
      const fallback = initCards();
      const chance = data.cards.chance || {};
      const chest = data.cards.chest || {};
      const last = data.cards.last || {};
      STATE.cards.chance.draw = Array.isArray(chance.draw)
        ? chance.draw.map(v => clamp(v, 0, CHANCE_CARDS.length-1))
        : fallback.chance.draw;
      STATE.cards.chance.discard = Array.isArray(chance.discard)
        ? chance.discard.map(v => clamp(v, 0, CHANCE_CARDS.length-1))
        : [];
      STATE.cards.chance.gojHolder = clamp(chance.gojHolder ?? -1, -1, 5);
      STATE.cards.chest.draw = Array.isArray(chest.draw)
        ? chest.draw.map(v => clamp(v, 0, CHEST_CARDS.length-1))
        : fallback.chest.draw;
      STATE.cards.chest.discard = Array.isArray(chest.discard)
        ? chest.discard.map(v => clamp(v, 0, CHEST_CARDS.length-1))
        : [];
      STATE.cards.chest.gojHolder = clamp(chest.gojHolder ?? -1, -1, 5);
      STATE.cards.last = {
        deck: String(last.deck ?? ""),
        id: String(last.id ?? ""),
        text: String(last.text ?? ""),
        by: clamp(last.by ?? -1, -1, 5),
        at: last.at|0,
        action: last.action ? String(last.action) : "",
      };
    }
    dbg("state:load", { rev: STATE.stateRev, schemaVersion: SCHEMA_VERSION });
  } catch (err) {
    if (err.code !== "ENOENT") console.error("[state] load failed", err);
  }
  STATE.schemaVersion = SCHEMA_VERSION;
}

/* ------------ Canonical state ------------ */
const STATE = {
  schemaVersion: SCHEMA_VERSION,
  stateRev: 1,
  nameEpoch: 1,
  playerNames: ["P1","P2","P3","P4","P5","P6"],
  playerPos:   [0,0,0,0,0,0],
  properties:  Array.from({length:28}, () => ({ owner:0, houses:0, hotel:0 })),
  dice: { a:0, b:0, by:-1, at:0, seq:0 },
  turn: { order:[0,1,2,3,4,5], active:0, rev:1, doublesBy:-1, doublesCount:0 },
  money:  [1500,1500,1500,1500,1500,1500],
  inJail: [false,false,false,false,false,false],
  jailTries: [0,0,0,0,0,0],
  enabled: [true,true,true,true,true,true],
  debugForceDoubles: false,
};

// ---- Cards (Chance/Chest)
function shuffle(arr){ const a = arr.slice(); for (let i=a.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); [a[i],a[j]]=[a[j],a[i]]; } return a; }
function initCards(){
  return {
    chance: { draw: shuffle(CHANCE_CARDS.map((_,i)=>i)), discard: [], gojHolder: -1 },
    chest:  { draw: shuffle(CHEST_CARDS.map((_,i)=>i)),  discard: [], gojHolder: -1 },
    last:   { deck:"", id:"", text:"", by:-1, at:0 }
  };
}
STATE.cards = initCards();
loadStateFromDisk();
const cardsRef = (deck)=> deck==='chest' ? STATE.cards.chest : STATE.cards.chance;
const cardsList = (deck)=> deck==='chest' ? CHEST_CARDS : CHANCE_CARDS;
function refillIfEmpty(deck){ const c=cardsRef(deck); if (c.draw.length===0){ c.draw = shuffle(c.discard); c.discard = []; } }
function nearestOf(cur, targets){ let best=null, bestDist=999; for (const t of targets){ const d=(t-cur+40)%40; if (d>=0 && d<bestDist){ bestDist=d; best=t; } } return best ?? targets[0]; }
function maybeDrawLanding(by){
  const pos = STATE.playerPos[by] | 0;
  if (pos===2 || pos===17 || pos===33) drawCard("chest", by);
  else if (pos===7 || pos===22 || pos===36) drawCard("chance", by);
}
function drawCard(deck, by){
  refillIfEmpty(deck);
  const cref = cardsRef(deck);
  if (!cref.draw.length) return;
  const cardIdx = cref.draw.shift();
  const card = cardsList(deck)[cardIdx];
  let action = "apply";
  if (card.type === "getOutOfJail"){
    cref.gojHolder = by;
    action = "hold";
  } else {
    applyCardEffect(deck, card, by);
    cref.discard.push(cardIdx);
  }
  STATE.cards.last = { deck, id: card.id, text: card.text, by, at: Date.now(), action };
  touchState();
  broadcast({ type: "cards:drawn", data: { deck, id: card.id, text: card.text, by, action } });
  broadcastPatch();
}
function applyCardEffect(deck, card, by){
  const cur = STATE.playerPos[by] | 0; let moved=false;
  const moveTo = (to)=>{ let target=((to|0)+40)%40; if (target!==10){ const raw=(target-cur+40)%40; if (raw>0 && ((cur+raw)>=40 || (target<cur))) credit(by,200); }
    if (target===30){ STATE.playerPos[by]=10; STATE.inJail[by]=true; STATE.jailTries[by]=0; } else { STATE.playerPos[by]=target; } moved=true; };
  switch(card.type){
    case "move": moveTo(card.target|0); break;
    case "goToJail": STATE.playerPos[by]=10; STATE.inJail[by]=true; STATE.jailTries[by]=0; moved=true; break;
    case "back3": moveTo((cur-3+40)%40); break;
    case "nearestUtility": { const to=nearestOf(cur,[12,28]); if (to<cur) credit(by,200); if (to===30){ STATE.playerPos[by]=10; STATE.inJail[by]=true; STATE.jailTries[by]=0; } else STATE.playerPos[by]=to; moved=true; break; }
    case "nearestRailroad": { const to=nearestOf(cur,[5,15,25,35]); if (to<cur) credit(by,200); if (to===30){ STATE.playerPos[by]=10; STATE.inJail[by]=true; STATE.jailTries[by]=0; } else STATE.playerPos[by]=to; moved=true; break; }
    case "collect": credit(by, card.amount|0); break;
    case "pay": debit(by, card.amount|0); break;
    case "payEachPlayer": { let count=0; for(let i=0;i<6;i++){ if(i!==by && STATE.enabled[i]){ count++; credit(i, card.amount|0); } } if(count>0) debit(by,(card.amount|0)*count); break; }
    case "collectFromEachPlayer": { let count=0; for(let i=0;i<6;i++){ if(i!==by && STATE.enabled[i]){ count++; debit(i, card.amount|0); } } if(count>0) credit(by,(card.amount|0)*count); break; }
    case "repairs": { let houses=0, hotels=0; for(let i=0;i<STATE.properties.length;i++){ const s=STATE.properties[i]; if((s.owner|0)===(by+1)){ houses+=(s.houses|0); if(s.hotel) hotels+=1; } } const amt=(houses*(card.perHouse|0))+(hotels*(card.perHotel|0)); if(amt>0) debit(by,amt); break; }
    case "getOutOfJail": break;
  }
  if (moved){ const pos=STATE.playerPos[by]|0; if (pos===4) debit(by,200); else if (pos===38) debit(by,100); maybeDrawLanding(by); }
}

function credit(player, amt){
  const i = clamp(player, 0, 5);
  STATE.money[i] = (STATE.money[i]|0) + (amt|0);
  dbg("money:credit", { i, delta: amt, balance: STATE.money[i] });
  touchState();
  broadcast({ type:"money", data: [...STATE.money] });
}
function debit(player, amt){ credit(player, -(amt|0)); }

function nextEnabledActive(step=1){
  const ord = STATE.turn.order;
  const L = ord.length;
  if (!L) { STATE.turn.active = 0; return; }
  let i = ((STATE.turn.active|0) + step) % L; if (i < 0) i += L;
  for (let tries=0; tries<L; tries++){
    const pIdx = ord[i]|0;
    if (STATE.enabled[pIdx]) { STATE.turn.active = i; return; }
    i = (i+1) % L;
  }
  STATE.turn.active = 0;
}
function setOrderKeepEnabled(newOrder){
  const ord = uniqPlayers(newOrder).filter(i => STATE.enabled[i]);
  STATE.turn.order = ord.length ? ord : STATE.enabled.map((v,i)=>v?i:null).filter(v=>v!=null);
  STATE.turn.active = clamp(STATE.turn.active, 0, Math.max(0, STATE.turn.order.length-1));
  STATE.turn.rev = (STATE.turn.rev|0)+1;
}

/* ------------ WS handling ------------ */
wss.on("connection", (ws, req) => {
  const remoteAddr = req.socket.remoteAddress;
  const session = resolveSession(req);
  const normalized = normalizeSession(session.role, session.idx);
  ws._remoteAddr = remoteAddr;
  ws._sessionId = session.id || null;
  ws._role = normalized.role;
  ws._idx = normalized.idx;
  ws.isAlive = true;
  ws._lastPong = Date.now();

  ws.on("pong", () => {
    ws.isAlive = true;
    ws._lastPong = Date.now();
  });

  dbg("ws:connect", { addr: remoteAddr, role: ws._role, idx: ws._idx, session: ws._sessionId });

  // full snapshot first
  send(ws, { type:"state", payload: buildPatchPayload() });
  send(ws, { type:"role", data: { role: ws._role, idx: ws._idx } });

  ws.on("message", (raw) => {
    ws.isAlive = true;
    let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }
    const t = msg.type;
    const msgRev = Number.isFinite(Number(msg.stateRev)) ? Math.trunc(Number(msg.stateRev)) : null;

    if (t === "hello") {
      dbg("ws:hello:client", { requested: { role: msg.role, idx: msg.idx }, applied: { role: ws._role, idx: ws._idx } });
      send(ws, { type:"role", data: { role: ws._role, idx: ws._idx } });
      return;
    }

    const schemaNum = Number(msg.schemaVersion);
    if (!Number.isFinite(schemaNum) || schemaNum !== SCHEMA_VERSION) {
      send(ws, { type:"debug", level:"error", msg:"Client schema mismatch. Refresh required.", data:{ expected: SCHEMA_VERSION, got: msg.schemaVersion ?? null } });
      return;
    }
    if (msgRev === null){
      send(ws, { type:"debug", level:"warn", msg:"Missing stateRev. Refresh client." });
      return;
    }
    if (msgRev < (STATE.stateRev|0)){
      send(ws, { type:"debug", level:"warn", msg:"Stale command rejected", data:{ expected: STATE.stateRev, got: msgRev } });
      return;
    }

    // Property update
    if (t === "updateProperty") {
      if (ws._role !== "gm") { send(ws, { type:"debug", level:"warn", msg:"Only GM may update properties" }); return; }
      const idx = Number.isFinite(Number(msg.index)) ? Math.trunc(Number(msg.index)) : -1;
      if (!(idx >= 0 && idx < STATE.properties.length)) {
        send(ws, { type:"debug", level:"warn", msg:"Invalid property index", data:{ index: msg.index } });
        return;
      }
      const patch = (msg && typeof msg.patch === "object") ? msg.patch : {};
      const s = STATE.properties[idx];
      s.owner = clamp(patch.owner ?? s.owner, 0, 6);

      const prop = PROPS[idx];
      if (!isStreet(prop)){
        s.houses = 0; s.hotel = 0;
        dbg("property:update:non-street", { index:idx, owner:s.owner });
        touchState();
        broadcast({ type:"property", index:idx, data: { owner:s.owner, houses:s.houses, hotel:s.hotel } });
        broadcastPatch();
        return;
      }

      const desiredHotel = (patch.hotel ?? s.hotel) ? 1 : 0;
      let desiredHouses = clamp(patch.houses ?? s.houses, 0, 4);
      const owner = s.owner|0;
      const ownerIdx = owner>0 ? owner-1 : -1;
      const idxs = groupMembers(prop.group);
      const hasMon = owner>0 && idxs.every(gi => (STATE.properties[gi].owner|0) === owner);

      if (desiredHouses > (s.houses|0)){
        if (!hasMon){ desiredHouses = s.houses|0; }
        while ((s.houses|0) < desiredHouses && (s.hotel|0)===0){
          let minH = Infinity;
          for (const gi of idxs){
            const ps = STATE.properties[gi];
            const h = (ps.hotel>0) ? 5 : (ps.houses|0);
            if (h < minH) minH = h;
          }
          if ((s.houses|0) > minH) break;
          if (ownerIdx>=0){ debit(ownerIdx, prop.house|0); }
          s.houses = (s.houses|0) + 1;
        }
      } else if (desiredHouses < (s.houses|0)){
        s.houses = desiredHouses;
      }

      if (desiredHotel && (s.hotel|0)===0){
        let ok = hasMon && idxs.every(gi => (STATE.properties[gi].houses|0) >= 4);
        if (ok){ if (ownerIdx>=0) debit(ownerIdx, prop.house|0); s.hotel=1; s.houses=0; }
      } else if (!desiredHotel && (s.hotel|0)===1){
        s.hotel = 0; s.houses = 0;
      }

      dbg("property:update", { index:idx, patch: { owner:s.owner, houses:s.houses, hotel:s.hotel } });
      touchState();
      broadcast({ type:"property", index:idx, data: { owner:s.owner, houses:s.houses, hotel:s.hotel } });
      broadcastPatch();
      return;
    }

    // Names
    if (t === "setPlayerName") {
      const idx = Number.isFinite(Number(msg.index)) ? Math.trunc(Number(msg.index)) : -1;
      if (!(idx >= 0 && idx < 6)) {
        send(ws, { type:"debug", level:"warn", msg:"Invalid player index", data:{ index: msg.index } });
        return;
      }
      if (ws._role === "player" && ws._idx !== idx) {
        send(ws, { type:"debug", level:"warn", msg:"Players may only rename themselves" });
        return;
      }
      if (ws._role !== "gm" && ws._role !== "player") {
        send(ws, { type:"debug", level:"warn", msg:"Unauthorized to rename players" });
        return;
      }
      const nameRaw = typeof msg.name === "string" ? msg.name : "";
      const nextName = (nameRaw.trim() || `P${idx+1}`).slice(0, 18);
      if (STATE.playerNames[idx] === nextName) return;
      STATE.playerNames[idx] = nextName;
      dbg("player:name", { idx, name: nextName });
      touchState();
      broadcast({ type:"playerNames", data: [...STATE.playerNames] });
      broadcastPatch();
      return;
    }

    // Positions
    if (t === "setPlayerPos") {
      const idx = Number.isFinite(Number(msg.index)) ? Math.trunc(Number(msg.index)) : -1;
      if (!(idx >= 0 && idx < 6)) {
        send(ws, { type:"debug", level:"warn", msg:"Invalid player index", data:{ index: msg.index } });
        return;
      }
      if (ws._role === "player" && ws._idx !== idx) {
        send(ws, { type:"debug", level:"warn", msg:"Players may only move themselves" });
        return;
      }
      if (ws._role !== "gm" && ws._role !== "player") {
        send(ws, { type:"debug", level:"warn", msg:"Unauthorized to move player" });
        return;
      }
      let pos = clampPos(msg.pos);
      if (pos === 30) { pos = 10; STATE.inJail[idx] = true; STATE.jailTries[idx] = 0; }
      STATE.playerPos[idx] = pos;
      dbg("player:pos", { idx, pos });
      touchState();
      broadcast({ type:"playerPos", data: [...STATE.playerPos] });
      broadcastPatch();
      if (pos===2||pos===17||pos===33||pos===7||pos===22||pos===36) maybeDrawLanding(idx);
      return;
    }

    // Enable/disable players
    if (t === "player:enabled") {
      if (ws._role !== "gm") { send(ws, { type:"debug", level:"warn", msg:"Only GM may enable/disable players" }); return; }
      const idx = Number.isFinite(Number(msg.index)) ? Math.trunc(Number(msg.index)) : -1;
      if (!(idx >= 0 && idx < 6)) {
        send(ws, { type:"debug", level:"warn", msg:"Invalid player index", data:{ index: msg.index } });
        return;
      }
      const enabled = !!msg.enabled;
      if (STATE.enabled[idx] === enabled) return;
      STATE.enabled[idx] = enabled;
      setOrderKeepEnabled(STATE.turn.order);
      STATE.turn.doublesBy = -1;
      STATE.turn.doublesCount = 0;
      dbg("player:enabled", { idx, enabled, order:STATE.turn.order, active:STATE.turn.active });
      touchState();
      broadcast({ type:"enabled", data: [...STATE.enabled] });
      broadcast({ type:"turn", data: { ...STATE.turn, order:[...STATE.turn.order] } });
      broadcastPatch();
      return;
    }

    // Debug: force doubles toggle (GM only)
    if (t === "debug:forceDoubles") {
      if (ws._role !== "gm") { send(ws, { type:"debug", level:"warn", msg:"Only GM can change debug flags" }); return; }
      const next = !!msg.value;
      if (STATE.debugForceDoubles === next) return;
      STATE.debugForceDoubles = next;
      dbg("debug:forceDoubles", { value: STATE.debugForceDoubles });
      touchState();
      broadcastPatch();
      return;
    }

    // Cards: manual draw by GM
    if (t === "cards:draw") {
      if (ws._role !== "gm") { send(ws, { type:"debug", level:"warn", msg:"Only GM can draw cards" }); return; }
      const deck = (String(msg.deck||"chance").toLowerCase()==="chest") ? "chest" : "chance";
      const L = STATE.turn.order.length;
      const by = clamp((msg.by ?? (L ? (STATE.turn.order[STATE.turn.active]|0) : 0)), 0, 5);
      refillIfEmpty(deck);
      const cref = cardsRef(deck);
      if (!cref.draw.length){ send(ws, { type:"debug", level:"warn", msg:"Deck empty" }); return; }
      const cardIdx = cref.draw.shift();
      const card = cardsList(deck)[cardIdx];
      let action = "apply";
      if (card.type === "getOutOfJail"){
        cref.gojHolder = by;
        action = "hold";
      } else {
        applyCardEffect(deck, card, by);
        cref.discard.push(cardIdx);
      }
      STATE.cards.last = { deck, id: card.id, text: card.text, by, at: Date.now(), action };
      touchState();
      broadcast({ type:"cards:drawn", data: { deck, id: card.id, text: card.text, by, action } });
      broadcastPatch();
      return;
    }

    // Player uses a Get Out of Jail Free card
    if (t === "player:useGOJ") {
      let idx = -1;
      if (ws._role === "player") idx = ws._idx|0; else if (ws._role === "gm") idx = clamp((msg.index ?? msg.by ?? -1), -1, 5);
      if (!(idx>=0 && idx<6)) { send(ws, { type:"debug", level:"warn", msg:"Invalid player index" }); return; }
      if (!STATE.inJail[idx]) { send(ws, { type:"debug", level:"warn", msg:"Player not in jail" }); return; }
      const wantDeck = String(msg.deck||"").toLowerCase();
      const hasChance = ((STATE.cards?.chance?.gojHolder|0) === idx);
      const hasChest  = ((STATE.cards?.chest?.gojHolder|0) === idx);
      let deck = "";
      if (wantDeck==="chance" && hasChance) deck = "chance";
      else if (wantDeck==="chest" && hasChest) deck = "chest";
      else if (hasChance) deck = "chance";
      else if (hasChest) deck = "chest";
      if (!deck) { send(ws, { type:"debug", level:"warn", msg:"No GOJ card held" }); return; }
      const list = cardsList(deck);
      const cardIdx = list.findIndex(c => c.type==="getOutOfJail");
      const cref = cardsRef(deck);
      if (deck==="chance") STATE.cards.chance.gojHolder = -1; else STATE.cards.chest.gojHolder = -1;
      if (cardIdx>=0) cref.discard.push(cardIdx);
      STATE.inJail[idx] = false; STATE.jailTries[idx] = 0;
      dbg("cards:goj:used", { deck, by: idx });
      touchState();
      broadcast({ type:"cards:gojUsed", data: { deck, by: idx } });
      broadcastPatch();
      return;
    }

    // Turn: set order
    if (t === "turn:setOrder") {
      if (ws._role !== "gm") { send(ws, { type:"debug", level:"warn", msg:"Only GM may set turn order" }); return; }
      setOrderKeepEnabled(Array.isArray(msg.order) ? msg.order : []);
      STATE.turn.doublesBy = -1;
      STATE.turn.doublesCount = 0;
      dbg("turn:setOrder", { order:STATE.turn.order, active:STATE.turn.active });
      touchState();
      broadcast({ type:"turn", data: { ...STATE.turn, order:[...STATE.turn.order] } });
      broadcastPatch();
      return;
    }

    // Turn: set active index directly
    if (t === "turn:setActive") {
      if (ws._role !== "gm") { send(ws, { type:"debug", level:"warn", msg:"Only GM may set active turn" }); return; }
      const L = STATE.turn.order.length;
      if (!L) return;
      STATE.turn.active = clamp(msg.index, 0, L-1);
      STATE.turn.rev = (STATE.turn.rev|0)+1;
      STATE.turn.doublesBy = -1;
      STATE.turn.doublesCount = 0;
      dbg("turn:setActive", { active:STATE.turn.active });
      touchState();
      broadcast({ type:"turn", data: { ...STATE.turn, order:[...STATE.turn.order] } });
      broadcastPatch();
      return;
    }

    // Turn: next/prev
    if (t === "turn:next") {
      if (ws._role !== "gm") { send(ws, { type:"debug", level:"warn", msg:"Only GM may advance turn" }); return; }
      nextEnabledActive(msg.delta|0 || 1);
      STATE.turn.rev = (STATE.turn.rev|0)+1;
      STATE.turn.doublesBy = -1;
      STATE.turn.doublesCount = 0;
      dbg("turn:next", { active:STATE.turn.active, order:STATE.turn.order });
      touchState();
      broadcast({ type:"turn", data: { ...STATE.turn, order:[...STATE.turn.order] } });
      broadcastPatch();
      return;
    }

    // Dice roll
    if (t === "rollDice") {
      if (ws._role !== "gm" && ws._role !== "player") {
        send(ws, { type:"debug", level:"warn", msg:"Unauthorized to roll dice" });
        return;
      }
      let byRaw = Number.isFinite(Number(msg.by)) ? Math.trunc(Number(msg.by)) : -1;
      if (ws._role === "player") byRaw = ws._idx|0;
      if (!(byRaw >= 0 && byRaw < 6)) {
        send(ws, { type:"debug", level:"warn", msg:"Invalid roller index", data:{ index: msg.by } });
        return;
      }
      let by = clamp(byRaw, 0, 5);
      const requireTurn = !!msg.requireTurn;
      const autoMove = !!msg.autoMove;

      const L = STATE.turn.order.length;
      const activePlayer = L ? (STATE.turn.order[STATE.turn.active]|0) : by;

      // Only GM or the active player's own client may roll
      if (requireTurn) {
        const isGM = ws._role === "gm";
        const isActivePlayerClient = (ws._role === "player" && ws._idx === activePlayer && by === ws._idx);
        if (!isGM && !isActivePlayerClient){
          dbg("dice:reject:not-authorized", { requestedBy: by, activePlayer, wsRole: ws._role, wsIdx: ws._idx });
          send(ws, { type:"debug", level:"warn", msg:"Not authorized to roll", data:{ by, activePlayer } });
          return;
        }
        by = activePlayer; // force
      } else if (ws._role === "player" && ws._idx !== by) {
        by = ws._idx|0;
      }

      let a = 1 + Math.floor(Math.random()*6);
      let b = 1 + Math.floor(Math.random()*6);
      if (STATE.debugForceDoubles){ const v = 1 + Math.floor(Math.random()*6); a = v; b = v; }
      const seq = (STATE.dice.seq|0) + 1;
      STATE.dice = { a, b, by, at: Date.now(), seq };
      const isDouble = (a === b);
      dbg("dice:roll", { a, b, by, seq, isDouble, force: STATE.debugForceDoubles });
      touchState();
      broadcast({ type:"dice", data: STATE.dice });

      // Jail logic
      if (STATE.inJail[by]){
        if (isDouble){
          STATE.inJail[by] = false; STATE.jailTries[by] = 0;
          if (autoMove){
            const cur = STATE.playerPos[by] | 0;
            const raw = cur + a + b;
            let to = clampPos(raw);
          if (raw >= 40) credit(by, 200);
          if (to === 30) { to = 10; STATE.inJail[by]=true; STATE.jailTries[by]=0; }
          STATE.playerPos[by] = to;
          if (to === 4) debit(by, 200); else if (to === 38) debit(by, 100);
          dbg("autoMove:jail-exit", { by, from:cur, to });
          touchState();
          broadcast({ type:"playerPos", data: [...STATE.playerPos] });
            maybeDrawLanding(by);
          }
          STATE.turn.doublesBy = -1; STATE.turn.doublesCount = 0;
          nextEnabledActive(1);
          STATE.turn.rev = (STATE.turn.rev|0)+1;
          touchState();
          broadcast({ type:"turn", data: { ...STATE.turn, order:[...STATE.turn.order] } });
          return;
        } else {
          const tries = (STATE.jailTries[by]|0) + 1;
          STATE.jailTries[by] = tries;
          if (tries >= 3){
            debit(by, 50);
            STATE.inJail[by] = false; STATE.jailTries[by] = 0;
            if (autoMove){
              const cur = STATE.playerPos[by] | 0;
              const raw = cur + a + b;
              let to = clampPos(raw);
              if (raw >= 40) credit(by, 200);
              if (to === 30) { to = 10; STATE.inJail[by]=true; STATE.jailTries[by]=0; }
              STATE.playerPos[by] = to;
              if (to === 4) debit(by, 200); else if (to === 38) debit(by, 100);
              dbg("autoMove:jail-third", { by, from:cur, to });
              touchState();
              broadcast({ type:"playerPos", data: [...STATE.playerPos] });
              maybeDrawLanding(by);
            }
          }
          STATE.turn.doublesBy = -1; STATE.turn.doublesCount = 0;
          nextEnabledActive(1);
          STATE.turn.rev = (STATE.turn.rev|0)+1;
          touchState();
          broadcast({ type:"turn", data: { ...STATE.turn, order:[...STATE.turn.order] } });
          return;
        }
      }

      if (isDouble) {
        const prevBy = STATE.turn.doublesBy|0;
        const prevCount = STATE.turn.doublesCount|0;
        if (prevBy === by) {
          STATE.turn.doublesCount = prevCount + 1;
        } else {
          STATE.turn.doublesBy = by;
          STATE.turn.doublesCount = 1;
        }

        const count = STATE.turn.doublesCount|0;
        if (count >= 3) {
          const to = 10;
          const from = STATE.playerPos[by] | 0;
          STATE.playerPos[by] = to; STATE.inJail[by] = true; STATE.jailTries[by] = 0;
          dbg("dice:triple-double:jail", { by, from, to });
          touchState();
          broadcast({ type:"playerPos", data: [...STATE.playerPos] });
          STATE.turn.doublesBy = -1;
          STATE.turn.doublesCount = 0;
          nextEnabledActive(1);
          STATE.turn.rev = (STATE.turn.rev|0)+1;
          touchState();
          broadcast({ type:"turn", data: { ...STATE.turn, order:[...STATE.turn.order] } });
          return;
        } else {
          if (autoMove) {
            const cur = STATE.playerPos[by] | 0;
            const raw = cur + a + b;
            let to = clampPos(raw);
            if (raw >= 40) { credit(by, 200); }
            if (to === 30) { to = 10; STATE.inJail[by] = true; STATE.jailTries[by] = 0; }
            STATE.playerPos[by] = to;
            if (to === 4) debit(by, 200); else if (to === 38) debit(by, 100);
            dbg("autoMove", { by, from:cur, to:STATE.playerPos[by] });
            touchState();
            broadcast({ type:"playerPos", data: [...STATE.playerPos] });
            maybeDrawLanding(by);
          }
          STATE.turn.rev = (STATE.turn.rev|0)+1; // keep same active on doubles
          touchState();
          broadcast({ type:"turn", data: { ...STATE.turn, order:[...STATE.turn.order] } });
          return;
        }
      }

      // Not a double
      if (autoMove) {
        const cur = STATE.playerPos[by] | 0;
        const raw = cur + a + b;
        let to = clampPos(raw);
        if (raw >= 40) { credit(by, 200); }
        if (to === 30) { to = 10; STATE.inJail[by] = true; STATE.jailTries[by] = 0; }
        STATE.playerPos[by] = to;
        if (to === 4) debit(by, 200); else if (to === 38) debit(by, 100);
        dbg("autoMove", { by, from:cur, to:STATE.playerPos[by] });
        touchState();
        broadcast({ type:"playerPos", data: [...STATE.playerPos] });
        maybeDrawLanding(by);
      }
      STATE.turn.doublesBy = -1;
      STATE.turn.doublesCount = 0;
      nextEnabledActive(1);
      STATE.turn.rev = (STATE.turn.rev|0)+1;
      dbg("turn:auto-advance", { active:STATE.turn.active, order:STATE.turn.order });
      touchState();
      broadcast({ type:"turn", data: { ...STATE.turn, order:[...STATE.turn.order] } });
      return;
    }

    // Reset
    if (t === "resetAll") {
      if (ws._role !== "gm") { send(ws, { type:"debug", level:"warn", msg:"Only GM may reset state" }); return; }
      const nextEpoch = (STATE.nameEpoch|0)+1;
      STATE.nameEpoch = nextEpoch;
      STATE.playerNames = ["P1","P2","P3","P4","P5","P6"];
      STATE.playerPos   = [0,0,0,0,0,0];
      STATE.properties  = Array.from({length:28}, () => ({ owner:0, houses:0, hotel:0 }));
      STATE.dice = { a:0, b:0, by:-1, at:0, seq:0 };
      STATE.turn = { order:[0,1,2,3,4,5], active:0, rev:1, doublesBy:-1, doublesCount:0 };
      STATE.money  = [1500,1500,1500,1500,1500,1500];
      STATE.inJail = [false,false,false,false,false,false];
      STATE.jailTries = [0,0,0,0,0,0];
      STATE.enabled = [true,true,true,true,true,true];
      STATE.debugForceDoubles = false;
      STATE.cards = initCards();
      STATE.schemaVersion = SCHEMA_VERSION;
      dbg("resetAll");
      touchState();
      broadcast({ type:"state", payload: buildPatchPayload() });
      return;
    }
  });

  ws.on("close", () => dbg("ws:close", { addr: remoteAddr, role: ws._role, idx: ws._idx }));
});

/* simple health */
app.get("/health", (_req, res) => res.json({ ok:true }));

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => console.log(`http://localhost:${PORT}`));
