import { PROPS } from "./props.js";

const SCHEMA_VERSION = 1;
const CACHE_KEY = "mono:state";
const DEBUG = true;
const log = (...a) => { if (DEBUG) console.debug("[wire]", ...a); };

const clamp = (n,a,b) => Math.max(a, Math.min(b, n|0));
function clampPos(v){ v = v|0; v %= 40; if (v < 0) v += 40; return v; }
function uniqPlayers(arr){
  const out=[]; const seen=new Set();
  for(const n of arr||[]){ const x=n|0; if(x>=0&&x<6&&!seen.has(x)){ seen.add(x); out.push(x); } }
  return out.length ? out : [0,1,2,3,4,5];
}

const DEFAULT_STATE = {
  schemaVersion: SCHEMA_VERSION,
  stateRev: 1,
  nameEpoch: 1,
  playerNames: ["P1","P2","P3","P4","P5","P6"],
  playerPos:   [0,0,0,0,0,0],
  properties:  PROPS.map(() => ({ owner:0, houses:0, hotel:0 })),
  dice: { a:0, b:0, by:-1, at:0, seq:0 },
  turn: { order:[0,1,2,3,4,5], active:0, rev:1 },
  money:  [1500,1500,1500,1500,1500,1500],
  inJail: [false,false,false,false,false,false],
  jailTries: [0,0,0,0,0,0],
  debugForceDoubles: false,
  cardsLast: null,
  cardsHolding: { chanceGOJ:-1, chestGOJ:-1 },
  enabled: [true,true,true,true,true,true],
};

export function makeWire(opts = {}){
  const listeners = [];
  const state = structuredClone(DEFAULT_STATE);

  let assignedRole = "viewer";
  let assignedIdx = -1;
  const roleState = { role: assignedRole, idx: assignedIdx };
  const roleListeners = new Set();

  function sanitizeRole(role, idx){
    if (typeof role === "string"){
      const norm = role.toLowerCase();
      if (norm === "gm") return { role: "gm", idx: -1 };
      if (norm === "player") {
        const num = Number(idx);
        if (Number.isFinite(num)) {
          const n = Math.trunc(num);
          if (n >= 0 && n <= 5) return { role: "player", idx: n };
        }
      }
    }
    return { role: "viewer", idx: -1 };
  }

  function emitRole(){
    for (const fn of roleListeners){
      try { fn({ role: assignedRole, idx: assignedIdx }); } catch (err) { console.error(err); }
    }
  }

  function applyRole(role, idx){
    const next = sanitizeRole(role, idx);
    if (next.role !== assignedRole || next.idx !== assignedIdx){
      assignedRole = next.role;
      assignedIdx = next.idx;
      roleState.role = assignedRole;
      roleState.idx = assignedIdx;
      emitRole();
    }
  }

  function onRole(fn){
    if (typeof fn !== "function") return () => {};
    roleListeners.add(fn);
    try { fn({ role: assignedRole, idx: assignedIdx }); } catch (err) { console.error(err); }
    return () => roleListeners.delete(fn);
  }

  function getRole(){
    return { role: assignedRole, idx: assignedIdx };
  }

  applyRole(opts.role, opts.idx);

  function emit(){ for (const fn of listeners) try{ fn(state); }catch(e){ console.error(e); } }
  function save(){
    try{
      const payload = { schemaVersion: SCHEMA_VERSION, state };
      localStorage.setItem(CACHE_KEY, JSON.stringify(payload));
    }catch{}
  }

  // hydrate optional cache
  try{
    const cachedRaw = JSON.parse(localStorage.getItem(CACHE_KEY)||"null");
    if (cachedRaw && cachedRaw.schemaVersion === SCHEMA_VERSION && cachedRaw.state){
      merge(cachedRaw.state);
      if (Number.isFinite(Number(cachedRaw.state.stateRev))) {
        state.stateRev = Math.max(state.stateRev|0, Math.trunc(Number(cachedRaw.state.stateRev)));
      }
    } else if (cachedRaw != null) {
      localStorage.removeItem(CACHE_KEY);
    }
  }catch{
    localStorage.removeItem(CACHE_KEY);
  }
  state.schemaVersion = SCHEMA_VERSION;
  state.stateRev = state.stateRev|0 || 1;

  const currentRev = () => state.stateRev|0;
  function extractStateRev(msg){
    if (!msg || typeof msg !== "object") return null;
    if (Number.isFinite(Number(msg.stateRev))) return Math.trunc(Number(msg.stateRev));
    if (msg.payload && Number.isFinite(Number(msg.payload.stateRev))) return Math.trunc(Number(msg.payload.stateRev));
    if (msg.data && typeof msg.data === "object" && Number.isFinite(Number(msg.data.stateRev))) return Math.trunc(Number(msg.data.stateRev));
    return null;
  }
  function extractSchemaVersion(msg){
    if (!msg || typeof msg !== "object") return null;
    if (Number.isFinite(Number(msg.schemaVersion))) return Math.trunc(Number(msg.schemaVersion));
    if (msg.payload && Number.isFinite(Number(msg.payload.schemaVersion))) return Math.trunc(Number(msg.payload.schemaVersion));
    return null;
  }

  // ---- WebSocket
  const WS_URL = (() => {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    return `${proto}//${location.host}/ws`; // match server path
  })();

  let ws = null, reconnectTimer = null;
  function schedule(){ if(!reconnectTimer){ reconnectTimer=setTimeout(()=>{ reconnectTimer=null; connect(); },1000); } }

  function connect(){
    try{ ws = new WebSocket(WS_URL); } catch { schedule(); return; }
    ws.onopen = () => {
      log("ws:open", WS_URL);
      const current = getRole();
      if (current.role === 'gm' || current.role === 'player'){
        const idx = current.role === 'player' ? current.idx : -1;
        try { ws.send(JSON.stringify({ type:"hello", role: current.role, idx })); } catch {}
      }
    };
    ws.onerror = (e) => { log("ws:error", e?.message||e); try{ ws.close(); }catch{} };
    ws.onclose = () => { log("ws:close"); schedule(); };
    ws.onmessage = (ev) => {
      let msg; try{ msg = JSON.parse(ev.data); }catch{ return; }
      if (DEBUG) log("ws:msg", msg.type, msg);
      const schema = extractSchemaVersion(msg);
      if (schema && schema !== SCHEMA_VERSION) {
        log("ws:schema-mismatch", { received: schema, expected: SCHEMA_VERSION });
        try { localStorage.removeItem(CACHE_KEY); }catch{}
        setTimeout(() => location.reload(), 0);
        return;
      }
      const incomingRev = extractStateRev(msg);
      if (incomingRev !== null) {
        const current = currentRev();
        if (incomingRev < current) {
          if (DEBUG) log("ws:stale", msg.type, incomingRev, current);
          return;
        }
        if (incomingRev > current) state.stateRev = incomingRev;
      }

      switch(msg.type){
        case "state": merge(msg.payload); save(); emit(); break;
        case "patch": merge(msg.payload); save(); emit(); break;
        case "cards:drawn": {
          const deck = (msg.data?.deck||"" ).toLowerCase();
          const by = (msg.data?.by|0);
          const action = msg.data?.action||"";
          state.cardsLast = { deck, id: msg.data?.id||"", text: msg.data?.text||"", by, action };
          if (action === "hold"){
            if (deck === "chance") state.cardsHolding.chanceGOJ = by;
            if (deck === "chest")  state.cardsHolding.chestGOJ  = by;
          }
          save(); emit(); break;
        }
        case "cards:gojUsed": {
          const deck = (msg.data?.deck||"" ).toLowerCase();
          if (deck === "chance") state.cardsHolding.chanceGOJ = -1;
          if (deck === "chest")  state.cardsHolding.chestGOJ  = -1;
          save(); emit(); break;
        }
        case "money":
          if (Array.isArray(msg.data)){
            state.money = msg.data.slice(0,6).map(v => (v|0));
            save(); emit();
          }
          break;
        case "playerNames":
          for (let i=0;i<6;i++) state.playerNames[i] = String(msg.data[i]||`P${i+1}`).slice(0,18);
          save(); emit(); break;
        case "playerPos":
          for (let i=0;i<6;i++) state.playerPos[i] = clampPos(msg.data[i]||0);
          save(); emit(); break;
        case "enabled":
          state.enabled = msg.data.slice(0,6).map(Boolean);
          save(); emit(); break;
        case "property": {
          const { index, data } = msg;
          const p = state.properties[index]; if (!p) break;
          p.owner  = clamp((data?.owner|0), 0, 6);
          p.houses = clamp((data?.houses|0), 0, 4);
          p.hotel  = (data?.hotel?1:0);
          if (p.hotel) p.houses = 0;
          save(); emit(); break;
        }
        case "dice":
          state.dice = {
            a: msg.data.a|0, b: msg.data.b|0,
            by: (msg.data.by??-1)|0, at: msg.data.at|0, seq: msg.data.seq|0
          };
          save(); emit(); break;
        case "turn": {
          const t = msg.data || {};
          state.turn.order  = uniqPlayers(t.order ?? state.turn.order);
          state.turn.active = clamp((t.active ?? state.turn.active)|0, 0, Math.max(0, state.turn.order.length-1));
          state.turn.rev    = (t.rev ?? ((state.turn.rev|0)+1))|0;
          save(); emit(); break;
        }
        case "role": {
          const payload = msg.data ?? msg;
          applyRole(payload?.role, payload?.idx);
          break;
        }
        case "debug":
          console.warn("[server]", msg.level||"info", msg.msg, msg.data||{});
          break;
      }
    };
  }
  connect();

  function merge(src){
    if (!src || typeof src!=="object") return;
    if (Number.isFinite(Number(src.stateRev))) {
      const rev = Math.trunc(Number(src.stateRev));
      if (rev > (state.stateRev|0)) state.stateRev = rev;
    }
    if (Number.isFinite(Number(src.schemaVersion))) {
      state.schemaVersion = Math.trunc(Number(src.schemaVersion));
    }
    if ("nameEpoch" in src) state.nameEpoch = src.nameEpoch|0;
    if (Array.isArray(src.playerNames)) for (let i=0;i<6;i++) state.playerNames[i] = String(src.playerNames[i] ?? state.playerNames[i] ?? `P${i+1}`).slice(0,18);
    if (Array.isArray(src.playerPos))   for (let i=0;i<6;i++) state.playerPos[i] = clampPos(src.playerPos[i] ?? state.playerPos[i] ?? 0);
    if (Array.isArray(src.properties)) {
      const n = Math.min(state.properties.length, src.properties.length);
      for (let i=0;i<n;i++){
        const sp = src.properties[i]||{}, dp = state.properties[i];
        dp.owner  = clamp((sp.owner ?? dp.owner)|0, 0, 6);
        dp.houses = clamp((sp.houses ?? dp.houses)|0, 0, 4);
        dp.hotel  = (sp.hotel ?? dp.hotel) ? 1 : 0;
        if (dp.hotel) dp.houses = 0;
      }
    }
    if (src.dice) {
      state.dice = {
        a: src.dice.a|0, b: src.dice.b|0,
        by: (src.dice.by??-1)|0, at: src.dice.at|0, seq: src.dice.seq|0
      };
    }
    if (src.turn){
      const ord = uniqPlayers(src.turn.order ?? state.turn.order);
      state.turn.order  = ord;
      state.turn.active = clamp((src.turn.active ?? state.turn.active)|0, 0, Math.max(0, ord.length-1));
      state.turn.rev    = (src.turn.rev ?? state.turn.rev ?? 1)|0;
    }
    if (Array.isArray(src.money)) state.money = src.money.slice(0,6).map(v => (v|0));
    if (Array.isArray(src.inJail)) state.inJail = src.inJail.slice(0,6).map(Boolean);
    if (Array.isArray(src.jailTries)) state.jailTries = src.jailTries.slice(0,6).map(v => (v|0));
    if (typeof src.debugForceDoubles === 'boolean') state.debugForceDoubles = !!src.debugForceDoubles;
    if (src.cardsLast) state.cardsLast = {
      deck: src.cardsLast.deck||'', id: src.cardsLast.id||'', text: src.cardsLast.text||'',
      by: (src.cardsLast.by|0), action: src.cardsLast.action||''
    };
    if (src.cardsHolding) state.cardsHolding = {
      chanceGOJ: (src.cardsHolding.chanceGOJ|0),
      chestGOJ:  (src.cardsHolding.chestGOJ|0),
    };
    if (Array.isArray(src.enabled)) state.enabled = src.enabled.slice(0,6).map(Boolean);
  }

  // ---- API
  function on(fn){ listeners.push(fn); }
  function send(obj){
    try{
      if (ws && ws.readyState===1){
        const payload = { ...obj, stateRev: currentRev(), schemaVersion: SCHEMA_VERSION };
        if (DEBUG) log("ws:send", payload);
        ws.send(JSON.stringify(payload));
      }
    }catch{}
  }

  const updateProperty   = (index, patch)              => send({ type:"updateProperty", index:index|0, patch:patch||{} });
  const setPlayerName    = (index, name)               => send({ type:"setPlayerName", index:index|0, name:String(name||"").slice(0,20) });
  const setPlayerPos     = (index, pos)                => send({ type:"setPlayerPos", index:index|0, pos: clampPos(pos) });
  const setPlayerEnabled = (index, enabled)            => send({ type:"player:enabled", index:index|0, enabled: !!enabled });
  const setTurnOrder     = (order)                     => send({ type:"turn:setOrder", order: uniqPlayers(order) });
  const setActive        = (index)                     => send({ type:"turn:setActive", index:index|0 });
  const nextTurn         = (delta=1)                   => send({ type:"turn:next", delta: delta|0 });
  const rollDice         = (byIdx, opts={})            => send({ type:"rollDice", by: byIdx|0, autoMove: !!opts.autoMove, requireTurn: !!opts.requireTurn });
  const resetAll         = ()                          => send({ type:"resetAll" });
  const setForceDoubles  = (value)                     => send({ type:"debug:forceDoubles", value: !!value });
  const drawCard         = (deck='chance', byIdx=null) => send({ type:"cards:draw", deck: String(deck||'chance'), by: (byIdx==null? undefined : (byIdx|0)) });
  const useGetOutOfJail  = (deck=null, byIdx=null)     => send({ type:"player:useGOJ", deck: (deck?String(deck):undefined), index: (byIdx==null? undefined : (byIdx|0)) });

  if (!('wire' in window)) window.wire = { on, onRole, getRole, roleState, state, updateProperty, setPlayerName, setPlayerPos, setPlayerEnabled, setTurnOrder, setActive, nextTurn, rollDice, resetAll, setForceDoubles, drawCard, useGetOutOfJail };

  emit();
  return { state, on, onRole, getRole, roleState, updateProperty, setPlayerName, setPlayerPos, setPlayerEnabled, setTurnOrder, setActive, nextTurn, rollDice, resetAll, setForceDoubles, drawCard, useGetOutOfJail };
}
