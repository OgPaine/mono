// Simple audit trail with optional broadcast and persist hooks

const AUDIT_LOG_MAX = 300;
const AUDIT_LOG = [];
let AUDIT_SEQ = 1;

export const SYSTEM_ACTOR = Object.freeze({ role: "system", idx: -1, session: null, addr: null });

let broadcastHook = null;
let persistHook = null;

export function configureAudit({ onBroadcast = null, onPersist = null } = {}){
  broadcastHook = typeof onBroadcast === 'function' ? onBroadcast : null;
  persistHook = typeof onPersist === 'function' ? onPersist : null;
}

export function sanitizePayload(payload){
  if (payload == null) return null;
  if (typeof payload === "object"){
    try { return JSON.parse(JSON.stringify(payload)); }
    catch { return { summary: String(payload) }; }
  }
  if (typeof payload === "string" || typeof payload === "number" || typeof payload === "boolean") return payload;
  return String(payload);
}

export function normalizeActor(raw){
  if (!raw || typeof raw !== "object") return { ...SYSTEM_ACTOR };
  const role = typeof raw.role === "string" ? raw.role : "viewer";
  const idx = Number.isFinite(raw.idx) ? Math.trunc(raw.idx) : -1;
  const session = raw.session ? String(raw.session) : null;
  const addr = raw.addr ? String(raw.addr) : null;
  const label = raw.label ? String(raw.label) : null;
  return { role, idx, session, addr, label };
}

export function actorFromWS(ws){
  if (!ws || typeof ws !== "object") return { ...SYSTEM_ACTOR };
  return normalizeActor({
    role: typeof ws._role === "string" ? ws._role : "viewer",
    idx: Number.isFinite(ws._idx) ? Math.trunc(ws._idx) : -1,
    session: ws._sessionId || null,
    addr: ws._remoteAddr || null,
  });
}

export function deriveActorFromPayload(payload){
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

function now() { return new Date().toISOString().replace("T"," ").replace("Z",""); }

function pushAuditEntry(entry){
  if (!entry) return;
  AUDIT_LOG.push(entry);
  if (AUDIT_LOG.length > AUDIT_LOG_MAX) AUDIT_LOG.splice(0, AUDIT_LOG.length - AUDIT_LOG_MAX);
}

export function recordAudit(tag, payload, actor, options = {}){
  const entry = {
    id: AUDIT_SEQ++,
    at: now(),
    tag: String(tag || ""),
    payload: sanitizePayload(payload),
    actor: actor ? normalizeActor(actor) : { ...SYSTEM_ACTOR },
  };
  pushAuditEntry(entry);
  if (options.persist !== false && typeof persistHook === 'function') try { persistHook([entry]); } catch {}
  if (options.broadcast !== false && typeof broadcastHook === 'function') try { broadcastHook([entry]); } catch {}
  return entry;
}

export function exportAuditLog(){
  return AUDIT_LOG.map(entry => ({ id: entry.id, at: entry.at, tag: entry.tag, payload: entry.payload, actor: entry.actor ? normalizeActor(entry.actor) : { ...SYSTEM_ACTOR } }));
}

