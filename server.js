import express from "express";
import http from "http";
import 'dotenv/config';
import path from "path";
import { fileURLToPath } from "url";

import { STATE, SCHEMA_VERSION, clamp, clampPos, uniqPlayers, bankHousesAvailable, bankHotelsAvailable, nextEnabledActive, setOrderKeepEnabled, applyPropertyPatchByRules } from "./src/state.js";
import { initCards, maybeChargeRent, maybeDrawLanding, drawCard as rulesDrawCard, applyCardEffect, handleJailRoll } from "./src/rules.js";
import { configurePaths, loadStateFromDisk, scheduleSave, exportState } from "./src/persistence.js";
import { createWSS } from "./src/transport.js";
import { configureAudit, recordAudit, exportAuditLog, actorFromWS as auditActorFromWS, SYSTEM_ACTOR } from "./src/audit.js";
import { SESSION_COOKIE, ensureSession as authEnsureSession, resolveSession as authResolveSession, parseCookies as authParseCookies, gmLoginGuard, gmLoginRecord, cookieOptions as authCookieOptions } from "./src/auth.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PUBLIC_DIR = path.join(__dirname, "public");
const GM_PASSWORD = process.env.GM_PASSWORD || "";
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "").split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
const WS_MAX_PAYLOAD = Math.max(1024, parseInt(process.env.WS_MAX_PAYLOAD || "8192", 10));
const WS_RATE_CAP = Math.max(10, parseInt(process.env.WS_RATE_CAP || "40", 10));
const WS_RATE_REFILL_MS = Math.max(250, parseInt(process.env.WS_RATE_REFILL_MS || "5000", 10));
const WS_RATE_REFILL_COUNT = Math.max(5, parseInt(process.env.WS_RATE_REFILL_COUNT || "20", 10));
const SESSION_TTL_MINUTES = Math.max(5, parseInt(process.env.SESSION_TTL_MINUTES || process.env.SESSION_MINUTES || "120", 10));
const SESSION_TTL_MS = 1000 * 60 * SESSION_TTL_MINUTES;

// Init state & persistence
STATE.cards = initCards();
configurePaths(__dirname);
try { loadStateFromDisk(); } catch (e) { console.warn("[state] failed to load persisted state", e?.message || e); }
STATE.schemaVersion = SCHEMA_VERSION;

const app = express();
if ((process.env.TRUST_PROXY || "1") !== "0") app.set("trust proxy", true);
app.use(express.json({ limit: "32kb" }));

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

function touchState(){ STATE.stateRev = Math.max((STATE.stateRev|0)+1, 1); scheduleSave(); }

// Routes
function isSecureRequest(req){
  try { if (req.secure) return true; const xf = String(req.headers["x-forwarded-proto"] || req.headers["x-forwarded-protocol"] || "").toLowerCase(); if (xf) { const first = xf.split(",")[0].trim(); if (first === "https") return true; } } catch {}
  return false;
}
function cookieOptions(req){ return authCookieOptions(req, SESSION_TTL_MS); }

function sendStaticFile(res, file) { res.sendFile(path.join(PUBLIC_DIR, file)); }

app.get("/", (req, res) => { authEnsureSession(req, res, "viewer", -1, { ttlMs: SESSION_TTL_MS }); res.redirect(302, "/player.html"); });
app.get("/index.html", (req, res) => { authEnsureSession(req, res, "viewer", -1, { ttlMs: SESSION_TTL_MS }); res.redirect(302, "/gm"); });
app.get("/gm", (req, res) => { const s = authResolveSession(req, SESSION_TTL_MS); if (s.role !== "gm") return res.redirect(302, "/gm-login.html"); sendStaticFile(res, "index.html"); });
app.get("/player.html", (req, res) => { sendStaticFile(res, "player.html"); });

const GM_LOCK_WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const GM_MAX_ATTEMPTS = 3;

app.post("/auth/gm-login", (req, res) => {
  const ip = req.socket.remoteAddress || "?";
  const guard = gmLoginGuard(ip, GM_MAX_ATTEMPTS, GM_LOCK_WINDOW_MS);
  if (!guard.ok) return res.status(429).json({ ok:false, locked:true, remainingMs: guard.remainingMs });
  if (!GM_PASSWORD) return res.status(500).json({ ok:false, msg: "GM password not configured" });
  const password = String(req.body?.password || "");
  if (password === GM_PASSWORD) {
    authEnsureSession(req, res, "gm", -1, { ttlMs: SESSION_TTL_MS, forceRotate: true });
    gmLoginRecord(ip, true, GM_MAX_ATTEMPTS, GM_LOCK_WINDOW_MS);
    recordAudit('auth:gm-login', { ip }, SYSTEM_ACTOR);
    return res.json({ ok:true });
  }
  const rec = gmLoginRecord(ip, false, GM_MAX_ATTEMPTS, GM_LOCK_WINDOW_MS);
  if (rec.locked) return res.status(429).json({ ok:false, locked:true, remainingMs: GM_LOCK_WINDOW_MS });
  return res.status(401).json({ ok:false, attemptsLeft: rec.attemptsLeft ?? 0 });
});

app.post("/auth/logout", (req, res) => {
  try {
    // Expire cookie client-side (sessions are ephemeral in module)
    res.cookie(SESSION_COOKIE, "", { ...cookieOptions(req), maxAge: 0, expires: new Date(0) });
  } catch {}
  recordAudit('auth:logout', null, SYSTEM_ACTOR);
  return res.json({ ok: true });
});

app.use(express.static(PUBLIC_DIR));

// HTTP + WS
const server = http.createServer(app);
const { wss, broadcast: _broadcast, send: _send } = createWSS(server, { path: "/ws", maxPayload: WS_MAX_PAYLOAD, allowedOrigins: ALLOWED_ORIGINS, heartbeatMs: 30_000 });

function broadcast(obj){ _broadcast(withMeta(obj)); }
function send(ws, obj){ _send(ws, withMeta(obj)); }

// Wire audit broadcast and persistence
configureAudit({
  onBroadcast: (entries) => {
    try {
      for (const c of wss.clients) {
        if (c && c.readyState === 1 && c._role === 'gm') {
          send(c, { type: 'audit', data: entries });
        }
      }
    } catch {}
  },
  onPersist: () => scheduleSave(),
});

function buildPatchPayload(){
  const names = Array.from({ length: 6 }, (_, i) => String(STATE.playerNames?.[i] ?? `P${i+1}`).slice(0, 18));
  const positions = Array.from({ length: 6 }, (_, i) => clampPos(STATE.playerPos?.[i] ?? 0));
  const properties = Array.from({ length: STATE.properties.length }, (_, i) => { const p = STATE.properties?.[i] ?? {}; const hotel = (p.hotel ?? 0) ? 1 : 0; return { owner: clamp(p.owner ?? 0, 0, 6), houses: hotel ? 0 : clamp(p.houses ?? 0, 0, 4), hotel }; });
  const dice = { a: STATE.dice?.a|0, b: STATE.dice?.b|0, by: (STATE.dice?.by ?? -1)|0, at: STATE.dice?.at|0, seq: STATE.dice?.seq|0 };
  const order = Array.isArray(STATE.turn?.order) ? uniqPlayers(STATE.turn.order) : [0,1,2,3,4,5];
  const activeMax = Math.max(0, order.length - 1);
  const turn = { order, active: clamp(STATE.turn?.active ?? 0, 0, activeMax), rev: STATE.turn?.rev|0, doublesBy: clamp(STATE.turn?.doublesBy ?? -1, -1, 5), doublesCount: clamp(STATE.turn?.doublesCount ?? 0, 0, 10) };
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
    cardsLast: cardsLast ? { deck: String(cardsLast.deck ?? ''), id: String(cardsLast.id ?? ''), text: String(cardsLast.text ?? ''), by: clamp(cardsLast.by ?? -1, -1, 5), at: cardsLast.at|0, action: cardsLast.action ? String(cardsLast.action) : '' } : null,
    cardsHolding: { chanceGOJ: clamp(STATE.cards?.chance?.gojHolder ?? -1, -1, 5), chestGOJ: clamp(STATE.cards?.chest?.gojHolder ?? -1, -1, 5) },
  };
}
function broadcastPatch(){ broadcast({ type: "patch", payload: buildPatchPayload() }); }

// Audit export (GM only)
app.get('/api/audit', (req, res) => {
  const s = authResolveSession(req, SESSION_TTL_MS);
  if (s.role !== 'gm') return res.status(403).json({ ok:false });
  res.json({ ok:true, data: exportAuditLog() });
});

// Money helpers
function credit(player, amt){ const i = clamp(player, 0, 5); STATE.money[i] = (STATE.money[i]|0) + (amt|0); dbg("money:credit", { i, delta: amt, balance: STATE.money[i] }); recordAudit('money:credit', { i, delta: amt, balance: STATE.money[i] }, SYSTEM_ACTOR); touchState(); broadcast({ type:"money", data: [...STATE.money] }); }
function debit(player, amt){ credit(player, -(amt|0)); }

// WS connections
wss.on("connection", (ws, req) => {
  const session = authResolveSession(req, SESSION_TTL_MS);
  ws._remoteAddr = req.socket?.remoteAddress || null;
  ws._role = session.role; ws._idx = session.idx; ws._sessionId = session.id;
  ws._rlTokens = WS_RATE_CAP; ws._rlLastRefill = Date.now();
  dbg("ws:connect", { role: ws._role, idx: ws._idx, session: ws._sessionId });

  send(ws, { type:"state", payload: buildPatchPayload() });
  send(ws, { type:"role", data: { role: ws._role, idx: ws._idx } });
  if (ws._role === 'gm') send(ws, { type:'audit', data: exportAuditLog() });

  ws.on("message", (raw) => {
    // Rate limit
    try {
      const size = Buffer.isBuffer(raw) ? raw.length : Buffer.byteLength(String(raw||""));
      if (size > WS_MAX_PAYLOAD) { try { ws.close(1009, "Message too large"); } catch {}; return; }
    } catch {}
    const nowMs = Date.now();
    const elapsed = nowMs - (ws._rlLastRefill || nowMs);
    if (elapsed >= WS_RATE_REFILL_MS) { const steps = Math.floor(elapsed / WS_RATE_REFILL_MS); ws._rlTokens = Math.min(WS_RATE_CAP, (ws._rlTokens|0) + steps * WS_RATE_REFILL_COUNT); ws._rlLastRefill = (ws._rlLastRefill || nowMs) + steps * WS_RATE_REFILL_MS; }
    if ((ws._rlTokens|0) <= 0) { try { ws.close(1008, "Rate limit exceeded"); } catch {}; return; }
    ws._rlTokens = (ws._rlTokens|0) - 1;

    let msg = null; try { msg = JSON.parse(raw); } catch { return; }
    const t = String(msg?.type || "");
    const msgRev = Number.isFinite(Number(msg.stateRev)) ? Math.trunc(Number(msg.stateRev)) : null;
    const schemaNum = Number(msg.schemaVersion);
    if (!Number.isFinite(schemaNum) || schemaNum !== SCHEMA_VERSION) { send(ws, { type:"debug", level:"error", msg:"Client schema mismatch. Refresh required.", data:{ expected: SCHEMA_VERSION, got: msg.schemaVersion ?? null } }); return; }
    if (msgRev === null){ send(ws, { type:"debug", level:"warn", msg:"Missing stateRev. Refresh client." }); return; }
    if (msgRev !== (STATE.stateRev|0)){ send(ws, { type:"debug", level:"warn", msg:"Out-of-sync stateRev. Refresh or retry.", data:{ expected: STATE.stateRev|0, got: msgRev } }); return; }

    // Hello / role negotiation
    if (t === "hello"){
      const role = (String(msg.role||'viewer')).toLowerCase();
      const idx = Number.isFinite(Number(msg.idx)) ? Math.trunc(Number(msg.idx)) : -1;
      if (role === 'gm') { const s = authResolveSession(req, SESSION_TTL_MS); if (s.role !== 'gm') { send(ws, { type:"debug", level:"warn", msg:"Not authorized as GM" }); return; } ws._role='gm'; ws._idx=-1; }
      else if (role === 'player' && idx>=0 && idx<6) { ws._role='player'; ws._idx=idx; }
      else { ws._role='viewer'; ws._idx=-1; }
      send(ws, { type:"role", data: { role: ws._role, idx: ws._idx } });
      return;
    }

    // Names
    if (t === "setPlayerName"){
      if (ws._role !== 'gm' && ws._role !== 'player') { send(ws, { type:"debug", level:"warn", msg:"Unauthorized to rename players" }); return; }
      const idx = Number.isFinite(Number(msg.index)) ? Math.trunc(Number(msg.index)) : -1; if (!(idx >= 0 && idx < 6)) { send(ws, { type:"debug", level:"warn", msg:"Invalid player index", data:{ index: msg.index } }); return; }
      if (ws._role === 'player' && ws._idx !== idx) { send(ws, { type:"debug", level:"warn", msg:"Players may only rename themselves" }); return; }
      const nameRaw = typeof msg.name === "string" ? msg.name : ""; const nextName = (nameRaw.trim() || `P${idx+1}`).slice(0, 18);
      if (STATE.playerNames[idx] === nextName) return; STATE.playerNames[idx] = nextName; touchState(); broadcast({ type:"playerNames", data: [...STATE.playerNames] }); recordAudit('player:name', { idx, name: nextName }, auditActorFromWS(ws)); broadcastPatch(); return;
    }

    // Positions
    if (t === "setPlayerPos"){
      if (ws._role !== 'gm') { send(ws, { type:"debug", level:"warn", msg:"Only GM may set positions" }); return; }
      const idx = Number.isFinite(Number(msg.index)) ? Math.trunc(Number(msg.index)) : -1; if (!(idx >= 0 && idx < 6)) { send(ws, { type:"debug", level:"warn", msg:"Invalid player index", data:{ index: msg.index } }); return; }
      const pos = clampPos(Number(msg.pos)); STATE.playerPos[idx] = pos; touchState(); broadcast({ type:"playerPos", data: [...STATE.playerPos] }); recordAudit('player:pos', { idx, pos }, auditActorFromWS(ws)); broadcastPatch(); return;
    }

    // Property update
    if (t === "updateProperty"){
      if (ws._role !== 'gm') { send(ws, { type:"debug", level:"warn", msg:"Only GM may update properties" }); return; }
      const idx = Number.isFinite(Number(msg.index)) ? Math.trunc(Number(msg.index)) : -1; if (!(idx >= 0 && idx < STATE.properties.length)) { send(ws, { type:"debug", level:"warn", msg:"Invalid property index", data:{ index: msg.index } }); return; }
      const prior = { ...STATE.properties[idx] };
      const patch = (msg && typeof msg.patch === "object") ? msg.patch : {};
      const messages = applyPropertyPatchByRules(STATE, idx, patch, { debitFn: debit });
      if (messages.length) send(ws, { type:"debug", level:"info", msg: messages[0] });
      if (JSON.stringify(prior) !== JSON.stringify(STATE.properties[idx])){ touchState(); broadcast({ type:"property", index:idx, data: { ...STATE.properties[idx] } }); recordAudit('property:update', { index: idx, before: prior, after: STATE.properties[idx] }, auditActorFromWS(ws)); broadcastPatch(); }
      return;
    }

    // Enable/disable player
    if (t === "player:enabled"){
      if (ws._role !== 'gm') { send(ws, { type:"debug", level:"warn", msg:"Only GM may enable/disable players" }); return; }
      const idx = Number.isFinite(Number(msg.index)) ? Math.trunc(Number(msg.index)) : -1; if (!(idx >= 0 && idx < 6)) { send(ws, { type:"debug", level:"warn", msg:"Invalid player index", data:{ index: msg.index } }); return; }
      const val = !!msg.enabled; if (STATE.enabled[idx] === val) return; STATE.enabled[idx] = val; touchState(); recordAudit('player:enabled', { idx, enabled: val }, auditActorFromWS(ws)); broadcastPatch(); return;
    }

    // Turn controls
    if (t === "turn:setOrder"){
      if (ws._role !== 'gm') { send(ws, { type:"debug", level:"warn", msg:"Only GM may set order" }); return; }
      const ord = Array.isArray(msg.order) ? msg.order : []; setOrderKeepEnabled(STATE, ord); touchState(); broadcast({ type:"turn", data: { ...STATE.turn, order:[...STATE.turn.order] } }); recordAudit('turn:setOrder', { order: STATE.turn.order }, auditActorFromWS(ws)); broadcastPatch(); return;
    }
    if (t === "turn:setActive"){
      if (ws._role !== 'gm') { send(ws, { type:"debug", level:"warn", msg:"Only GM may set active turn" }); return; }
      const L = STATE.turn.order.length; if (!L) return; STATE.turn.active = clamp(msg.index, 0, L-1); STATE.turn.rev = (STATE.turn.rev|0)+1; STATE.turn.doublesBy = -1; STATE.turn.doublesCount = 0; touchState(); broadcast({ type:"turn", data: { ...STATE.turn, order:[...STATE.turn.order] } }); recordAudit('turn:setActive', { active: STATE.turn.active }, auditActorFromWS(ws)); broadcastPatch(); return;
    }
    if (t === "turn:next"){
      if (ws._role !== 'gm') { send(ws, { type:"debug", level:"warn", msg:"Only GM may advance turn" }); return; }
      nextEnabledActive(STATE, msg.delta|0 || 1); STATE.turn.rev = (STATE.turn.rev|0)+1; STATE.turn.doublesBy = -1; STATE.turn.doublesCount = 0; touchState(); broadcast({ type:"turn", data: { ...STATE.turn, order:[...STATE.turn.order] } }); recordAudit('turn:next', { active: STATE.turn.active, order: STATE.turn.order }, auditActorFromWS(ws)); broadcastPatch(); return;
    }

    // Dice roll
    if (t === "rollDice"){
      if (ws._role !== 'gm' && ws._role !== 'player') { send(ws, { type:"debug", level:"warn", msg:"Unauthorized to roll dice" }); return; }
      let byRaw = Number.isFinite(Number(msg.by)) ? Math.trunc(Number(msg.by)) : -1; if (ws._role === 'player') byRaw = ws._idx|0; if (!(byRaw >= 0 && byRaw < 6)) { send(ws, { type:"debug", level:"warn", msg:"Invalid roller index", data:{ index: msg.by } }); return; }
      let by = clamp(byRaw, 0, 5); const requireTurn = !!msg.requireTurn; const autoMove = !!msg.autoMove;
      const L = STATE.turn.order.length; const activePlayer = L ? (STATE.turn.order[STATE.turn.active]|0) : by;
      if (requireTurn) { const isGM = ws._role === 'gm'; const isActivePlayerClient = (ws._role === 'player' && ws._idx === activePlayer && by === ws._idx); if (!isGM && !isActivePlayerClient){ send(ws, { type:"debug", level:"warn", msg:"Not authorized to roll", data:{ by, activePlayer } }); return; } by = activePlayer; } else if (ws._role === 'player' && ws._idx !== by) { by = ws._idx|0; }
      let a = 1 + Math.floor(Math.random()*6); let b = 1 + Math.floor(Math.random()*6); if (STATE.debugForceDoubles){ const v = 1 + Math.floor(Math.random()*6); a=v; b=v; }
      const seq = (STATE.dice.seq|0) + 1; STATE.dice = { a, b, by, at: Date.now(), seq }; const isDouble = (a === b); touchState(); broadcast({ type:"dice", data: STATE.dice }); recordAudit('dice:roll', { a, b, by, seq, isDouble }, auditActorFromWS(ws));

      // Jail handling + move + landing
      const jail = handleJailRoll(by, a, b, { autoMove, credit, debit, afterMove: (p) => maybeDrawLanding(p, { dice: { a, b } }, { credit, debit, dbg }) });
      if (!jail.wasInJail || jail.moved){ STATE.turn.doublesBy = -1; STATE.turn.doublesCount = 0; nextEnabledActive(STATE, 1); STATE.turn.rev = (STATE.turn.rev|0)+1; touchState(); broadcast({ type:"turn", data: { ...STATE.turn, order:[...STATE.turn.order] } }); recordAudit('turn:jail-exit-or-auto', { by }, auditActorFromWS(ws)); return; }

      // Normal move
      const cur = STATE.playerPos[by] | 0; const raw = cur + a + b; let to = clampPos(raw); if (raw >= 40) credit(by, 200); if (to === 30) { to = 10; STATE.inJail[by]=true; STATE.jailTries[by]=0; }
      STATE.playerPos[by] = to; if (to === 4) debit(by, 200); else if (to === 38) debit(by, 100); touchState(); broadcast({ type:"playerPos", data: [...STATE.playerPos] }); maybeDrawLanding(by, { dice: { a, b } }, { credit, debit, dbg });
      if (isDouble){ STATE.turn.doublesBy = by; STATE.turn.doublesCount = (STATE.turn.doublesCount|0) + 1; if ((STATE.turn.doublesCount|0) >= 3){ STATE.playerPos[by]=10; STATE.inJail[by]=true; STATE.jailTries[by]=0; STATE.turn.doublesBy=-1; STATE.turn.doublesCount=0; touchState(); broadcast({ type:"playerPos", data: [...STATE.playerPos] }); recordAudit('turn:three-doubles-to-jail', { by }, auditActorFromWS(ws)); }
      } else { STATE.turn.doublesBy = -1; STATE.turn.doublesCount = 0; nextEnabledActive(STATE, 1); }
      STATE.turn.rev = (STATE.turn.rev|0)+1; touchState(); broadcast({ type:"turn", data: { ...STATE.turn, order:[...STATE.turn.order] } }); recordAudit('turn:advance', { active: STATE.turn.active }, auditActorFromWS(ws));
      return;
    }

    // Debug toggle
    if (t === "debug:forceDoubles"){
      if (ws._role !== 'gm') { send(ws, { type:"debug", level:"warn", msg:"Only GM may set debug" }); return; }
      STATE.debugForceDoubles = !!msg.value; touchState(); broadcast({ type:"debug", data: { forceDoubles: !!STATE.debugForceDoubles } }); recordAudit('debug:forceDoubles', { value: !!STATE.debugForceDoubles }, auditActorFromWS(ws)); broadcastPatch(); return;
    }

    // Card actions (GM)
    if (t === "cards:draw"){
      if (ws._role !== 'gm') { send(ws, { type:"debug", level:"warn", msg:"Only GM may draw cards" }); return; }
      const deck = (String(msg.deck||'chance').toLowerCase()==='chest') ? 'chest' : 'chance';
      const by = Number.isFinite(Number(msg.by)) ? clamp(Math.trunc(Number(msg.by)), 0, 5) : 0;
      const result = rulesDrawCard(deck, by, { credit, debit, dbg, afterMove: (p)=> maybeDrawLanding(p, { card: 'draw' }, { credit, debit, dbg }) });
      touchState(); if (result) { broadcast({ type:"cards:drawn", data: result }); recordAudit('cards:drawn', result, auditActorFromWS(ws)); broadcastPatch(); } return;
    }

    // Fallback
    send(ws, { type:"debug", level:"warn", msg:`Unknown message type: ${t}` });
  });
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => { dbg("server:listening", { port: PORT }); });
