import crypto from "crypto";

export const SESSION_COOKIE = "monoSession";

const sessions = new Map();

export function parseCookies(header = "") {
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

export function normalizeSession(role, idx) {
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

function isSecureRequest(req){
  try {
    if (req.secure) return true;
    const xf = String(req.headers["x-forwarded-proto"] || req.headers["x-forwarded-protocol"] || "").toLowerCase();
    if (xf) {
      const first = xf.split(",")[0].trim();
      if (first === "https") return true;
    }
  } catch {}
  return false;
}

export function cookieOptions(req, sessionTtlMs){
  return {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: sessionTtlMs,
    secure: isSecureRequest(req),
  };
}

export function ensureSession(req, res, wantedRole, idx, { ttlMs, forceRotate = false } = {}){
  const normalized = normalizeSession(wantedRole, idx);
  const cookies = parseCookies(req.headers?.cookie || "");
  const existingId = cookies[SESSION_COOKIE];
  const now = Date.now();
  let prior = null;
  if (existingId) {
    prior = sessions.get(existingId) || null;
    if (prior) {
      const touched = prior.touchedAt ?? prior.createdAt ?? now;
      if ((now - touched) > ttlMs) {
        sessions.delete(existingId);
        prior = null;
      }
    }
  }
  const rotateNeeded = !!(prior && (forceRotate || prior.role !== normalized.role || prior.idx !== normalized.idx));
  if (rotateNeeded && prior) sessions.delete(prior.id);
  const entry = rotateNeeded || !prior ? {
    id: crypto.randomUUID(), role: normalized.role, idx: normalized.idx, createdAt: now, touchedAt: now,
  } : { ...prior, role: normalized.role, idx: normalized.idx, touchedAt: now };
  sessions.set(entry.id, entry);
  if (res) res.cookie(SESSION_COOKIE, entry.id, cookieOptions(req, ttlMs));
  return entry;
}

export function resolveSession(req, ttlMs){
  const cookies = parseCookies(req.headers?.cookie || "");
  const id = cookies[SESSION_COOKIE];
  if (!id) return { id: null, role: "viewer", idx: -1 };
  const entry = sessions.get(id);
  if (!entry) return { id: null, role: "viewer", idx: -1 };
  const now = Date.now();
  if ((now - (entry.touchedAt ?? entry.createdAt ?? now)) > ttlMs) {
    sessions.delete(id);
    return { id: null, role: "viewer", idx: -1 };
  }
  entry.touchedAt = now;
  return { id, role: entry.role, idx: entry.idx };
}

// Basic GM login throttle
const loginAttempts = new Map();
export function gmLoginGuard(ip, maxAttempts, lockWindowMs){
  const nowMs = Date.now();
  const ent = loginAttempts.get(ip) || { fails: 0, lockedUntil: 0 };
  if (ent.lockedUntil && nowMs < ent.lockedUntil) {
    return { ok:false, locked:true, remainingMs: ent.lockedUntil - nowMs };
  }
  return { ok:true, entry: ent };
}
export function gmLoginRecord(ip, success, maxAttempts, lockWindowMs){
  const nowMs = Date.now();
  const ent = loginAttempts.get(ip) || { fails: 0, lockedUntil: 0 };
  if (success) { loginAttempts.delete(ip); return { ok:true }; }
  ent.fails = (ent.fails|0) + 1;
  if (ent.fails >= (maxAttempts|0)) {
    ent.lockedUntil = nowMs + (lockWindowMs|0);
    ent.fails = 0;
    loginAttempts.set(ip, ent);
    return { ok:false, locked:true, remainingMs: lockWindowMs };
  }
  loginAttempts.set(ip, ent);
  return { ok:false, attemptsLeft: Math.max(0, (maxAttempts|0) - ent.fails) };
}

