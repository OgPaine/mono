// server/index.js
import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import express from 'express';
import { WebSocketServer } from 'ws';
import { Low } from 'lowdb';
import { JSONFile } from 'lowdb/node';
import fs from 'node:fs';

import {
  BOARD,
  CHANCE_CARDS,
  CHEST_CARDS,
  RR_RENTS,
  UTIL_MULT,
  HOUSE_COST_BY_GROUP
} from '../shared/props-data.js';

import {
  groupMap,
  streetRent,
  moveTo as engineMoveTo,
  buildHouse as engineBuildHouse,
  sellHouse as engineSellHouse,
  mortgage as engineMortgage,
  applyCard as engineApplyCard,
  declareBankrupt as engineDeclareBankrupt,
  estimateLiquidation
} from './engine.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

/* ------------ Static files ------------ */

app.use('/images', express.static(path.join(__dirname, '..', 'public', 'images')));
app.use('/styles', express.static(path.join(__dirname, '..', 'styles')));
app.use('/shared', express.static(path.join(__dirname, '..', 'shared')));
app.use(express.static(path.join(__dirname, '..', 'public'))); // board.html, etc.

/* ------------ Routes ------------ */

app.get('/', (_req, res) =>
  res.redirect('/player.html?p=0&g=default')
);
app.get('/player.html', (_req, res) =>
  res.sendFile(path.join(__dirname, '..', 'public', 'player.html'))
);
app.get('/gm.html', (_req, res) =>
  res.sendFile(path.join(__dirname, '..', 'public', 'gm.html'))
);
app.get('/lobby.html', (_req, res) =>
  res.sendFile(path.join(__dirname, '..', 'public', 'lobby.html'))
);
app.get('/spectator.html', (_req, res) =>
  res.sendFile(path.join(__dirname, '..', 'public', 'spectator.html'))
);

/* ------------ Debug endpoints ------------ */
app.get('/debug', (_req, res) => {
  try {
    const gamesArr = [];
    games.forEach((game, id) => {
      const st = game.state;
      const last = lastWire.get(id) || null;
      const patches = patchesBuf.get(id) || [];
      const evs = eventsBuf.get(id) || [];
      // connection summary per game
      let sockets = 0, gms = 0, specs = 0, players = 0;
      wss.clients.forEach(ws => {
        if (ws.readyState === 1 && ws.gameId === id) {
          sockets++;
          if (ws.isGM) gms++; else if (ws.pid == null) specs++; else players++;
        }
      });
      gamesArr.push({
        id,
        rev: st?.rev|0,
        turn: st?.turn|0,
        lastWireRev: last?.rev|0 || null,
        patches: { lastId: (patchSeq.get(id)|0)||0, count: patches.length },
        events: { lastId: (eventSeq.get(id)|0)||0, count: evs.length },
        historyCount: (history.get(id)||[]).length,
        sockets: { total: sockets, gms, specs, players }
      });
    });
    res.json({ version: PROTOCOL_VERSION, games: gamesArr });
  } catch (e) {
    res.status(500).json({ error: String(e && e.message || e) });
  }
});

app.get('/debug/:gameId', (req, res) => {
  try {
    const id = String(req.params.gameId||'default');
    const game = games.get(id);
    if (!game) return res.status(404).json({ error: 'not_found' });
    const st = game.state;
    const last = lastWire.get(id) || null;
    const patches = patchesBuf.get(id) || [];
    const evs = eventsBuf.get(id) || [];
    const hist = history.get(id) || [];
    let sockets = 0, gms = 0, specs = 0, players = 0;
    wss.clients.forEach(ws => {
      if (ws.readyState === 1 && ws.gameId === id) {
        sockets++;
        if (ws.isGM) gms++; else if (ws.pid == null) specs++; else players++;
      }
    });
    res.json({
      version: PROTOCOL_VERSION,
      id,
      rev: st?.rev|0,
      lastWire: last,
      patches: { lastId: (patchSeq.get(id)|0)||0, count: patches.length, recent: patches.slice(-5) },
      events: { lastId: (eventSeq.get(id)|0)||0, count: evs.length, recent: evs.slice(-10) },
      historyCount: hist.length,
      sockets: { total: sockets, gms, specs, players }
    });
  } catch (e) {
    res.status(500).json({ error: String(e && e.message || e) });
  }
});

/* ------------ Constants ------------ */

const now = () => new Date().toISOString();
const PROTOCOL_VERSION = 2;
const GM_TOKEN = process.env.GM_TOKEN || '';

/* ------------ Logging ------------ */
const LOG_LEVEL = String(process.env.LOG_LEVEL || 'info').toLowerCase();
const LOGS = { error: 0, warn: 1, info: 2, debug: 3, trace: 4 };
const lvlNum = LOGS[LOG_LEVEL] ?? 2;
const shouldLog = lvl => (LOGS[lvl] ?? 2) <= lvlNum;
const log = (lvl, msg, meta = undefined) => {
  if (!shouldLog(lvl)) return;
  try {
    const base = { ts: new Date().toISOString(), lvl, msg };
    console.log(JSON.stringify(meta ? { ...base, ...meta } : base));
  } catch {
    console.log(`[${lvl}] ${msg}`);
  }
};

const DATA_DIR = path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const clampPos = v => ((v % 40) + 40) % 40;

const shuffle = arr => {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = (Math.random() * (i + 1)) | 0;
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

const isBuyable = s =>
  s && (s.kind === 'street' || s.kind === 'rr' || s.kind === 'util');

const INITIAL_CASH = 1500;
const COLORS = ['#ef4444', '#22c55e', '#3b82f6', '#f59e0b', '#a855f7', '#14b8a6'];

/* ------------ In-memory state ------------ */

const games = new Map();
const dbs = new Map();
const saveTimers = new Map();

/* ------------ State factory ------------ */

const createInitialState = () => ({
  rev: 0,
  turn: 0,
  rollBlocked: false,
  phase: 'awaitRoll',
  debugNextRoll: null,
  bank: { houses: 32, hotels: 12 },
  players: Array.from({ length: 6 }, (_, id) => ({
    id,
    name: `P${id + 1}`,
    color: COLORS[id % COLORS.length],
    pos: 0,
    cash: INITIAL_CASH,
    inJail: false,
    jailTurns: 0,
    goj: { chance: 0, chest: 0 },
    doubles: 0,
    bankrupt: false
  })),
  properties: BOARD.map((sq, i) =>
    isBuyable(sq)
      ? { idx: i, owner: null, houses: 0, mortgaged: false }
      : { idx: i }
  ),
  decks: {
    chance: shuffle(CHANCE_CARDS.map((_, i) => i)),
    chest: shuffle(CHEST_CARDS.map((_, i) => i)),
    discards: { chance: [], chest: [] },
    held: { chance: 0, chest: 0 }
  },
  rollTray: [],
  lastCreditor: null,
  seats: {},
  seatLocks: {},
  disabled: {},
  clients: {},
  log: [],
  auction: null,
  winner: null,
  turnTimer: { enabled: false, durationSec: 60 },
  turnExpiresAt: null,
  trades: []
  , rentOverrides: {}
});

/* ------------ State normalization (for old saves) ------------ */

const normalizeState = st => {
  if (!st || typeof st !== 'object') return createInitialState();

  st.rev = st.rev | 0;
  st.turn = st.turn | 0;
  st.rollBlocked = !!st.rollBlocked;
  st.phase = st.phase || 'awaitRoll';

  st.bank = st.bank || { houses: 32, hotels: 12 };
  st.players = Array.isArray(st.players) ? st.players : [];
  st.properties = Array.isArray(st.properties) ? st.properties : [];
  st.rollTray = Array.isArray(st.rollTray) ? st.rollTray : [];
  st.log = Array.isArray(st.log) ? st.log : [];

  st.decks = st.decks || {};
  st.decks.chance = Array.isArray(st.decks.chance) ? st.decks.chance : [];
  st.decks.chest = Array.isArray(st.decks.chest) ? st.decks.chest : [];
  st.decks.discards = st.decks.discards || { chance: [], chest: [] };
  st.decks.discards.chance = Array.isArray(st.decks.discards.chance) ? st.decks.discards.chance : [];
  st.decks.discards.chest = Array.isArray(st.decks.discards.chest) ? st.decks.discards.chest : [];
  st.decks.held = st.decks.held || { chance: 0, chest: 0 };
  st.decks.held.chance = st.decks.held.chance | 0;
  st.decks.held.chest = st.decks.held.chest | 0;

  st.seats = st.seats || {};
  st.seatLocks = st.seatLocks || {};
  st.disabled = st.disabled || {};
  st.clients = st.clients || {};
  st.trades = Array.isArray(st.trades) ? st.trades : [];
  if (!('rentOverrides' in st)) st.rentOverrides = {};

  st.turnTimer = st.turnTimer || { enabled: false, durationSec: 60 };
  if (typeof st.turnTimer.durationSec !== 'number' || st.turnTimer.durationSec <= 0) {
    st.turnTimer.durationSec = 60;
  }
  if (st.turnTimer.enabled !== true && st.turnTimer.enabled !== false) {
    st.turnTimer.enabled = false;
  }

  if (!('turnExpiresAt' in st)) st.turnExpiresAt = null;

  return st;
};

/* ------------ DB helpers ------------ */

const getDb = async gameId => {
  if (dbs.has(gameId)) return dbs.get(gameId);
  const file = path.join(DATA_DIR, `${gameId}.json`);
  const adapter = new JSONFile(file);
  const db = new Low(adapter, { state: null });
  await db.read();
  dbs.set(gameId, db);
  return db;
};

const scheduleSave = async (gameId, state) => {
  clearTimeout(saveTimers.get(gameId));
  const t = setTimeout(async () => {
    const db = await getDb(gameId);
    db.data = { state };
    await db.write();
  }, 200);
  saveTimers.set(gameId, t);
};

const getGame = async gameId => {
  if (games.has(gameId)) return games.get(gameId);
  const db = await getDb(gameId);
  const st = db.data?.state ? normalizeState(db.data.state) : createInitialState();
  const game = { id: gameId, state: st };
  games.set(gameId, game);
  return game;
};

/* ------------ Wire shape ------------ */

const toWire = state => {
  const players = Array.isArray(state.players) ? state.players : [];
  const properties = Array.isArray(state.properties) ? state.properties : [];
  const rollTray = Array.isArray(state.rollTray) ? state.rollTray : [];
  const log = Array.isArray(state.log) ? state.log : [];

  const auction =
    state.auction && typeof state.auction === 'object'
      ? {
          idx: state.auction.idx,
          bid: state.auction.bid,
          leader: state.auction.leader,
          active: !!state.auction.active,
          endsAt: state.auction.endsAt || null
        }
      : null;

  const turnTimer = state.turnTimer || { enabled: false, durationSec: 60 };

  return {
    rev: state.rev | 0,
    turn: state.turn | 0,
    rollBlocked: !!state.rollBlocked,
    phase: state.phase || 'awaitRoll',
    bank: state.bank || { houses: 32, hotels: 12 },
    players: players.map(p =>
      p
        ? {
            id: p.id,
            name: p.name,
            color: p.color,
            pos: p.pos,
            cash: p.cash,
            inJail: !!p.inJail,
            jailFree:
              ((p.goj?.chance | 0) + (p.goj?.chest | 0)) | 0,
            bankrupt: !!p.bankrupt
          }
        : null
    ),
    properties,
    rollTray: rollTray.slice(0, 40),
    log: log.slice(0, 100),
    auction,
    winner: state.winner != null ? state.winner : null,
    turnExpiresAt: state.turnExpiresAt || null,
    turnTimer,
    seats: state.seats || {},
    seatLocks: state.seatLocks || {},
    disabled: state.disabled || {}
  };
};

/* ------------ Broadcast ------------ */

const gmWire = state => ({
  decks: state.decks,
  seats: state.seats || {},
  clients: state.clients || {},
  rentOverrides: state.rentOverrides || {},
  disabled: state.disabled || {}
});

// In-memory replay buffers (not persisted)
const history = new Map(); // gameId -> [{ ts, rev, state }]
const eventsBuf = new Map(); // gameId -> [{ id, ts, type, payload }]
const eventSeq = new Map(); // gameId -> last event id
const nextEventId = (gameId) => { const id = ((eventSeq.get(gameId) | 0) + 1); eventSeq.set(gameId, id); return id; };
// Patch streaming buffers
const patchesBuf = new Map(); // gameId -> [{ id, fromRev, toRev, kind, changes, state? }]
const lastWire = new Map();   // gameId -> last toWire(state)
const patchSeq = new Map();   // gameId -> last patch id
const nextPatchId = (gameId) => { const id = ((patchSeq.get(gameId) | 0) + 1); patchSeq.set(gameId, id); return id; };
const HISTORY_MAX = 120;

const recordHistory = (gameId, state) => {
  const arr = history.get(gameId) || [];
  const snap = { ts: Date.now(), rev: state.rev|0, state: toWire(state) };
  arr.push(snap); if (arr.length > HISTORY_MAX) arr.shift();
  history.set(gameId, arr);
};

const pushEvent = (gameId, type, payload) => {
  const ev = { id: nextEventId(gameId), ts: Date.now(), type, payload };
  const arr = eventsBuf.get(gameId) || [];
  arr.push(ev);
  if (arr.length > 400) arr.shift();
  eventsBuf.set(gameId, arr);
  const msg = JSON.stringify({ version: PROTOCOL_VERSION, type: 'event', payload: ev });
  log('debug', 'event.push', { gameId, id: ev.id, type });
  wss.clients.forEach(c => { if (c.readyState === 1 && c.gameId === gameId) { try { c.send(msg); } catch {} } });
};

// Minimal JSON-like diff for wire states
const jsonEqual = (a, b) => { if (a === b) return true; try { return JSON.stringify(a) === JSON.stringify(b); } catch { return false; } };
const diffIndexArray = (prev = [], curr = []) => { const out = []; const len = Math.max(prev.length, curr.length); for (let i = 0; i < len; i++) { if (!jsonEqual(prev[i], curr[i])) out.push({ i, v: curr[i] }); } return out; };
const makePatch = (prev, curr) => {
  if (!prev) return { kind: 'reset', fromRev: 0, toRev: curr.rev|0, state: curr };
  const changes = {};
  if (!jsonEqual(prev.rev, curr.rev)) changes.rev = curr.rev|0;
  if (!jsonEqual(prev.turn, curr.turn)) changes.turn = curr.turn|0;
  if (!jsonEqual(prev.rollBlocked, curr.rollBlocked)) changes.rollBlocked = !!curr.rollBlocked;
  if (!jsonEqual(prev.phase, curr.phase)) changes.phase = curr.phase;
  if (!jsonEqual(prev.bank, curr.bank)) changes.bank = curr.bank;
  if (!jsonEqual(prev.auction, curr.auction)) changes.auction = curr.auction;
  if (!jsonEqual(prev.winner, curr.winner)) changes.winner = curr.winner ?? null;
  if (!jsonEqual(prev.turnExpiresAt, curr.turnExpiresAt)) changes.turnExpiresAt = curr.turnExpiresAt ?? null;
  if (!jsonEqual(prev.turnTimer, curr.turnTimer)) changes.turnTimer = curr.turnTimer;
  if (!jsonEqual(prev.seats, curr.seats)) changes.seats = curr.seats || {};
  if (!jsonEqual(prev.seatLocks, curr.seatLocks)) changes.seatLocks = curr.seatLocks || {};
  if (!jsonEqual(prev.disabled, curr.disabled)) changes.disabled = curr.disabled || {};
  const playerDiff = diffIndexArray(prev.players, curr.players); if (playerDiff.length) changes.players = playerDiff;
  const propDiff = diffIndexArray(prev.properties, curr.properties); if (propDiff.length) changes.properties = propDiff;
  if (!jsonEqual(prev.rollTray, curr.rollTray)) changes.rollTray = curr.rollTray;
  if (!jsonEqual(prev.log, curr.log)) changes.log = curr.log;
  return { kind: 'delta', fromRev: prev.rev|0, toRev: curr.rev|0, changes };
};

const broadcast = (gameId, type, payload) => {
  if (type !== 'state') {
    const msg = JSON.stringify({ version: PROTOCOL_VERSION, type, payload });
    log('debug', 'broadcast.nonstate', { gameId, type });
    wss.clients.forEach(c => { if (c.readyState === 1 && c.gameId === gameId) c.send(msg); });
    return;
  }
  const prev = lastWire.get(gameId) || null;
  const curr = payload;
  const patch = makePatch(prev, curr);
  lastWire.set(gameId, curr);
  const id = nextPatchId(gameId);
  const arr = patchesBuf.get(gameId) || [];
  const stored = { id, ...patch };
  arr.push(stored); if (arr.length > 400) arr.shift();
  patchesBuf.set(gameId, arr);
  log('debug', 'broadcast.patch', { gameId, id, kind: patch.kind, from: patch.fromRev, to: patch.toRev });
  const st = games.get(gameId)?.state; if (st) recordHistory(gameId, st);
  const gmMsg = JSON.stringify({ version: PROTOCOL_VERSION, type: 'gm', payload: gmWire(st) });
  wss.clients.forEach(c => {
    if (c.readyState !== 1 || c.gameId !== gameId) return;
    try {
      if (c.isGM === true) c.send(gmMsg);
      if (c.acceptPatch) {
        c.send(JSON.stringify({ version: PROTOCOL_VERSION, type: 'patch', payload: { id, ...patch } }));
      } else {
        c.send(JSON.stringify({ version: PROTOCOL_VERSION, type: 'state', payload: curr }));
      }
    } catch {}
  });
};

const pushHistory = (gameId) => {
  const game = games.get(gameId);
  if (!game) return;
  const hist = (game._history ||= []);
  const snap = JSON.parse(JSON.stringify(game.state));
  hist.push(snap);
  if (hist.length > 25) hist.shift();
};

/* ------------ Utility mutators ------------ */

const credit = (state, pid, amt) => {
  const p = state.players[pid];
  if (!p || p.bankrupt) return;
  p.cash += amt;
};

const debit = (state, pid, amt) => {
  const p = state.players[pid];
  if (!p || p.bankrupt) return;
  p.cash -= amt;
};

const pushLog = (state, entry) => {
  state.log ||= [];
  state.log.unshift({ ts: now(), ...entry });
  if (state.log.length > 300) state.log.length = 300;
};

const indexOfNext = (kind, from) => {
  for (let i = 1; i <= 40; i++) {
    const idx = (from + i) % 40;
    if (BOARD[idx]?.kind === kind) return idx;
  }
  return from;
};

const drawFrom = (state, deck) => {
  if (state.decks[deck].length === 0) {
    state.decks[deck] = shuffle(state.decks.discards[deck]);
    state.decks.discards[deck] = [];
  }
  return state.decks[deck].shift();
};

const addHeldGOJBack = (state, deck) => {
  const arr = deck === 'chance' ? CHANCE_CARDS : CHEST_CARDS;
  const idx = arr.findIndex(
    c => c.kind === 'keep' && c.effect === 'jailFree'
  );
  if (idx >= 0) state.decks[deck].push(idx);
};

const applyCard = (state, pid, deckName, cardIndex) =>
  engineApplyCard(state, pid, deckName, cardIndex);

/* ------------ Core rules ------------ */

const landOn = (state, pid, diceTotal, gameId) => {
  const p = state.players[pid];
  if (!p) return;
  const sq = BOARD[p.pos];
  if (!sq) return;

  if (sq.kind === 'tax') {
    const due = Math.abs(sq.amount || 0);
    debit(state, pid, due);
    pushLog(state, { type: 'tax', pid, idx: p.pos, amount: due });
    return;
  }

  if (sq.kind === 'gotojail') {
    p.inJail = true;
    p.pos = 10;
    p.doubles = 0;
    pushLog(state, { type: 'jail', pid, reason: 'goto' });
    return;
  }

  if (sq.kind === 'street' || sq.kind === 'rr' || sq.kind === 'util') {
    const deed = state.properties[p.pos];
    const owner = deed?.owner;
    if (owner != null && owner !== pid && !deed.mortgaged) {
      let rent = streetRent(state, p.pos, diceTotal);
      const override = state.rentOverrides?.[p.pos];
      if (override != null) rent = override | 0;
      if (rent > 0) {
        state.lastCreditor = owner;
        debit(state, pid, rent);
        credit(state, owner, rent);
        pushLog(state, {
          type: 'rent',
          from: pid,
          to: owner,
          idx: p.pos,
          amount: rent
        });
        if (gameId) pushEvent(gameId, 'PaidRent', { from: pid, to: owner, idx: p.pos, amount: rent });
      }
    }
    return;
  }

  if (sq.kind === 'chance' || sq.kind === 'chest') {
    const deck = sq.kind === 'chance' ? 'chance' : 'chest';
    const idx = drawFrom(state, deck);
    applyCard(state, pid, deck, idx);
    pushLog(state, { type: 'card', pid, deck, idx });
    if (gameId) pushEvent(gameId, 'CardDrawn', { pid, deck, idx });
    return { card: { deck, idx, pid } };
  }
};

const checkAutoBankrupt = (state, pid, gameId = null) => {
  const p = state.players[pid];
  if (!p || p.bankrupt) return false;
  if (p.cash >= 0) return false;
  const need = -p.cash;
  const liq = estimateLiquidation(state, pid);
  if (liq < need) {
    engineDeclareBankrupt(state, pid, state.lastCreditor ?? null);
    if (gameId) pushEvent(gameId, 'Bankrupt', { pid, creditor: state.lastCreditor ?? null });
    return true;
  }
  return false;
};

const buildHouse = (state, pid, idx) => {
  const res = engineBuildHouse(state, pid, idx);
  if (res?.ok) pushLog(state, { type: 'build', pid, idx });
  return res;
};

const sellHouse = (state, pid, idx) => {
  const res = engineSellHouse(state, pid, idx);
  if (res?.ok) pushLog(state, { type: 'sell', pid, idx });
  return res;
};

const buySquare = (state, pid) => {
  const p = state.players[pid];
  if (!p || p.bankrupt) return { error: 'player' };
  const sq = BOARD[p.pos];
  const deed = state.properties[p.pos];
  if (!isBuyable(sq) || !deed || deed.owner != null)
    return { error: 'not_buyable' };
  const price = sq.price | 0;
  if (p.cash < price) return { error: 'cash' };
  debit(state, pid, price);
  deed.owner = pid;
  pushLog(state, { type: 'buy', pid, idx: p.pos, price });
  return { ok: true };
};

const mortgage = (state, pid, idx, setTo) => {
  const res = engineMortgage(state, pid, idx, setTo);
  if (res?.ok)
    pushLog(state, {
      type: setTo ? 'mortgage' : 'unmortgage',
      pid,
      idx
    });
  return res;
};

const useGOJ = (state, pid) => {
  const p = state.players[pid];
  const totalGOJ =
    ((p?.goj?.chance | 0) + (p?.goj?.chest | 0)) | 0;
  if (!p || totalGOJ <= 0 || !p.inJail)
    return { error: 'invalid' };

  p.inJail = false;
  p.jailTurns = 0;

  if ((p.goj.chance | 0) > 0) {
    p.goj.chance -= 1;
    state.decks.held.chance -= 1;
    addHeldGOJBack(state, 'chance');
  } else {
    p.goj.chest -= 1;
    state.decks.held.chest -= 1;
    addHeldGOJBack(state, 'chest');
  }

  pushLog(state, { type: 'useGoj', pid });
  return { ok: true };
};

const rollDice = state => {
  if (state.debugNextRoll) {
    const r = state.debugNextRoll;
    state.debugNextRoll = null;
    return [r.d1 | 0, r.d2 | 0];
  }
  return [
    1 + ((Math.random() * 6) | 0),
    1 + ((Math.random() * 6) | 0)
  ];
};

const passTurn = state => {
  let next = (state.turn + 1) % state.players.length;
  let guard = 0;
  while (state.players[next]?.bankrupt || !!(state.disabled && state.disabled[next]))
    { next = (next + 1) % state.players.length; if (++guard > state.players.length) break; }
  state.turn = next;
  state.phase = 'awaitRoll';
  if (state.turnTimer?.enabled) {
    const dur =
      (state.turnTimer.durationSec | 0) || 60;
    state.turnExpiresAt = Date.now() + dur * 1000;
  } else {
    state.turnExpiresAt = null;
  }
};

const onRoll = (state, pid, gameId = null) => {
  if (state.rollBlocked) return { error: 'blocked' };
  if (state.turn !== pid) return { error: 'turn' };
  if (state.phase !== 'awaitRoll')
    return { error: 'phase' };

  const p = state.players[pid];
  if (!p || p.bankrupt) return { error: 'player' };

  const [d1, d2] = rollDice(state);
  const total = d1 + d2;

  state.rollTray.unshift({
    ts: now(),
    pid,
    d1,
    d2,
    total
  });
  if (state.rollTray.length > 100)
    state.rollTray.length = 100;

  state.phase = 'awaitMoveResolution';
  pushLog(state, { type: 'roll', pid, d1, d2, total });

  if (p.inJail) {
    if (d1 === d2) {
      p.inJail = false;
      p.jailTurns = 0;
    } else {
      if ((p.jailTurns | 0) >= 2) {
        if (p.cash >= 50) {
          debit(state, pid, 50);
          p.inJail = false;
          p.jailTurns = 0;
        } else {
          const need = 50 - p.cash;
          const liq = estimateLiquidation(state, pid);
          if (liq < need) {
            engineDeclareBankrupt(state, pid, null);
            if (gameId) pushEvent(gameId, 'Bankrupt', { pid, creditor: null });
            return {
              ok: true,
              jailed: true,
              bankrupt: true,
              d1,
              d2,
              total
            };
          } else {
            state.phase = 'awaitRoll';
            return { error: 'must_resolve' };
          }
        }
      } else {
        p.jailTurns = (p.jailTurns | 0) + 1;
        return { ok: true, jailed: true, d1, d2, total };
      }
    }
  }

  if (d1 === d2) {
    p.doubles = (p.doubles | 0) + 1;
    if (p.doubles >= 3) {
      const fromJ = p.pos;
      p.inJail = true;
      p.pos = 10;
      p.doubles = 0;
      p.jailTurns = 0;
      if (gameId) pushEvent(gameId, 'Moved', { pid, from: fromJ, to: 10, d1, d2, total, triple: true });
      return { ok: true, triple: true, d1, d2, total };
    }
  } else {
    p.doubles = 0;
  }

  const from = p.pos;
  engineMoveTo(state, pid, from + total);
  pushLog(state, {
    type: 'move',
    pid,
    from,
    to: state.players[pid].pos
  });
  if (gameId) pushEvent(gameId, 'Moved', { pid, from, to: state.players[pid].pos, d1, d2, total });

  const evt = landOn(state, pid, total, gameId);

  if (checkAutoBankrupt(state, pid, gameId))
    return { ok: true, bankrupt: true };

  if (d1 !== d2 && !p.inJail) {
    return {
      ok: true,
      d1,
      d2,
      total,
      from,
      to: state.players[pid].pos,
      extra: false,
      ...(evt || {})
    };
  }

  state.phase = 'awaitRoll';
  return {
    ok: true,
    d1,
    d2,
    total,
    from,
    to: state.players[pid].pos,
    extra: d1 === d2,
    ...(evt || {})
  };
};

const checkWinner = state => {
  const alive = state.players.filter(
    p => p && !p.bankrupt
  );
  if (alive.length === 1 && state.winner == null) {
    state.winner = alive[0].id;
    state.phase = 'gameOver';
    pushLog(state, { type: 'win', pid: state.winner });
  }
};

/* ------------ WebSocket handling ------------ */

wss.on('connection', ws => {
  ws.isAlive = true;
  ws.on('pong', () => {
    ws.isAlive = true;
  });
  log('info', 'ws.connection');

  ws.on('message', async buf => {
    let msg;
    try {
      msg = JSON.parse(String(buf));
    } catch {
      return;
    }

    const t = msg.type;

    const reject = (code, extra = {}) => {
      try {
        ws.send(JSON.stringify({ version: PROTOCOL_VERSION, type: 'err', payload: { code, ...extra } }));
      } catch {}
      log('warn', 'ws.reject', { code, type: String(t||'') });
    };

    if (t === 'join') {
      const gameId = String(msg.gameId || 'default');
      const pid = msg.pid | 0;
      const name = msg.name
        ? String(msg.name).slice(0, 24)
        : null;
      const color = msg.color ? String(msg.color).slice(0, 16) : null;
      const clientId = String(msg.clientId || '');
      const isGM =
        !!msg.gmToken &&
        GM_TOKEN &&
        String(msg.gmToken) === GM_TOKEN;
      const isSpectator = !!msg.spectator && !isGM;
      const acceptPatch = !!msg.acceptPatch;
      const lastEventId = msg.lastEventId | 0;
      const lastPatchId = msg.lastPatchId | 0;
      log('info', 'join', { gameId, pid, clientId, isGM, isSpectator, acceptPatch, lastEventId, lastPatchId });

      if (
        (msg.version | 0) !== PROTOCOL_VERSION ||
        !clientId
      ) {
        return reject('version');
      }

      const game = await getGame(gameId);
      const state = game.state;

      ws.gameId = gameId;
      ws.isGM = isGM;
      ws.clientId = clientId;
      ws.acceptPatch = acceptPatch;

      if (isSpectator) {
        state.clients ||= {};
        state.clients[clientId] = { pid: null, lastSeen: Date.now() };
        ws.send(JSON.stringify({ version: PROTOCOL_VERSION, type: 'state', payload: toWire(state) }));
        try {
          const hist = history.get(gameId) || [];
          ws.send(JSON.stringify({ version: PROTOCOL_VERSION, type: 'history', payload: hist }));
          const evs = eventsBuf.get(gameId) || [];
          if (lastEventId > 0) {
            const since = evs.filter(e => (e.id|0) > lastEventId);
            ws.send(JSON.stringify({ version: PROTOCOL_VERSION, type: 'events.since', payload: { from: lastEventId, events: since } }));
          } else {
            ws.send(JSON.stringify({ version: PROTOCOL_VERSION, type: 'events', payload: evs }));
          }
        } catch {}
        return;
      }

      if (!isGM) {
        const seats =
          state.seats || (state.seats = {});
        const clients =
          state.clients || (state.clients = {});
        const currentOwner = seats[pid];
        const locked = !!(state.seatLocks && state.seatLocks[pid]);

        if (
          (!locked && currentOwner == null) ||
          currentOwner === clientId
        ) {
          seats[pid] = clientId;
          clients[clientId] = { pid, lastSeen: Date.now() };
          ws.pid = pid;
          if (name) state.players[pid].name = name;
          if (color) state.players[pid].color = color;
          state.rev++;
          const wire = toWire(state);
          ws.send(JSON.stringify({ version: PROTOCOL_VERSION, type: 'state', payload: wire }));
          broadcast(ws.gameId, 'state', wire);
          if (acceptPatch) {
            const buf = patchesBuf.get(gameId) || [];
            if (lastPatchId > 0) {
              const missing = buf.filter(p => (p.id|0) > lastPatchId);
              if (missing.length) missing.forEach(p => { try { ws.send(JSON.stringify({ version: PROTOCOL_VERSION, type: 'patch', payload: p })); } catch {} });
            }
            const evs = eventsBuf.get(gameId) || [];
            if (lastEventId > 0) {
              const since = evs.filter(e => (e.id|0) > lastEventId);
              if (since.length) try { ws.send(JSON.stringify({ version: PROTOCOL_VERSION, type: 'events.since', payload: { from: lastEventId, events: since } })); } catch {}
            }
          }
          await scheduleSave(ws.gameId, state);
        } else {
          return reject(locked ? 'seat.locked' : 'seat.taken');
        }
      } else {
        ws.send(JSON.stringify({ version: PROTOCOL_VERSION, type: 'state', payload: toWire(state) }));
        try {
          ws.send(JSON.stringify({ version: PROTOCOL_VERSION, type: 'gm', payload: gmWire(state) }));
        } catch {}
      }
      return;
    }

    if (!ws.gameId)
      return reject('not_joined');

    const game = await getGame(ws.gameId);
    const state = game.state;

    const requireVersion = () =>
      (msg.version | 0) === PROTOCOL_VERSION;
    // Do not trust client pid; server is authoritative
    const requirePidTurn = () => true;
    const hasTurnAuthority = () =>
      ws.isGM === true || (ws.pid === state.turn && !(state.disabled?.[state.turn]));

    /* ---- Actions ---- */

    // Heartbeat from clients; record lastSeen and ack
    if (t === 'hb') {
      if (!requireVersion()) return; // ignore silently on mismatch
      const id = ws.clientId || String(msg.clientId || '');
      state.clients ||= {};
      if (id) {
        const existing = state.clients[id] || {};
        state.clients[id] = {
          pid: ws.pid != null ? ws.pid : (existing.pid == null ? null : (existing.pid | 0)),
          lastSeen: Date.now()
        };
      }
      try {
        ws.send(JSON.stringify({ version: PROTOCOL_VERSION, type: 'ack.hb', payload: { ts: Date.now() } }));
      } catch {}
      return;
    }
    // Backfill request (client asks for missing patches/events by id)
    if (t === 'sync') {
      if (!requireVersion()) return reject('version');
      const fromPatch = msg.lastPatchId | 0;
      const fromEvent = msg.lastEventId | 0;
      if (fromPatch > 0) {
        const buf = patchesBuf.get(ws.gameId) || [];
        const missing = buf.filter(p => (p.id|0) > fromPatch);
        missing.forEach(p => { try { ws.send(JSON.stringify({ version: PROTOCOL_VERSION, type: 'patch', payload: p })); } catch {} });
      }
      if (fromEvent > 0) {
        const evs = eventsBuf.get(ws.gameId) || [];
        const since = evs.filter(e => (e.id|0) > fromEvent);
        try { ws.send(JSON.stringify({ version: PROTOCOL_VERSION, type: 'events.since', payload: { from: fromEvent, events: since } })); } catch {}
      }
      return;
    }
    if (t === 'roll') {
      if (!requireVersion())
        return reject('version');
      if (
        !hasTurnAuthority() ||
        !requirePidTurn()
      )
        return reject('turn');

      const t0 = Date.now();
      const res = onRoll(state, state.turn, ws.gameId);
      state.rev++;
      log('debug', 'act.roll', { gameId: ws.gameId, tookMs: Date.now() - t0 });

      if (res?.card) {
        const { deck, idx, pid } = res.card;
        broadcast(ws.gameId, 'card', {
          pid,
          kind: deck,
          index: idx,
          ts: now()
        });
        pushEvent(ws.gameId, 'CardDrawn', { pid, deck, idx });
      }

      broadcast(ws.gameId, 'state', toWire(state));

      if (res?.jailed && !res.bankrupt) {
        passTurn(state);
        state.rev++;
      }
      if (res?.bankrupt) {
        passTurn(state);
        state.rev++;
      }
      if (res?.triple) {
        passTurn(state);
        state.rev++;
      }

      checkWinner(state);
      await scheduleSave(ws.gameId, state);

      ws.send(JSON.stringify({ version: PROTOCOL_VERSION, type: 'ack.roll', payload: res }));
      return;
    }

    if (t === 'buy') {
      if (!requireVersion())
        return reject('version');
      if (
        !hasTurnAuthority() ||
        !requirePidTurn()
      )
        return reject('turn');

      const t0b = Date.now();
      const res = buySquare(state, state.turn);
      if (res?.ok) state.rev++;
      log('debug', 'act.buy', { gameId: ws.gameId, ok: !!res?.ok, tookMs: Date.now() - t0b });

      if (res?.ok) pushEvent(ws.gameId, 'Built', { kind: 'Buy', pid: state.turn, idx: state.players[state.turn].pos });
      broadcast(ws.gameId, 'state', toWire(state));
      checkWinner(state);
      await scheduleSave(ws.gameId, state);

      ws.send(JSON.stringify({ version: PROTOCOL_VERSION, type: 'ack.buy', payload: res }));
      return;
    }

    if (t === 'build') {
      if (!requireVersion())
        return reject('version');
      if (
        !hasTurnAuthority() ||
        !requirePidTurn()
      )
        return reject('turn');

      const idx = msg.idx | 0;
      if (idx < 0 || idx >= 40)
        return reject('idx');

      const t0bh = Date.now();
      const res = buildHouse(
        state,
        state.turn,
        idx
      );
      if (res?.ok) state.rev++;
      log('debug', 'act.build', { gameId: ws.gameId, idx, ok: !!res?.ok, tookMs: Date.now() - t0bh });
      if (res?.ok) pushEvent(ws.gameId, 'Built', { pid: state.turn, idx, delta: +1 });
      broadcast(ws.gameId, 'state', toWire(state));
      checkWinner(state);
      await scheduleSave(ws.gameId, state);

      ws.send(JSON.stringify({ version: PROTOCOL_VERSION, type: 'ack.build', payload: res }));
      return;
    }

    if (t === 'sell') {
      if (!requireVersion())
        return reject('version');
      if (
        !hasTurnAuthority() ||
        !requirePidTurn()
      )
        return reject('turn');

      const idx = msg.idx | 0;
      if (idx < 0 || idx >= 40)
        return reject('idx');

      const t0sh = Date.now();
      const res = sellHouse(
        state,
        state.turn,
        idx
      );
      if (res?.ok) state.rev++;
      log('debug', 'act.sell', { gameId: ws.gameId, idx, ok: !!res?.ok, tookMs: Date.now() - t0sh });
      if (res?.ok) pushEvent(ws.gameId, 'Built', { pid: state.turn, idx, delta: -1 });
      broadcast(ws.gameId, 'state', toWire(state));
      checkWinner(state);
      await scheduleSave(ws.gameId, state);

      ws.send(JSON.stringify({ version: PROTOCOL_VERSION, type: 'ack.sell', payload: res }));
      return;
    }

    if (t === 'mortgage') {
      if (!requireVersion())
        return reject('version');
      if (
        !hasTurnAuthority() ||
        !requirePidTurn()
      )
        return reject('turn');

      const idx = msg.idx | 0;
      if (idx < 0 || idx >= 40)
        return reject('idx');

      const t0m = Date.now();
      const res = mortgage(
        state,
        state.turn,
        idx,
        !!msg.setTo
      );
      if (res?.ok) state.rev++;
      log('debug', 'act.mortgage', { gameId: ws.gameId, idx, setTo: !!msg.setTo, ok: !!res?.ok, tookMs: Date.now() - t0m });
      if (res?.ok) pushEvent(ws.gameId, 'Mortgaged', { pid: state.turn, idx, setTo: !!msg.setTo });
      broadcast(ws.gameId, 'state', toWire(state));
      checkWinner(state);
      await scheduleSave(ws.gameId, state);

      ws.send(JSON.stringify({ version: PROTOCOL_VERSION, type: 'ack.mortgage', payload: res }));
      return;
    }

    if (t === 'useGoj') {
      if (!requireVersion())
        return reject('version');
      if (
        !hasTurnAuthority() ||
        !requirePidTurn()
      )
        return reject('turn');

      const t0g = Date.now();
      const res = useGOJ(state, state.turn);
      if (res?.ok) state.rev++;
      log('debug', 'act.useGoj', { gameId: ws.gameId, ok: !!res?.ok, tookMs: Date.now() - t0g });

      broadcast(ws.gameId, 'state', toWire(state));
      checkWinner(state);
      await scheduleSave(ws.gameId, state);

      ws.send(JSON.stringify({ version: PROTOCOL_VERSION, type: 'ack.useGoj', payload: res }));
      return;
    }

    if (t === 'jail.pay') {
      if (!requireVersion())
        return reject('version');
      if (
        !hasTurnAuthority() ||
        !requirePidTurn()
      )
        return reject('turn');

      const p = state.players[state.turn];
      if (!p?.inJail)
        return reject('invalid');
      if ((p.cash | 0) < 50)
        return reject('cash');

      debit(state, state.turn, 50);
      p.inJail = false;
      p.jailTurns = 0;

      state.rev++;
      pushLog(state, {
        type: 'jail.pay',
        pid: state.turn,
        amount: 50
      });

      broadcast(ws.gameId, 'state', toWire(state));
      checkWinner(state);
      await scheduleSave(ws.gameId, state);

      ws.send(JSON.stringify({ version: PROTOCOL_VERSION, type: 'ack.jail.pay', payload: { ok: true } }));
      return;
    }

    if (t === 'endTurn') {
      if (!requireVersion())
        return reject('version');
      if (
        !hasTurnAuthority() ||
        !requirePidTurn()
      )
        return reject('turn');

      const me = state.players[state.turn];

      if (
        me.cash < 0 &&
        estimateLiquidation(
          state,
          state.turn
        ) > 0
      )
        return reject('must_resolve');

      const canExitJail =
        me.inJail &&
        ((((me.goj?.chance | 0) +
          (me.goj?.chest | 0)) >
          0) ||
          me.cash >= 50);

      if (canExitJail)
        return reject('must_resolve');

      passTurn(state);
      state.rev++;

      broadcast(ws.gameId, 'state', toWire(state));
      checkWinner(state);
      await scheduleSave(ws.gameId, state);
      return;
    }

    if (t === 'draw') {
      if (!requireVersion())
        return reject('version');
      if (
        !hasTurnAuthority() ||
        !requirePidTurn()
      )
        return reject('turn');

      const here =
        BOARD[
          state.players[state.turn].pos
        ];
      if (
        !(
          here?.kind === 'chance' ||
          here?.kind === 'chest'
        )
      )
        return reject('not_on_deck');

      const deck =
        msg.deck === 'chest'
          ? 'chest'
          : 'chance';
      if (deck !== here.kind)
        return reject('deck_mismatch');

      const idx = drawFrom(state, deck);
      applyCard(
        state,
        state.turn,
        deck,
        idx
      );
      state.rev++;

      broadcast(ws.gameId, 'card', {
        pid: state.turn,
        kind: deck,
        index: idx,
        ts: now()
      });
      pushEvent(ws.gameId, 'CardDrawn', { pid: state.turn, deck, idx });
      broadcast(ws.gameId, 'state', toWire(state));

      if (
        checkAutoBankrupt(
          state,
          state.turn,
          ws.gameId
        )
      ) {
        passTurn(state);
        state.rev++;
      }

      checkWinner(state);
      await scheduleSave(ws.gameId, state);
      return;
    }

    if (t === 'profile.set') {
      if (!requireVersion())
        return reject('version');

      const pid = ws.pid;
      if (pid == null)
        return reject('not_joined');

      const me = state.players[pid];
      if (!me) return reject('player');

      if (typeof msg.name === 'string')
        me.name = String(
          msg.name
        ).slice(0, 24);
      if (typeof msg.color === 'string')
        me.color = String(
          msg.color
        ).slice(0, 16);

      state.rev++;
      broadcast(ws.gameId, 'state', toWire(state));
      await scheduleSave(ws.gameId, state);

      ws.send(JSON.stringify({ version: PROTOCOL_VERSION, type: 'ack.profile.set', payload: { ok: true } }));
      return;
    }

    if (t === 'decline') {
      if (!requireVersion())
        return reject('version');
      if (
        !hasTurnAuthority() ||
        !requirePidTurn()
      )
        return reject('turn');

      const pos =
        state.players[state.turn].pos;
      const sq = BOARD[pos];
      const deed = state.properties[pos];

      if (
        !isBuyable(sq) ||
        !deed ||
        deed.owner != null
      )
        return reject('not_buyable');

      const participants =
        state.players
          .filter(
            p =>
              p &&
              !p.bankrupt
          )
          .map(p => p.id);

      state.auction = {
        idx: pos,
        bid: 0,
        leader: null,
        active: true,
        participants,
        endsAt: Date.now() + 20000
      };

      state.phase = 'auction';
      state.rev++;
      pushLog(state, {
        type: 'auction.start',
        idx: pos
      });

      broadcast(ws.gameId, 'state', toWire(state));
      await scheduleSave(ws.gameId, state);
      return;
    }

    if (t === 'auction.bid') {
      if (!requireVersion())
        return reject('version');

      const pid = ws.pid;
      if (pid == null)
        return reject('spectator');

      const auc = state.auction;
      if (!auc || !auc.active)
        return reject('no_auction');
      if (
        !auc.participants.includes(pid)
      )
        return reject('not_in');

      const amt =
        Math.max(0, msg.amount | 0);
      if (amt <= (auc.bid | 0))
        return reject('low');

      const p = state.players[pid];
      if (!p || p.bankrupt)
        return reject('player');
      if (p.cash < amt)
        return reject('cash');

      auc.bid = amt;
      auc.leader = pid;
      auc.endsAt = Date.now() + 10000;

      state.rev++;
      pushLog(state, {
        type: 'auction.bid',
        pid,
        amount: amt
      });

      broadcast(ws.gameId, 'state', toWire(state));
      await scheduleSave(ws.gameId, state);
      return;
    }

    if (t === 'auction.finish') {
      if (!ws.isGM)
        return reject('forbidden');

      const auc = state.auction;
      if (!auc || !auc.active)
        return reject('no_auction');

      const deed =
        state.properties[auc.idx];
      const sq = BOARD[auc.idx];
      if (!deed || !sq)
        return reject('idx');

      if (
        auc.leader != null &&
        auc.bid > 0
      ) {
        const winner =
          state.players[auc.leader];
        if (
          winner &&
          !winner.bankrupt &&
          winner.cash >= auc.bid
        ) {
          debit(
            state,
            auc.leader,
            auc.bid
          );
          deed.owner = auc.leader;
          pushLog(state, {
            type: 'auction.win',
            pid: auc.leader,
            idx: auc.idx,
            price: auc.bid
          });
          pushEvent(ws.gameId, 'AuctionWon', { pid: auc.leader, idx: auc.idx, price: auc.bid });
        } else {
          pushLog(state, {
            type: 'auction.none',
            idx: auc.idx
          });
        }
      } else {
        pushLog(state, {
          type: 'auction.none',
          idx: auc.idx
        });
      }

      state.auction = null;
      state.phase = 'awaitRoll';
      state.rev++;

      broadcast(ws.gameId, 'state', toWire(state));
      checkWinner(state);
      await scheduleSave(ws.gameId, state);
      return;
    }

    if (t === 'trade.propose') {
      if (!requireVersion())
        return reject('version');

      const from = ws.pid;
      const to = msg.to | 0;
      if (from == null || from === to)
        return reject('invalid');
      if (!ws.isGM && state.disabled?.[from])
        return reject('disabled');

      const offer = {
        id:
          Math.random()
            .toString(36)
            .slice(2) + Date.now(),
        from,
        to,
        give: msg.give || {},
        take: msg.take || {},
        ts: now(),
        stateRev: state.rev,
        gmApprove: !!msg.gmApprove,
        acceptedByTarget: false
      };

      state.trades.push(offer);
      state.rev++;
      pushLog(state, {
        type: 'trade.offer',
        from,
        to
      });

      broadcast(
        ws.gameId,
        'trade.offer',
        offer
      );
      broadcast(ws.gameId, 'state', toWire(state));
      await scheduleSave(ws.gameId, state);

      ws.send(JSON.stringify({ version: PROTOCOL_VERSION, type: 'ack.trade.propose', payload: { ok: true, id: offer.id } }));
      return;
    }

    if (t === 'trade.respond') {
      if (!requireVersion())
        return reject('version');

      const offerId = String(
        msg.id || ''
      );
      const accept = !!msg.accept;
      const i = state.trades.findIndex(
        o => o.id === offerId
      );
      if (i < 0)
        return reject('not_found');

      const offer = state.trades[i];

      if (
        ws.pid !== offer.to &&
        !ws.isGM
      )
        return reject('forbidden');
      if (!ws.isGM && state.disabled?.[ws.pid])
        return reject('disabled');

      if (!accept) {
        state.trades.splice(i, 1);
        state.rev++;
        pushLog(state, {
          type: 'trade.reject',
          from: offer.to,
          to: offer.from
        });

      broadcast(
        ws.gameId,
        'trade.reject',
        { id: offerId }
      );
      broadcast(ws.gameId, 'state', toWire(state));
        await scheduleSave(ws.gameId, state);
        return;
      }

      if (offer.gmApprove && !ws.isGM) {
        offer.acceptedByTarget = true;
        state.rev++;
        pushLog(state, { type: 'trade.offer', from: offer.from, to: offer.to });
        broadcast(ws.gameId, 'trade.ready', { id: offerId });
        broadcast(ws.gameId, 'state', toWire(state));
        await scheduleSave(ws.gameId, state);
        return;
      }

      const applySide = (
        actorPid,
        otherPid,
        side,
        sign
      ) => {
        const actor =
          state.players[actorPid];
        const other =
          state.players[otherPid];
        if (!actor || !other)
          return false;

        const cash =
          (side.cash | 0) * sign;
        if (cash) {
          actor.cash -= cash;
          other.cash += cash;
        }

        const props = Array.isArray(
          side.props
        )
          ? side.props
          : [];
        for (const idx of props) {
          const d =
            state.properties[
              idx | 0
            ];
          const sq =
            BOARD[idx | 0];
          if (
            !d ||
            !sq ||
            !isBuyable(sq)
          )
            continue;
          if (sign > 0) {
            if (
              d.owner !== actorPid
            )
              continue;
            d.owner = otherPid;
          }
        }

        const goj =
          side.goj || {};
        const cAmt =
          goj.chance | 0;
        const hAmt =
          goj.chest | 0;

        if (
          cAmt > 0 &&
          (actor.goj?.chance | 0) >=
            cAmt
        ) {
          actor.goj.chance -= cAmt;
          other.goj ||=
            {
              chance: 0,
              chest: 0
            };
          other.goj.chance =
            (other.goj.chance |
              0) + cAmt;
          state.decks.held.chance =
            Math.max(
              0,
              state.decks.held
                .chance | 0
            );
        }

        if (
          hAmt > 0 &&
          (actor.goj?.chest | 0) >=
            hAmt
        ) {
          actor.goj.chest -= hAmt;
          other.goj ||=
            {
              chance: 0,
              chest: 0
            };
          other.goj.chest =
            (other.goj.chest |
              0) + hAmt;
          state.decks.held.chest =
            Math.max(
              0,
              state.decks.held
                .chest | 0
            );
        }

        return true;
      };

      applySide(
        offer.from,
        offer.to,
        offer.give,
        +1
      );
      applySide(
        offer.to,
        offer.from,
        offer.take,
        +1
      );

      state.trades.splice(i, 1);
      state.rev++;
      pushLog(state, {
        type: 'trade.accept',
        from: offer.from,
        to: offer.to
      });

      broadcast(
        ws.gameId,
        'trade.accept',
        { id: offerId }
      );
      broadcast(ws.gameId, 'state', toWire(state));
      checkWinner(state);
      await scheduleSave(ws.gameId, state);
      return;
    }

    if (t === 'set' && msg.key === 'rollBlocked') {
      if (!ws.isGM)
        return reject('forbidden');
      state.rollBlocked = !!msg.value;
      state.rev++;
      broadcast(ws.gameId, 'state', toWire(state));
      await scheduleSave(ws.gameId, state);
      return;
    }

    if (t === 'set' && msg.key === 'turnTimer') {
      if (!ws.isGM)
        return reject('forbidden');
      const enabled = !!msg.enabled;
      const sec =
        Math.max(
          5,
          msg.durationSec | 0
        ) || 60;
      state.turnTimer = {
        enabled,
        durationSec: sec
      };
      state.turnExpiresAt = enabled
        ? Date.now() + sec * 1000
        : null;
      state.rev++;
      broadcast(ws.gameId, 'state', toWire(state));
      await scheduleSave(ws.gameId, state);
      return;
    }

    if (t === 'debug.roll') {
      if (!ws.isGM)
        return reject('forbidden');
      state.debugNextRoll = {
        d1: msg.d1 | 0,
        d2: msg.d2 | 0
      };
      ws.send(JSON.stringify({ version: PROTOCOL_VERSION, type: 'ack.debug.roll', payload: state.debugNextRoll }));
      return;
    }

    if (t === 'debug.goto') {
      if (!ws.isGM)
        return reject('forbidden');
      const idx = msg.idx | 0;
      if (idx < 0 || idx >= 40)
        return reject('idx');
      engineMoveTo(
        state,
        state.turn,
        idx,
        false
      );
      state.rev++;
      broadcast(ws.gameId, 'state', toWire(state));
      await scheduleSave(ws.gameId, state);
      return;
    }

    if (t === 'debug.cash') {
      if (!ws.isGM)
        return reject('forbidden');
      const pid = msg.pid | 0;
      const delta =
        msg.delta | 0;
      const p =
        state.players[pid];
      if (!p)
        return reject('player');
      p.cash += delta;
      state.rev++;
      pushLog(state, {
        type: 'debug.cash',
        pid,
        delta
      });
      broadcast(ws.gameId, 'state', toWire(state));
      await scheduleSave(ws.gameId, state);
      return;
    }

    if (t === 'debug.reset') {
      if (!ws.isGM)
        return reject('forbidden');
      const fresh =
        createInitialState();
      games.set(ws.gameId, {
        id: ws.gameId,
        state: fresh
      });
      broadcast(
        ws.gameId,
        'state',
        toWire(fresh)
      );
      await scheduleSave(ws.gameId, fresh);
      return;
    }

    // ---- GM admin actions ----
    if (t && String(t).startsWith('admin.')) {
      if (!ws.isGM) return reject('forbidden');
      // Record state before each admin action for undo
      pushHistory(ws.gameId);

      const reply = (kind, payload) => {
        try { ws.send(JSON.stringify({ version: PROTOCOL_VERSION, type: `ack.${kind}`, payload })); } catch {}
      };
      const ensureIdx = idx => (idx|0) >= 0 && (idx|0) < 40;

      // Seat management
      if (t === 'admin.seat.assign') {
        const pid = msg.pid | 0;
        const cid = String(msg.clientId || '');
        if (!cid || pid < 0 || pid >= state.players.length) return reject('invalid');
        state.seats ||= {};
        state.clients ||= {};
        state.seats[pid] = cid;
        const prevPid = state.clients[cid]?.pid;
        state.clients[cid] = { pid, lastSeen: Date.now() };
        // Update active sockets for that clientId in this game
        wss.clients.forEach(c => {
          if (c.readyState === 1 && c.gameId === ws.gameId && c.clientId === cid && !c.isGM) {
            c.pid = pid;
          }
        });
        state.rev++;
        broadcast(ws.gameId, 'state', toWire(state));
        await scheduleSave(ws.gameId, state);
        return reply('admin.seat.assign', { ok: true, prevPid });
      }

      if (t === 'admin.seat.unassign') {
        const pid = msg.pid | 0;
        const cid = state.seats?.[pid];
        if (cid) {
          delete state.seats[pid];
          if (state.clients?.[cid]) state.clients[cid].pid = null;
          // Update sockets with that client to have no pid
          wss.clients.forEach(c => {
            if (c.readyState === 1 && c.gameId === ws.gameId && c.clientId === cid && !c.isGM) {
              c.pid = null;
            }
          });
          state.rev++;
          broadcast(ws.gameId, 'state', toWire(state));
          await scheduleSave(ws.gameId, state);
        }
        return reply('admin.seat.unassign', { ok: true });
      }

      if (t === 'admin.seat.swap') {
        const a = msg.a | 0;
        const b = msg.b | 0;
        state.seats ||= {};
        const cidA = state.seats[a];
        const cidB = state.seats[b];
        state.seats[a] = cidB;
        state.seats[b] = cidA;
        if (cidA && state.clients?.[cidA]) state.clients[cidA].pid = b;
        if (cidB && state.clients?.[cidB]) state.clients[cidB].pid = a;
        // Update sockets
        wss.clients.forEach(c => {
          if (c.readyState !== 1 || c.gameId !== ws.gameId || c.isGM) return;
          if (c.clientId === cidA) c.pid = b;
          if (c.clientId === cidB) c.pid = a;
        });
        state.rev++;
        broadcast(ws.gameId, 'state', toWire(state));
        await scheduleSave(ws.gameId, state);
        return reply('admin.seat.swap', { ok: true });
      }

      if (t === 'admin.seat.lock') {
        const pid = msg.pid | 0; const setTo = !!msg.setTo;
        state.seatLocks ||= {}; state.seatLocks[pid] = setTo;
        state.rev++;
        broadcast(ws.gameId, 'state', toWire(state));
        await scheduleSave(ws.gameId, state);
        return reply('admin.seat.lock', { ok: true });
      }

      if (t === 'admin.bot.add') {
        const pid = msg.pid | 0;
        const name = (msg.name ? String(msg.name) : `Bot${pid+1}`).slice(0,24);
        const color = (msg.color ? String(msg.color) : '#666666').slice(0,16);
        const cid = `bot:${pid}`;
        if (!state.players[pid]) return reject('pid');
        state.players[pid].name = name;
        state.players[pid].color = color;
        state.seats ||= {}; state.clients ||= {};
        state.seats[pid] = cid;
        state.clients[cid] = { pid, lastSeen: Date.now() };
        state.rev++;
        pushLog(state, { type:'bot.add', pid });
        broadcast(ws.gameId, 'state', toWire(state));
        await scheduleSave(ws.gameId, state);
        return reply('admin.bot.add', { ok:true });
      }

      if (t === 'admin.bot.remove') {
        const pid = msg.pid | 0;
        const cid = state.seats?.[pid];
        if (cid && String(cid).startsWith('bot:')) {
          delete state.seats[pid];
          if (state.clients) delete state.clients[cid];
          state.rev++;
          pushLog(state, { type:'bot.remove', pid });
          broadcast(ws.gameId, 'state', toWire(state));
          await scheduleSave(ws.gameId, state);
        }
        return reply('admin.bot.remove', { ok:true });
      }

      // Player profile and moves
      if (t === 'admin.player.rename') {
        const pid = msg.pid | 0;
        const name = String(msg.name || '').slice(0,24);
        if (!state.players[pid]) return reject('player');
        state.players[pid].name = name || state.players[pid].name;
        state.rev++;
        broadcast(ws.gameId, 'state', toWire(state));
        await scheduleSave(ws.gameId, state);
        return reply('admin.player.rename', { ok: true });
      }

      if (t === 'admin.player.color') {
        const pid = msg.pid | 0;
        const color = String(msg.color || '').slice(0,16);
        if (!state.players[pid]) return reject('player');
        if (color) state.players[pid].color = color;
        state.rev++;
        broadcast(ws.gameId, 'state', toWire(state));
        await scheduleSave(ws.gameId, state);
        return reply('admin.player.color', { ok: true });
      }

      if (t === 'admin.player.disable') {
        const pid = msg.pid | 0; const setTo = !!msg.setTo;
        state.disabled ||= {}; state.disabled[pid] = setTo;
        state.rev++;
        pushLog(state, { type: setTo ? 'player.disabled' : 'player.enabled', pid });
        // If disabling the current turn holder, advance turn
        if (setTo && (state.turn|0) === pid) { passTurn(state); state.rev++; }
        broadcast(ws.gameId, 'state', toWire(state));
        await scheduleSave(ws.gameId, state);
        return reply('admin.player.disable', { ok: true });
      }

      if (t === 'admin.player.move') {
        const pid = msg.pid | 0;
        const idx = msg.idx | 0;
        const payGo = !!msg.payGo;
        if (!state.players[pid] || !ensureIdx(idx)) return reject('invalid');
        engineMoveTo(state, pid, idx, payGo);
        state.rev++;
        pushLog(state, { type:'debug.goto', pid, idx });
        broadcast(ws.gameId, 'state', toWire(state));
        await scheduleSave(ws.gameId, state);
        return reply('admin.player.move', { ok: true });
      }

      // Property controls
      if (t === 'admin.prop.setHouses') {
        const idx = msg.idx | 0;
        const target = Math.max(0, Math.min(5, msg.houses | 0));
        const deed = state.properties[idx];
        const sq = BOARD[idx];
        if (!deed || !sq || sq.kind !== 'street') return reject('invalid');
        const current = deed.houses | 0;
        const cost = sq.houseCost || HOUSE_COST_BY_GROUP[sq.group] || 0;
        // adjust bank inventory accordingly
        const needHouses = (h)=> h === 5 ? 0 : h;
        const needHotels = (h)=> h === 5 ? 1 : 0;
        const deltaH = needHouses(target) - needHouses(current);
        const deltaT = needHotels(target) - needHotels(current);
        if (state.bank.houses - deltaH < 0 || state.bank.hotels - deltaT < 0) return reject('bank');
        state.bank.houses -= deltaH; // if deltaH positive, take from bank; if negative, return
        state.bank.hotels -= deltaT;
        deed.houses = target;
        state.rev++;
        pushLog(state, { type:'debug.houses', idx, to: target });
        broadcast(ws.gameId, 'state', toWire(state));
        await scheduleSave(ws.gameId, state);
        return reply('admin.prop.setHouses', { ok: true });
      }

      if (t === 'admin.prop.mortgage') {
        const idx = msg.idx | 0;
        const setTo = !!msg.setTo;
        const deed = state.properties[idx];
        if (!deed) return reject('invalid');
        const owner = deed.owner;
        if (owner == null) return reject('owner');
        const res = engineMortgage(state, owner, idx, setTo);
        if (!res?.ok) return reject(res?.error || 'error');
        state.rev++;
        broadcast(ws.gameId, 'state', toWire(state));
        await scheduleSave(ws.gameId, state);
        return reply('admin.prop.mortgage', { ok: true });
      }

      if (t === 'admin.prop.buy') {
        const idx = msg.idx | 0;
        const pid = msg.pid | 0;
        const sq = BOARD[idx];
        const deed = state.properties[idx];
        if (!sq || !deed || !state.players[pid]) return reject('invalid');
        if (deed.owner != null) return reject('owned');
        const price = (msg.price != null ? (msg.price|0) : (sq.price|0));
        if ((state.players[pid].cash|0) < price) return reject('cash');
        debit(state, pid, price);
        deed.owner = pid;
        state.rev++;
        pushLog(state, { type:'buy', pid, idx, price });
        broadcast(ws.gameId, 'state', toWire(state));
        await scheduleSave(ws.gameId, state);
        return reply('admin.prop.buy', { ok: true });
      }

      if (t === 'admin.prop.setRent') {
        const idx = msg.idx | 0;
        const amount = msg.amount;
        if (!ensureIdx(idx)) return reject('idx');
        state.rentOverrides ||= {};
        if (amount == null) delete state.rentOverrides[idx];
        else state.rentOverrides[idx] = Math.max(0, amount | 0);
        state.rev++;
        broadcast(ws.gameId, 'state', toWire(state));
        await scheduleSave(ws.gameId, state);
        return reply('admin.prop.setRent', { ok: true });
      }

      // Auctions
      if (t === 'admin.auction.start') {
        const idx = msg.idx | 0;
        const sq = BOARD[idx];
        const deed = state.properties[idx];
        if (!sq || !deed || !isBuyable(sq) || deed.owner != null) return reject('invalid');
        const participants = state.players.filter(p=>p && !p.bankrupt).map(p=>p.id);
        state.auction = { idx, bid:0, leader:null, active:true, participants, endsAt: Date.now() + 20000 };
        state.phase = 'auction';
        state.rev++;
        pushLog(state, { type:'auction.start', idx });
        broadcast(ws.gameId, 'state', toWire(state));
        await scheduleSave(ws.gameId, state);
        return reply('admin.auction.start', { ok:true });
      }

      if (t === 'admin.auction.cancel') {
        state.auction = null;
        state.phase = 'awaitRoll';
        state.rev++;
        broadcast(ws.gameId, 'state', toWire(state));
        await scheduleSave(ws.gameId, state);
        return reply('admin.auction.cancel', { ok:true });
      }

      // Deck tools
      if (t === 'admin.deck.reorderTop') {
        const deck = msg.deck === 'chest' ? 'chest' : 'chance';
        const top = Array.isArray(msg.top) ? msg.top.map(x=>x|0) : [];
        const d = state.decks[deck] || [];
        // remove occurrences of these indices first
        const rest = d.filter(x => !top.includes(x));
        state.decks[deck] = [...top, ...rest];
        state.rev++;
        broadcast(ws.gameId, 'state', toWire(state));
        await scheduleSave(ws.gameId, state);
        return reply('admin.deck.reorderTop', { ok:true });
      }

      if (t === 'admin.deck.burnTop') {
        const deck = msg.deck === 'chest' ? 'chest' : 'chance';
        let n = Math.max(1, msg.n | 0);
        while (n-- > 0 && state.decks[deck].length > 0) {
          const idx = state.decks[deck].shift();
          state.decks.discards[deck].push(idx);
        }
        state.rev++;
        broadcast(ws.gameId, 'state', toWire(state));
        await scheduleSave(ws.gameId, state);
        return reply('admin.deck.burnTop', { ok:true });
      }

      if (t === 'admin.deck.insertTop') {
        const deck = msg.deck === 'chest' ? 'chest' : 'chance';
        const idx = msg.idx | 0;
        // Remove any existing occurrence, then unshift
        state.decks[deck] = (state.decks[deck] || []).filter(x => x !== idx);
        state.decks[deck].unshift(idx);
        state.rev++;
        broadcast(ws.gameId, 'state', toWire(state));
        await scheduleSave(ws.gameId, state);
        return reply('admin.deck.insertTop', { ok:true });
      }

      // Undo: restore last N prior states (in-memory history not persisted)
      if (t === 'admin.undo') {
        const n = Math.max(1, msg.n | 0);
        const hist = (games.get(ws.gameId)._history ||= []);
        if (hist.length === 0) return reject('empty');
        let snap = null;
        for (let i=0; i<n && hist.length>0; i++) snap = hist.pop();
        if (!snap) return reject('empty');
        games.get(ws.gameId).state = normalizeState(JSON.parse(JSON.stringify(snap)));
        const newState = games.get(ws.gameId).state;
        newState.rev++;
        broadcast(ws.gameId, 'state', toWire(newState));
        await scheduleSave(ws.gameId, newState);
        return reply('admin.undo', { ok:true });
      }

      return reject('admin.unknown');
    }

    reject('bad.type', {
      type: String(t)
    });
  });

  ws.send(JSON.stringify({ version: PROTOCOL_VERSION, type: 'hello', payload: { version: PROTOCOL_VERSION } }));
});

/* ------------ Heartbeat + timers ------------ */

const interval = setInterval(() => {
  wss.clients.forEach(ws => {
    if (ws.isAlive === false) {
      ws.terminate();
      return;
    }
    ws.isAlive = false;
    try {
      ws.ping();
    } catch {}
  });

  games.forEach(async (game, gameId) => {
    const st = game.state;

    if (
      st?.turnTimer?.enabled &&
      st.turnExpiresAt &&
      Date.now() > st.turnExpiresAt &&
      st.phase !== 'auction' &&
      !st.rollBlocked
    ) {
      passTurn(st);
      st.rev++;
      pushLog(st, {
        type: 'timer.turn.auto'
      });
      broadcast(
        gameId,
        'state',
        toWire(st)
      );
      await scheduleSave(gameId, st);
    }

    if (
      st?.auction?.active &&
      st.auction.endsAt &&
      Date.now() > st.auction.endsAt
    ) {
      const auc = st.auction;
      const deed =
        st.properties[auc.idx];

      if (
        auc.leader != null &&
        auc.bid > 0
      ) {
        const winner =
          st.players[auc.leader];
        if (
          winner &&
          !winner.bankrupt &&
          winner.cash >= auc.bid
        ) {
          debit(
            st,
            auc.leader,
            auc.bid
          );
          deed.owner = auc.leader;
          pushLog(st, {
            type: 'auction.win',
            pid: auc.leader,
            idx: auc.idx,
            price: auc.bid
          });
          pushEvent(gameId, 'AuctionWon', { pid: auc.leader, idx: auc.idx, price: auc.bid });
        } else {
          pushLog(st, {
            type: 'auction.none',
            idx: auc.idx
          });
        }
      } else {
        pushLog(st, {
          type: 'auction.none',
          idx: auc.idx
        });
      }

      st.auction = null;
      st.phase = 'awaitRoll';
      st.rev++;
      checkWinner(st);
      broadcast(
        gameId,
        'state',
        toWire(st)
      );
      await scheduleSave(gameId, st);
    }
  });
}, 30000);

wss.on('close', () => clearInterval(interval));

/* ------------ Start ------------ */

const PORT = Number(process.env.PORT || 3000);
server.listen(PORT, () => {
  const addr = server.address();
  const port =
    addr && typeof addr === 'object'
      ? addr.port
      : PORT;
  console.log(`http://localhost:${port}`);
});
