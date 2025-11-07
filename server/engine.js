// Pure game-logic utilities that operate on a provided state object
// The server imports these and wires to network/events. Tests import them directly.

import {
  BOARD,
  CHANCE_CARDS,
  CHEST_CARDS,
  RR_RENTS,
  UTIL_MULT,
  HOUSE_COST_BY_GROUP
} from '../shared/props-data.js';

const isBuyable = s => s && (s.kind === 'street' || s.kind === 'rr' || s.kind === 'util');

export const groupMap = BOARD.reduce((m, t, i) => {
  if (t.kind === 'street') (m[t.group] ||= []).push(i);
  return m;
}, {});

export const fullSetOwned = (state, pid, group) =>
  groupMap[group].every(i => state.properties[i]?.owner === pid);

export const anyMortgagedInGroup = (state, group) =>
  groupMap[group].some(i => state.properties[i]?.mortgaged);

export const streetRent = (state, idx, diceTotal = 0) => {
  const sq = BOARD[idx];
  const deed = state.properties[idx];
  if (!sq || !deed) return 0;

  if (sq.kind === 'street') {
    const h = deed.houses | 0;
    const base = sq.rent?.[0] || 0;
    if (h === 0) {
      if (deed.owner != null && fullSetOwned(state, deed.owner, sq.group) && !anyMortgagedInGroup(state, sq.group)) {
        return base * 2;
      }
      return base;
    }
    return sq.rent?.[Math.min(h, 5)] || 0;
  }

  if (sq.kind === 'rr') {
    const owner = deed.owner;
    if (owner == null) return 0;
    let n = 0;
    state.properties.forEach((d, i) => {
      if (BOARD[i]?.kind === 'rr' && d.owner === owner) n++;
    });
    return RR_RENTS[Math.min(Math.max(n - 1, 0), RR_RENTS.length - 1)];
  }

  if (sq.kind === 'util') {
    const owner = deed.owner;
    if (owner == null) return 0;
    let n = 0;
    state.properties.forEach((d, i) => {
      if (BOARD[i]?.kind === 'util' && d.owner === owner) n++;
    });
    const mult = n >= 2 ? UTIL_MULT.two : UTIL_MULT.one;
    return mult * (diceTotal || 0);
  }

  return 0;
};

export const clampPos = v => ((v % 40) + 40) % 40;

export const moveTo = (state, pid, to, payGo = true) => {
  const p = state.players[pid];
  if (!p) return;
  const from = p.pos | 0;
  const normTo = clampPos(to);
  const delta = ((normTo - from) % 40 + 40) % 40;
  if (payGo && delta > 0 && from + delta >= 40) {
    const award = BOARD[0].award || 200;
    p.cash += award;
  }
  p.pos = normTo;
};

export const canEvenShift = (state, pid, idx, delta) => {
  const sq = BOARD[idx];
  const deed = state.properties[idx];
  if (!sq || sq.kind !== 'street' || !deed) return false;
  if (deed.owner !== pid || deed.mortgaged) return false;
  if (!fullSetOwned(state, pid, sq.group) || anyMortgagedInGroup(state, sq.group)) return false;

  const set = groupMap[sq.group];
  const counts = set.map(i => state.properties[i].houses | 0);
  const pos = set.indexOf(idx);
  if (pos < 0) return false;

  const target = counts.map((h, i) => (i === pos ? h + delta : h));
  if (target[pos] < 0 || target[pos] > 5) return false;

  // Tightened rule: treat hotel (5) as strictly above 4
  // A hotel may only exist when all others are at 4
  if (target[pos] === 5 && Math.min(...target.filter((_, i) => i !== pos)) < 4) return false;

  const min = Math.min(...target);
  const max = Math.max(...target);
  return max - min <= 1;
};

export const buildHouse = (state, pid, idx) => {
  const sq = BOARD[idx];
  const deed = state.properties[idx];
  if (!sq || !deed) return { error: 'invalid' };
  const p = state.players[pid];
  if (!p || p.bankrupt) return { error: 'player' };

  if (!canEvenShift(state, pid, idx, +1)) return { error: 'even_build' };
  const cost = sq.houseCost || HOUSE_COST_BY_GROUP[sq.group] || 0;
  if (p.cash < cost) return { error: 'cash' };

  if (deed.houses < 4) {
    if (state.bank.houses <= 0) return { error: 'no_houses' };
    state.bank.houses -= 1;
    deed.houses += 1;
  } else if (deed.houses === 4) {
    if (state.bank.hotels <= 0) return { error: 'no_hotels' };
    state.bank.hotels -= 1;
    state.bank.houses += 4; // Convert 4 houses back into bank
    deed.houses = 5;
  } else {
    return { error: 'max' };
  }

  p.cash -= cost;
  return { ok: true };
};

export const sellHouse = (state, pid, idx) => {
  const sq = BOARD[idx];
  const deed = state.properties[idx];
  if (!sq || !deed) return { error: 'invalid' };
  const p = state.players[pid];
  if (!p || p.bankrupt) return { error: 'player' };

  if (!canEvenShift(state, pid, idx, -1)) return { error: 'even_build' };
  const cost = sq.houseCost || HOUSE_COST_BY_GROUP[sq.group] || 0;

  if (deed.houses === 5) {
    if (state.bank.houses < 4) return { error: 'no_houses_bank' };
    state.bank.hotels += 1;
    state.bank.houses -= 4;
    deed.houses = 4;
    p.cash += (cost / 2) | 0;
  } else if (deed.houses > 0) {
    state.bank.houses += 1;
    deed.houses -= 1;
    p.cash += (cost / 2) | 0;
  } else {
    return { error: 'none' };
  }

  return { ok: true };
};

export const mortgage = (state, pid, idx, setTo) => {
  const p = state.players[pid];
  const deed = state.properties[idx];
  const sq = BOARD[idx];
  if (!p || !deed || !sq || !isBuyable(sq)) return { error: 'invalid' };
  if (deed.owner !== pid) return { error: 'owner' };
  if (deed.houses > 0) return { error: 'buildings' };

  const value = ((sq.price | 0) / 2) | 0;

  if (setTo) {
    if (deed.mortgaged) return { error: 'already' };
    deed.mortgaged = true;
    p.cash += value;
  } else {
    if (!deed.mortgaged) return { error: 'not_mortgaged' };
    const pay = Math.ceil(value * 1.1);
    if (p.cash < pay) return { error: 'cash' };
    p.cash -= pay;
    deed.mortgaged = false;
  }

  return { ok: true };
};

export const applyCard = (state, pid, deckName, cardIndex) => {
  const card = (deckName === 'chance' ? CHANCE_CARDS : CHEST_CARDS)[cardIndex];
  if (!card) return;
  const p = state.players[pid];
  if (!p) return;

  if (card.kind === 'money') {
    if (card.amount >= 0) p.cash += card.amount;
    else p.cash -= -card.amount;
  } else if (card.kind === 'move') {
    moveTo(state, pid, card.to | 0);
  } else if (card.kind === 'moveRel') {
    moveTo(state, pid, p.pos + (card.delta | 0));
  } else if (card.kind === 'toNext') {
    for (let i = 1; i <= 40; i++) {
      const idx = (p.pos + i) % 40;
      if (BOARD[idx]?.kind === card.what) {
        moveTo(state, pid, idx);
        break;
      }
    }
  } else if (card.kind === 'jail') {
    p.inJail = true;
    p.pos = 10;
    p.doubles = 0;
    p.jailTurns = 0;
  } else if (card.kind === 'keep' && card.effect === 'jailFree') {
    p.goj ||= { chance: 0, chest: 0 };
    p.goj[deckName] += 1;
    state.decks.held[deckName] += 1;
    return;
  } else if (card.kind === 'eachPlayer') {
    state.players.forEach(o => {
      if (!o || o.bankrupt || o.id === pid) return;
      if (card.amount > 0) {
        o.cash -= card.amount;
        p.cash += card.amount;
      } else {
        p.cash -= -card.amount;
        o.cash += -card.amount;
      }
    });
  } else if (card.kind === 'repair') {
    let due = 0;
    state.properties.forEach((deed, i) => {
      const sq = BOARD[i];
      if (!sq || sq.kind !== 'street') return;
      if (deed.owner !== pid) return;
      const h = deed.houses | 0;
      const hotels = h === 5 ? 1 : 0;
      const houses = h === 5 ? 0 : h;
      due += (houses * (card.perHouse | 0)) + (hotels * (card.perHotel | 0));
    });
    if (due > 0) p.cash -= due;
  }

  state.decks.discards[deckName].push(cardIndex);
};

export const declareBankrupt = (state, pid, creditorPid = null) => {
  const p = state.players[pid];
  if (!p || p.bankrupt) return { error: 'player' };

  state.properties.forEach((deed) => {
    if (!deed || deed.owner !== pid) return;
    const sq = BOARD[deed.idx];
    if (!sq || sq.kind !== 'street') return;
    const h = deed.houses | 0;
    if (h === 5) {
      state.bank.hotels += 1;
      state.bank.houses += 4;
    } else if (h > 0) {
      state.bank.houses += h;
    }
    deed.houses = 0;
  });

  state.properties.forEach((deed) => {
    if (!deed || deed.owner !== pid) return;
    if (creditorPid != null) {
      deed.owner = creditorPid;
    } else {
      deed.owner = null;
      deed.mortgaged = false;
    }
  });

  p.cash = 0;
  p.bankrupt = true;
  p.inJail = false;
  p.jailTurns = 0;
  p.doubles = 0;
  p.goj = { chance: 0, chest: 0 };
  return { ok: true };
};

export const estimateLiquidation = (state, pid) => {
  let total = 0;
  state.properties.forEach((deed, i) => {
    if (!deed || deed.owner !== pid) return;
    const sq = BOARD[i];
    if (!sq) return;
    if (sq.kind === 'street') {
      const h = deed.houses | 0;
      const cost = sq.houseCost || HOUSE_COST_BY_GROUP[sq.group] || 0;
      if (h === 5) total += (cost / 2) | 0;
      total += ((h - (h === 5 ? 4 : 0)) * ((cost / 2) | 0));
    }
    if (!deed.mortgaged && isBuyable(sq) && deed.houses === 0) {
      total += ((sq.price | 0) / 2) | 0;
    }
  });
  return total;
};

