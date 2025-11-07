import assert from 'node:assert/strict';
import { BOARD } from '../../shared/props-data.js';
import { buildHouse, sellHouse, canEvenShift, declareBankrupt } from '../engine.js';

function makeState() {
  return {
    bank: { houses: 32, hotels: 12 },
    players: [
      { id: 0, cash: 10000, pos: 0, bankrupt: false, inJail: false, jailTurns: 0, doubles: 0, goj: { chance:0, chest:0 } },
      { id: 1, cash: 10000, pos: 0, bankrupt: false, inJail: false, jailTurns: 0, doubles: 0, goj: { chance:0, chest:0 } }
    ],
    properties: BOARD.map((sq, i) => (sq.kind === 'street' || sq.kind === 'rr' || sq.kind === 'util')
      ? { idx: i, owner: null, houses: 0, mortgaged: false }
      : { idx: i }
    ),
    decks: { chance: [], chest: [], discards: { chance: [], chest: [] }, held: { chance:0, chest:0 } }
  };
}

function idxOf(name) {
  const i = BOARD.findIndex(s => s.name === name);
  if (i < 0) throw new Error('square not found: ' + name);
  return i;
}

export function testEvenBuilding() {
  const st = makeState();
  // Light blue group
  const a = idxOf('Oriental Avenue');
  const b = idxOf('Vermont Avenue');
  const c = idxOf('Connecticut Avenue');
  st.properties[a].owner = 0;
  st.properties[b].owner = 0;
  st.properties[c].owner = 0;

  // Build first house on A
  const r1 = buildHouse(st, 0, a);
  console.log('first build result', JSON.stringify(r1));
  assert.equal(r1.ok, true);
  // Building second on A should fail until others catch up
  console.log('canEvenShift second on A?', canEvenShift(st, 0, a, +1));
  const r2 = buildHouse(st, 0, a);
  console.log('second build result', JSON.stringify(r2));
  assert.equal(r2.error, 'even_build');
  // Bring B and C to 1
  console.log('canEvenShift B to 1?', canEvenShift(st, 0, b, +1));
  const rB1 = buildHouse(st, 0, b);
  console.log('build B->1 result', JSON.stringify(rB1));
  assert.equal(rB1.ok, true);
  console.log('canEvenShift C to 1?', canEvenShift(st, 0, c, +1));
  const rC1 = buildHouse(st, 0, c);
  console.log('build C->1 result', JSON.stringify(rC1));
  assert.equal(rC1.ok, true);
  // Now second on A ok
  console.log('canEvenShift A to 2?', canEvenShift(st, 0, a, +1));
  const rA2 = buildHouse(st, 0, a);
  console.log('build A->2 result', JSON.stringify(rA2));
  assert.equal(rA2.ok, true);

  // Bring B and C up to 2 as well
  assert.equal(buildHouse(st, 0, b).ok, true);
  assert.equal(buildHouse(st, 0, c).ok, true);

  // Fast-forward to 4 on all by even rounds
  for (let round = 3; round <= 4; round++) {
    assert.equal(buildHouse(st, 0, a).ok, true);
    assert.equal(buildHouse(st, 0, b).ok, true);
    assert.equal(buildHouse(st, 0, c).ok, true);
    assert.equal(st.properties[a].houses, round);
    assert.equal(st.properties[b].houses, round);
    assert.equal(st.properties[c].houses, round);
  }

  // Cannot hotel on A if others <4 (already equal) — build hotel should succeed now
  assert.equal(buildHouse(st, 0, a).ok, true);
  assert.equal(st.properties[a].houses, 5);
  assert.equal(st.bank.hotels, 11);
  assert.equal(st.bank.houses, 32 - (4*3) + 4); // 12 houses used for 4/4/4, +4 returned on hotel

  // Selling hotel returns hotel + consumes 4 houses from bank
  const sellRes = sellHouse(st, 0, a);
  assert.equal(sellRes.ok, true);
  assert.equal(st.properties[a].houses, 4);
}

export function testBankExhaustion() {
  const st = makeState();
  const a = idxOf('Mediterranean Avenue');
  const b = idxOf('Baltic Avenue');
  st.properties[a].owner = 0;
  st.properties[b].owner = 0;

  st.bank.houses = 0;
  const rNoH = buildHouse(st, 0, a);
  console.log('no houses build result', JSON.stringify(rNoH));
  assert.equal(rNoH.error, 'no_houses');
  st.bank.houses = 32;

  // Move both to 4 in even rounds
  for (let round = 1; round <= 4; round++) {
    assert.equal(buildHouse(st, 0, a).ok, true);
    assert.equal(buildHouse(st, 0, b).ok, true);
  }
  st.bank.hotels = 0;
  assert.equal(buildHouse(st, 0, a).error, 'no_hotels');
}

export function run() {
  testEvenBuilding();
  testBankExhaustion();
  console.log('engine tests passed');
}

if (process.argv[1] && process.argv[1].includes('engine.test.js')) run();
