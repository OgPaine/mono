import fs from "fs";
import path from "path";
import { STATE, SCHEMA_VERSION, clamp, clampPos, uniqPlayers } from "./state.js";
import { PROPS, CHANCE_CARDS, CHEST_CARDS } from "../public/js/props.js";

const fsp = fs.promises;

let STATE_FILE = null;
let STATE_BAK_FILE = null;

export function configurePaths(baseDir){
  STATE_FILE = path.join(baseDir, "state.json");
  STATE_BAK_FILE = path.join(baseDir, "state.json.bak");
}

export async function safeWriteFileAtomic(filePath, data){
  const tmp = `${filePath}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  try { await fsp.writeFile(tmp, data, "utf8"); }
  catch (err) { try { await fsp.rm(tmp, { force: true }); } catch {}; throw err; }
  try {
    if (fs.existsSync(filePath)) {
      try { await fsp.copyFile(filePath, STATE_BAK_FILE); } catch {}
    }
    try { await fsp.rename(tmp, filePath); }
    catch (e1) { try { await fsp.rm(filePath, { force: true }); } catch {}; await fsp.rename(tmp, filePath); }
  } catch (err) { try { await fsp.rm(tmp, { force: true }); } catch {}; throw err; }
}

let saveTimer = null;
const SAVE_DEBOUNCE_MS = 100;
export function scheduleSave(){
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { saveTimer = null; writeState().catch(()=>{}); }, SAVE_DEBOUNCE_MS);
}

export function exportState(){
  // Minimal export; server augments with buildPatchPayload
  const names = Array.from({ length: 6 }, (_, i) => String(STATE.playerNames?.[i] ?? `P${i+1}`).slice(0, 18));
  const positions = Array.from({ length: 6 }, (_, i) => clampPos(STATE.playerPos?.[i] ?? 0));
  const properties = Array.from({ length: STATE.properties.length }, (_, i) => {
    const p = STATE.properties?.[i] ?? {};
    const hotel = (p.hotel ?? 0) ? 1 : 0;
    return { owner: clamp(p.owner ?? 0, 0, 6), houses: hotel ? 0 : clamp(p.houses ?? 0, 0, 4), hotel };
  });
  const dice = { a: STATE.dice?.a|0, b: STATE.dice?.b|0, by: (STATE.dice?.by ?? -1)|0, at: STATE.dice?.at|0, seq: STATE.dice?.seq|0 };
  const order = Array.isArray(STATE.turn?.order) ? uniqPlayers(STATE.turn.order) : [0,1,2,3,4,5];
  const activeMax = Math.max(0, order.length - 1);
  const turn = { order, active: clamp(STATE.turn?.active ?? 0, 0, activeMax), rev: STATE.turn?.rev|0, doublesBy: clamp(STATE.turn?.doublesBy ?? -1, -1, 5), doublesCount: clamp(STATE.turn?.doublesCount ?? 0, 0, 10) };
  const chance = STATE.cards?.chance ?? {};
  const chest = STATE.cards?.chest ?? {};
  const last = STATE.cards?.last ?? { deck:"", id:"", text:"", by:-1, at:0, action:"" };
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
    cards: {
      chance: { draw: Array.isArray(chance.draw) ? [...chance.draw] : [], discard: Array.isArray(chance.discard) ? [...chance.discard] : [], gojHolder: clamp(chance.gojHolder ?? -1, -1, 5) },
      chest:  { draw: Array.isArray(chest.draw) ? [...chest.draw] : [], discard: Array.isArray(chest.discard) ? [...chest.discard] : [], gojHolder: clamp(chest.gojHolder ?? -1, -1, 5) },
      last,
    },
  };
}

export async function writeState(){
  if (!STATE_FILE) throw new Error("persistence not configured: STATE_FILE");
  const data = JSON.stringify(exportState(), null, 2);
  await safeWriteFileAtomic(STATE_FILE, data);
}

function tryReadJSON(file){
  try {
    if (!fs.existsSync(file)) return null;
    const raw = fs.readFileSync(file, "utf8");
    if (!raw.trim()) return null;
    return JSON.parse(raw);
  } catch { return null; }
}

function migrateState(data){
  if (!data || typeof data !== "object") return null;
  let cur = { ...data };
  const ver = (cur.schemaVersion|0) || 0;
  if (ver < 1) {
    cur.stateRev = (cur.stateRev|0) || 1;
    cur.nameEpoch = (cur.nameEpoch|0) || 1;
    if (!Array.isArray(cur.playerNames)) cur.playerNames = ["P1","P2","P3","P4","P5","P6"];
    if (!Array.isArray(cur.playerPos))   cur.playerPos   = [0,0,0,0,0,0];
    if (!Array.isArray(cur.properties))  cur.properties  = Array.from({length:PROPS.length}, () => ({ owner:0, houses:0, hotel:0 }));
    if (!cur.dice) cur.dice = { a:0, b:0, by:-1, at:0, seq:0 };
    if (!cur.turn) cur.turn = { order:[0,1,2,3,4,5], active:0, rev:1, doublesBy:-1, doublesCount:0 };
    if (!Array.isArray(cur.money))  cur.money  = [1500,1500,1500,1500,1500,1500];
    if (!Array.isArray(cur.inJail)) cur.inJail = [false,false,false,false,false,false];
    if (!Array.isArray(cur.jailTries)) cur.jailTries = [0,0,0,0,0,0];
    if (!Array.isArray(cur.enabled)) cur.enabled = [true,true,true,true,true,true];
    if (!cur.cards) cur.cards = { chance: { draw: CHANCE_CARDS.map((_,i)=>i), discard: [], gojHolder:-1 }, chest: { draw: CHEST_CARDS.map((_,i)=>i), discard: [], gojHolder:-1 }, last:{ deck:"", id:"", text:"", by:-1, at:0 } };
  }
  cur.schemaVersion = SCHEMA_VERSION;
  return cur;
}

export function loadStateFromDisk(){
  if (!STATE_FILE) throw new Error("persistence not configured: STATE_FILE");
  let data = tryReadJSON(STATE_FILE) || tryReadJSON(STATE_BAK_FILE);
  if (!data) return false;
  if ((data?.schemaVersion|0) !== SCHEMA_VERSION){
    data = migrateState(data);
    if (!data) return false;
  }
  STATE.stateRev = Math.max((data.stateRev|0) || 1, STATE.stateRev|0);
  STATE.nameEpoch = (data.nameEpoch|0) || 1;
  for (let i=0;i<6;i++){
    STATE.playerNames[i] = String(data.playerNames?.[i] ?? `P${i+1}`).slice(0, 18);
    STATE.playerPos[i] = clampPos(data.playerPos?.[i] ?? 0);
    STATE.money[i] = (data.money?.[i] ?? 1500)|0;
    STATE.inJail[i] = !!(data.inJail?.[i] ?? false);
    STATE.jailTries[i] = (data.jailTries?.[i] ?? 0)|0;
    STATE.enabled[i] = !!(data.enabled?.[i] ?? true);
  }
  const props = Array.isArray(data.properties) ? data.properties : [];
  for (let i=0;i<STATE.properties.length;i++){
    const src = props[i] || {}; const dst = STATE.properties[i];
    const hotel = (src.hotel ?? dst.hotel) ? 1 : 0;
    dst.owner = clamp(src.owner ?? dst.owner, 0, 6);
    dst.houses = hotel ? 0 : clamp(src.houses ?? dst.houses, 0, 4);
    dst.hotel = hotel;
  }
  if (data.dice) STATE.dice = { a: data.dice.a|0, b: data.dice.b|0, by: (data.dice.by ?? -1)|0, at: data.dice.at|0, seq: data.dice.seq|0 };
  if (data.turn) {
    const ord = Array.isArray(data.turn.order) ? uniqPlayers(data.turn.order) : STATE.turn.order;
    STATE.turn.order = ord;
    STATE.turn.active = clamp(data.turn.active ?? STATE.turn.active, 0, Math.max(0, ord.length-1));
    STATE.turn.rev = (data.turn.rev ?? STATE.turn.rev)|0;
    STATE.turn.doublesBy = clamp(data.turn.doublesBy ?? STATE.turn.doublesBy ?? -1, -1, 5);
    STATE.turn.doublesCount = clamp(data.turn.doublesCount ?? STATE.turn.doublesCount ?? 0, 0, 10);
  }
  if (data.cards){
    const chance = data.cards.chance || {}; const chest = data.cards.chest || {}; const last = data.cards.last || {};
    STATE.cards = {
      chance: {
        draw: Array.isArray(chance.draw) ? chance.draw.slice() : CHANCE_CARDS.map((_,i)=>i),
        discard: Array.isArray(chance.discard) ? chance.discard.slice() : [],
        gojHolder: clamp(chance.gojHolder ?? -1, -1, 5),
      },
      chest: {
        draw: Array.isArray(chest.draw) ? chest.draw.slice() : CHEST_CARDS.map((_,i)=>i),
        discard: Array.isArray(chest.discard) ? chest.discard.slice() : [],
        gojHolder: clamp(chest.gojHolder ?? -1, -1, 5),
      },
      last: { deck: String(last.deck ?? ""), id: String(last.id ?? ""), text: String(last.text ?? ""), by: clamp(last.by ?? -1, -1, 5), at: last.at|0, action: last.action ? String(last.action) : "" }
    };
  }
  return true;
}

