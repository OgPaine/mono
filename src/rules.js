import { PROPS, isStreet, isRR, isUtil, CHANCE_CARDS, CHEST_CARDS, boardIndexToPropIndex, rent as calcRent } from "../public/js/props.js";
import { STATE, clamp, clampPos } from "./state.js";

// Cards init/shuffle
function shuffle(arr){ const a = arr.slice(); for (let i=a.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); [a[i],a[j]]=[a[j],a[i]]; } return a; }
export function initCards(){
  return {
    chance: { draw: shuffle(CHANCE_CARDS.map((_,i)=>i)), discard: [], gojHolder: -1 },
    chest:  { draw: shuffle(CHEST_CARDS.map((_,i)=>i)),  discard: [], gojHolder: -1 },
    last:   { deck:"", id:"", text:"", by:-1, at:0, action:"" },
  };
}

// Utility: nearest of a set of board indices (wrap-aware)
export function nearestOf(cur, targets){ let best=null, bestDist=999; for (const t of targets){ const d=(t-cur+40)%40; if (d>=0 && d<bestDist){ bestDist=d; best=t; } } return best ?? targets[0]; }

// Maybe charge rent for current landing square.
// deps: { credit(player, amt), debit(player, amt), dbg(tag,payload) }
export function maybeChargeRent(by, opts = {}, deps = {}){
  const { credit, debit, dbg = () => {} } = deps;
  try {
    const pos = STATE.playerPos[by] | 0;
    const pIdx = boardIndexToPropIndex[pos] ?? null;
    if (pIdx == null) return; // not a property square
    const s = STATE.properties[pIdx];
    const prop = PROPS[pIdx];
    const owner = (s?.owner|0);
    if (!owner || owner === (by+1)) return; // unowned or own property
    let due = 0;
    if (isStreet(prop) || isRR(prop)) {
      due = calcRent(STATE, pIdx) | 0;
      // Chance: nearest railroad -> double rent
      if (isRR(prop) && String(opts.card||"").toLowerCase() === "nearestrailroad") {
        due *= 2;
      }
    } else if (isUtil(prop)) {
      const cardType = String(opts.card||"").toLowerCase();
      if (cardType === "nearestutility") {
        // Card rule: roll dice and pay 10x
        const a = 1 + Math.floor(Math.random()*6);
        const b = 1 + Math.floor(Math.random()*6);
        const sum = a + b;
        due = sum * 10;
        dbg("rent:utility-card-roll", { by, pos, a, b, sum, due });
      } else {
        const da = (opts.dice?.a|0) || 0;
        const db = (opts.dice?.b|0) || 0;
        const sum = (da>0 && db>0) ? (da+db) : 0;
        if (sum <= 0) return; // no dice info; skip auto rent for utility
        const ownerIdx = owner - 1;
        let utilCount = 0;
        for (let i=0;i<PROPS.length;i++) if (isUtil(PROPS[i]) && (STATE.properties[i]?.owner|0) === owner) utilCount++;
        const mult = (utilCount >= 2) ? 10 : 4;
        due = sum * mult;
      }
    }
    if (due > 0 && typeof debit === 'function' && typeof credit === 'function') {
      const ownerIdx = owner - 1;
      debit(by, due);
      credit(ownerIdx, due);
      dbg("rent:charged", { by, to: ownerIdx, pos, propertyIndex: pIdx, amount: due, reason: opts.card?`card:${opts.card}`:(opts.dice?"dice":"move") });
    }
  } catch (err) {
    const msg = (err && (err.message||err)) || err;
    if (typeof deps.dbg === 'function') deps.dbg("rent:error", msg);
  }
}

export function refillIfEmpty(deck){ const c=deck==='chest' ? STATE.cards.chest : STATE.cards.chance; if (c.draw.length===0){ c.draw = shuffle(c.discard); c.discard = []; } }
export function cardsRef(deck){ return deck==='chest' ? STATE.cards.chest : STATE.cards.chance; }
export function cardsList(deck){ return deck==='chest' ? CHEST_CARDS : CHANCE_CARDS; }

export function drawCard(deck, by, deps = {}){
  const { credit, debit, dbg = () => {}, afterMove = () => {} } = deps;
  refillIfEmpty(deck);
  const cref = cardsRef(deck);
  if (!cref.draw.length) return null;
  const cardIdx = cref.draw.shift();
  const card = cardsList(deck)[cardIdx];
  let action = "apply";
  if (card.type === "getOutOfJail"){
    cref.gojHolder = by;
    action = "hold";
  } else {
    applyCardEffect(deck, card, by, { credit, debit, dbg, afterMove });
    cref.discard.push(cardIdx);
  }
  STATE.cards.last = { deck, id: card.id, text: card.text, by, at: Date.now(), action };
  return { deck, id: card.id, text: card.text, by, action };
}

export function applyCardEffect(deck, card, by, deps = {}){
  const { credit = () => {}, debit = () => {}, dbg = () => {}, afterMove = () => {} } = deps;
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
  if (moved){ const pos=STATE.playerPos[by]|0; if (pos===4) debit(by,200); else if (pos===38) debit(by,100); if (typeof afterMove === 'function') afterMove(by); }
}

// Jail handling for a roll. Returns info about whether moved.
export function handleJailRoll(by, a, b, { autoMove=false, credit = () => {}, debit = () => {}, afterMove = () => {} } = {}){
  const isDouble = (a === b);
  if (!STATE.inJail[by]) return { wasInJail:false, moved:false, isDouble };
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
      if (typeof afterMove === 'function') afterMove(by, { a, b });
    }
    return { wasInJail:true, moved:true, isDouble };
  }
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
      if (typeof afterMove === 'function') afterMove(by, { a, b });
    }
  }
  return { wasInJail:true, moved:false, isDouble };
}

// Simple auction model for tests and future wiring.
export const AuctionPhase = Object.freeze({ idle: "idle", bidding: "bidding", ended:"ended" });
export const Auction = { phase: "idle", propIndex: -1, highestBid: 0, highestBidder: -1, bidders: [] };
export function startAuction(propIndex, bidders){
  Auction.phase = AuctionPhase.bidding;
  Auction.propIndex = propIndex|0;
  Auction.highestBid = 0;
  Auction.highestBidder = -1;
  Auction.bidders = Array.from(new Set((bidders||[]).map(n => n|0).filter(n => n>=0 && n<6)));
}
export function placeBid(player, amount){
  if (Auction.phase !== AuctionPhase.bidding) return false;
  if (!Auction.bidders.includes(player|0)) return false;
  const amt = amount|0;
  if (amt <= Auction.highestBid) return false;
  Auction.highestBid = amt; Auction.highestBidder = player|0; return true;
}
export function endAuction(){ Auction.phase = AuctionPhase.ended; return { propIndex: Auction.propIndex, winner: Auction.highestBidder, price: Auction.highestBid }; }

// Helper to process effects after a landing (rent and cards)
export function maybeDrawLanding(by, opts = {}, deps = {}){
  const pos = STATE.playerPos[by] | 0;
  maybeChargeRent(by, opts, deps);
  if (pos===2 || pos===17 || pos===33) return drawCard("chest", by, deps);
  if (pos===7 || pos===22 || pos===36) return drawCard("chance", by, deps);
  return null;
}
