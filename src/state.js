import { PROPS, groupMembers } from "../public/js/props.js";

// Single source of truth for schema version across server modules
export const SCHEMA_VERSION = 1;

// Canonical game state
export const STATE = {
  schemaVersion: SCHEMA_VERSION,
  stateRev: 1,
  nameEpoch: 1,
  playerNames: ["P1","P2","P3","P4","P5","P6"],
  playerPos:   [0,0,0,0,0,0],
  properties:  Array.from({length: PROPS.length}, () => ({ owner:0, houses:0, hotel:0 })),
  dice: { a:0, b:0, by:-1, at:0, seq:0 },
  turn: { order:[0,1,2,3,4,5], active:0, rev:1, doublesBy:-1, doublesCount:0 },
  money:  [1500,1500,1500,1500,1500,1500],
  inJail: [false,false,false,false,false,false],
  jailTries: [0,0,0,0,0,0],
  enabled: [true,true,true,true,true,true],
  debugForceDoubles: false,
  cards: null, // filled by rules.initCards()
};

// ---- Util helpers (kept tiny and side-effect free) ----
export const clamp = (n,a,b) => Math.max(a, Math.min(b, n|0));
export function clampPos(v){ v = v|0; v %= 40; return v < 0 ? v + 40 : v; }
export function uniqPlayers(arr){
  const out=[]; const seen=new Set();
  for(const n of arr||[]){ const x=n|0; if(x>=0&&x<6&&!seen.has(x)){ seen.add(x); out.push(x); } }
  return out.length ? out : [0,1,2,3,4,5];
}

// Bank inventory helpers
export function countHousesInUse(state = STATE){
  let n = 0; for (let i=0;i<state.properties.length;i++) n += (state.properties[i]?.houses|0); return n|0;
}
export function countHotelsInUse(state = STATE){
  let n = 0; for (let i=0;i<state.properties.length;i++) n += ((state.properties[i]?.hotel)?1:0); return n|0;
}
export function bankHousesAvailable(state = STATE){ return 32 - countHousesInUse(state); }
export function bankHotelsAvailable(state = STATE){ return 12 - countHotelsInUse(state); }

// Turn helpers
export function nextEnabledActive(state = STATE, step=1){
  const ord = state.turn.order;
  const L = ord.length;
  if (!L) { state.turn.active = 0; return; }
  let i = ((state.turn.active|0) + step) % L; if (i < 0) i += L;
  for (let tries=0; tries<L; tries++){
    const pIdx = ord[i]|0;
    if (state.enabled[pIdx]) { state.turn.active = i; return; }
    i = (i+1) % L;
  }
  state.turn.active = 0;
}
export function setOrderKeepEnabled(state = STATE, newOrder){
  const ord = uniqPlayers(newOrder).filter(i => state.enabled[i]);
  state.turn.order = ord.length ? ord : state.enabled.map((v,i)=>v?i:null).filter(v=>v!=null);
  state.turn.active = clamp(state.turn.active, 0, Math.max(0, state.turn.order.length-1));
  state.turn.rev = (state.turn.rev|0)+1;
}

// Property improvement rules (even-build etc.). Returns an array of info messages.
export function applyPropertyPatchByRules(state, idx, patch, { debitFn } = {}){
  const messages = [];
  const s = state.properties[idx];
  const prop = PROPS[idx];

  // Owner may always change (0-6, where 0=bank/unowned, 1..6 players)
  s.owner = clamp(patch.owner ?? s.owner, 0, 6);

  // Non-street: clear improvements
  if (prop.type !== 'street') { s.houses = 0; s.hotel = 0; return messages; }

  let desiredHotel  = (patch.hotel ?? s.hotel) ? 1 : 0;
  let desiredHouses = clamp(patch.houses ?? s.houses, 0, 4);

  const owner = s.owner|0;
  const ownerIdx = owner>0 ? owner-1 : -1;
  const idxs = groupMembers(prop.group);
  const hasMon = owner>0 && idxs.every(gi => (state.properties[gi].owner|0) === owner);

  // If attempting to add a hotel, evaluate and apply that first using current houses,
  // so we don't accidentally zero out houses before checking prerequisites.
  if (desiredHotel && (s.hotel|0)===0) {
    const ok = hasMon && idxs.every(gi => ((state.properties[gi].hotel|0) > 0) || ((state.properties[gi].houses|0) >= 4));
    if (ok) {
      if (bankHotelsAvailable(state) <= 0) {
        messages.push("Bank is out of hotels");
      } else {
        if (ownerIdx>=0 && typeof debitFn === 'function') debitFn(ownerIdx, prop.house|0);
        s.hotel = 1; s.houses = 0;
      }
    } else {
      messages.push("Hotel needs 4 houses on all in the color group");
    }
  }

  // Handle house changes only when not placing a hotel this turn
  if (!desiredHotel && desiredHouses > (s.houses|0)) {
    if (!hasMon) {
      messages.push("Need monopoly to build houses");
    } else {
      let availHouses = bankHousesAvailable(state);
      while ((s.houses|0) < desiredHouses && (s.hotel|0)===0) {
        // Find current minimum across group (hotel counts as 5)
        let minH = Infinity;
        for (const gi of idxs) {
          const ps = state.properties[gi];
          const h = (ps.hotel>0) ? 5 : (ps.houses|0);
          if (h < minH) minH = h;
        }
        if ((s.houses|0) > minH) { messages.push("Even-build rule: add houses on lower properties first"); break; }
        if (availHouses <= 0) { messages.push("Bank is out of houses"); break; }
        if (ownerIdx>=0 && typeof debitFn === 'function') debitFn(ownerIdx, prop.house|0);
        s.houses = (s.houses|0) + 1;
        availHouses -= 1;
      }
    }
  } else if (!desiredHotel && desiredHouses < (s.houses|0)) {
    // Selling/adjusting down: credit half price per house (caller handles credit broadcast)
    const current = (s.houses|0);
    const target = desiredHouses|0;
    const removed = Math.max(0, current - target);
    s.houses = target;
    // Caller decides about refund side-effects; we just mutate houses here
  }

  if (!desiredHotel && (s.hotel|0)===1) {
    s.hotel = 0; s.houses = 0;
  }
  return messages;
}
