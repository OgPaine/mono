// server/rules-core.js
// Pure rules core: (state, action) => { state, events }
// This module does not perform any I/O or networking. It clones the input state
// and returns a new state plus structured events suitable for replay.

import {
  BOARD,
  CHANCE_CARDS,
  CHEST_CARDS,
  RR_RENTS,
  UTIL_MULT,
  HOUSE_COST_BY_GROUP
} from '../shared/props-data.js';

import {
  moveTo as engineMoveTo,
  buildHouse as engineBuildHouse,
  sellHouse as engineSellHouse,
  mortgage as engineMortgage,
  applyCard as engineApplyCard,
  declareBankrupt as engineDeclareBankrupt,
  estimateLiquidation,
  streetRent as engineStreetRent,
  groupMap
} from './engine.js';

const isBuyable = s => s && (s.kind === 'street' || s.kind === 'rr' || s.kind === 'util');
const clampPos = v => ((v % 40) + 40) % 40;

const deepClone = obj => JSON.parse(JSON.stringify(obj));

function rollDice(st) {
  if (st.debugNextRoll) {
    const r = st.debugNextRoll; st.debugNextRoll = null; return [r.d1|0, r.d2|0];
  }
  return [1 + ((Math.random() * 6) | 0), 1 + ((Math.random() * 6) | 0)];
}

function landOn(state, pid, diceTotal, events) {
  const p = state.players[pid]; if (!p) return;
  const sq = BOARD[p.pos]; if (!sq) return;

  if (sq.kind === 'tax') {
    const due = Math.abs(sq.amount || 0); p.cash -= due;
    events.push({ type:'TaxPaid', payload:{ pid, idx: p.pos, amount: due } });
    return;
  }

  if (sq.kind === 'gotojail') {
    p.inJail = true; p.pos = 10; p.doubles = 0; p.jailTurns = 0;
    events.push({ type:'Moved', payload:{ pid, to: 10, reason:'gotojail' } });
    return;
  }

  if (sq.kind === 'street' || sq.kind === 'rr' || sq.kind === 'util') {
    const deed = state.properties[p.pos]; const owner = deed?.owner;
    if (owner != null && owner !== pid && !deed.mortgaged) {
      let rent = engineStreetRent(state, p.pos, diceTotal);
      const override = state.rentOverrides?.[p.pos]; if (override != null) rent = override | 0;
      if (rent > 0) {
        p.cash -= rent; state.players[owner].cash += rent;
        state.lastCreditor = owner;
        events.push({ type:'PaidRent', payload:{ from: pid, to: owner, idx: p.pos, amount: rent } });
      }
    }
    return;
  }

  if (sq.kind === 'chance' || sq.kind === 'chest') {
    const deck = sq.kind === 'chance' ? 'chance' : 'chest';
    // draw top card
    const idx = (state.decks[deck] || []).shift();
    engineApplyCard(state, pid, deck, idx);
    events.push({ type:'CardDrawn', payload:{ pid, deck, idx } });
    return;
  }
}

function passTurn(state) {
  let next = (state.turn + 1) % state.players.length;
  while (state.players[next]?.bankrupt) next = (next + 1) % state.players.length;
  state.turn = next; state.phase = 'awaitRoll';
}

function checkAutoBankrupt(state, pid, events) {
  const p = state.players[pid]; if (!p || p.bankrupt) return false; if (p.cash >= 0) return false;
  const need = -p.cash; const liq = estimateLiquidation(state, pid);
  if (liq < need) { engineEngineDeclareBankruptSafe(state, pid, state.lastCreditor ?? null, events); return true; }
  return false;
}

function engineEngineDeclareBankruptSafe(state, pid, creditor, events) {
  engineApplyBankrupt(state, pid, creditor);
  events.push({ type:'Bankrupt', payload:{ pid, creditor } });
}

function engineApplyBankrupt(state, pid, creditor) {
  // call engine DeclareBankrupt but keep name the same for clarity
  engineDeclareBankrupt(state, pid, creditor);
}

export function applyAction(stateInput, action) {
  const state = deepClone(stateInput);
  const events = [];
  const type = action?.type;
  if (!type) return { state, events };

  if (type === 'roll') {
    if (state.rollBlocked) return { state, events, error:'blocked' };
    if (state.turn !== (action.pid|0)) return { state, events, error:'turn' };
    const pid = state.turn; const p = state.players[pid]; if (!p || p.bankrupt) return { state, events, error:'player' };
    const [d1,d2] = rollDice(state); const total = d1 + d2; const from = p.pos;
    state.rollTray ||= []; state.rollTray.unshift({ ts: new Date().toISOString(), pid, d1, d2, total });
    if (state.rollTray.length > 100) state.rollTray.length = 100;
    state.phase = 'awaitMoveResolution';

    if (p.inJail) {
      if (d1 === d2) { p.inJail = false; p.jailTurns = 0; }
      else {
        if ((p.jailTurns|0) >= 2) {
          if ((p.cash|0) >= 50) { p.cash -= 50; p.inJail = false; p.jailTurns = 0; events.push({ type:'Paid', payload:{ pid, amount:50, reason:'jail' } }); }
          else { const need = 50 - (p.cash|0); const liq = estimateLiquidation(state, pid); if (liq < need) { engineApplyBankrupt(state, pid, null); events.push({ type:'Bankrupt', payload:{ pid, creditor:null } }); return { state, events, bankrupt:true, jailed:true, d1, d2, total }; } else { state.phase='awaitRoll'; return { state, events, error:'must_resolve' }; }
        }
        } else { p.jailTurns = (p.jailTurns|0) + 1; return { state, events, jailed:true, d1, d2, total }; }
      }
    }

    if (d1 === d2) { p.doubles = (p.doubles|0) + 1; if (p.doubles >= 3) { p.inJail = true; p.pos = 10; p.doubles = 0; p.jailTurns = 0; events.push({ type:'Moved', payload:{ pid, from, to:10, d1, d2, total, triple:true } }); return { state, events, triple:true, d1, d2, total }; } }
    else { p.doubles = 0; }

    engineMoveTo(state, pid, from + total);
    events.push({ type:'Moved', payload:{ pid, from, to: state.players[pid].pos, d1, d2, total } });
    landOn(state, pid, total, events);

    if (checkAutoBankrupt(state, pid, events)) return { state, events, bankrupt:true };

    if (d1 !== d2 && !p.inJail) {
      return { state, events, d1, d2, total, from, to: state.players[pid].pos, extra:false };
    }
    return { state, events, d1, d2, total, from, to: state.players[pid].pos, extra: d1===d2 };
  }

  if (type === 'buy') {
    const pid = state.turn; const p = state.players[pid]; const sq = BOARD[p.pos]; const deed = state.properties[p.pos];
    if (!isBuyable(sq) || !deed || deed.owner != null) return { state, events, error:'not_buyable' };
    const price = sq.price|0; if ((p.cash|0) < price) return { state, events, error:'cash' };
    p.cash -= price; deed.owner = pid; events.push({ type:'Built', payload:{ kind:'Buy', pid, idx:p.pos, price } }); return { state, events };
  }

  if (type === 'build') {
    const pid = state.turn; const idx = action.idx|0; const res = engineBuildHouse(state, pid, idx); if (res?.ok) events.push({ type:'Built', payload:{ pid, idx, delta:+1 } }); else return { state, events, error: res?.error||'error' }; return { state, events };
  }

  if (type === 'sell') { const pid=state.turn; const idx=action.idx|0; const res=engineSellHouse(state,pid,idx); if (res?.ok) events.push({ type:'Built', payload:{ pid, idx, delta:-1 } }); else return { state, events, error: res?.error||'error' }; return { state, events }; }

  if (type === 'mortgage') { const pid=state.turn; const idx=action.idx|0; const setTo=!!action.setTo; const res=engineMortgage(state,pid,idx,setTo); if (res?.ok) events.push({ type:'Mortgaged', payload:{ pid, idx, setTo } }); else return { state, events, error: res?.error||'error' }; return { state, events }; }

  if (type === 'jail.pay') { const pid=state.turn; const p=state.players[pid]; if (!p?.inJail) return { state, events, error:'invalid' }; if ((p.cash|0) < 50) return { state, events, error:'cash' }; p.cash -= 50; p.inJail=false; p.jailTurns=0; events.push({ type:'Paid', payload:{ pid, amount:50, reason:'jail' } }); return { state, events }; }

  if (type === 'useGoj') { const pid=state.turn; const p=state.players[pid]; const totalGOJ = ((p?.goj?.chance|0)+(p?.goj?.chest|0))|0; if (!p || totalGOJ<=0 || !p.inJail) return { state, events, error:'invalid' }; p.inJail=false; p.jailTurns=0; if ((p.goj.chance|0)>0){ p.goj.chance-=1; state.decks.held.chance-=1; } else { p.goj.chest-=1; state.decks.held.chest-=1; } events.push({ type:'UsedGOJ', payload:{ pid } }); return { state, events }; }

  if (type === 'auction.finish') {
    const auc = state.auction; if (!auc || !auc.active) return { state, events, error:'no_auction' };
    const deed = state.properties[auc.idx]; if (!deed) return { state, events, error:'idx' };
    if (auc.leader != null && auc.bid > 0){ const winner = state.players[auc.leader]; if (winner && !winner.bankrupt && winner.cash >= auc.bid){ winner.cash -= auc.bid; deed.owner = auc.leader; events.push({ type:'AuctionWon', payload:{ pid: auc.leader, idx: auc.idx, price: auc.bid } }); } }
    state.auction = null; state.phase = 'awaitRoll'; return { state, events };
  }

  // Unknown action: return state as-is
  return { state, events };
}

