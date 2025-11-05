import test from 'node:test';
import assert from 'node:assert/strict';

import { PROPS, isStreet, isRR, isUtil, rent as calcRent } from '../public/js/props.js';
import { STATE as STATE, clamp, clampPos, uniqPlayers, bankHousesAvailable, bankHotelsAvailable, nextEnabledActive, setOrderKeepEnabled, applyPropertyPatchByRules } from '../src/state.js';
import { initCards, applyCardEffect, handleJailRoll, startAuction, placeBid, endAuction, maybeChargeRent } from '../src/rules.js';

// fresh state per test
function resetState(){
  STATE.playerNames = ["P1","P2","P3","P4","P5","P6"];
  STATE.playerPos = [0,0,0,0,0,0];
  STATE.properties = Array.from({ length: PROPS.length }, () => ({ owner:0, houses:0, hotel:0 }));
  STATE.dice = { a:0, b:0, by:-1, at:0, seq:0 };
  STATE.turn = { order:[0,1,2,3,4,5], active:0, rev:1, doublesBy:-1, doublesCount:0 };
  STATE.money = [1500,1500,1500,1500,1500,1500];
  STATE.inJail = [false,false,false,false,false,false];
  STATE.jailTries = [0,0,0,0,0,0];
  STATE.enabled = [true,true,true,true,true,true];
  STATE.cards = initCards();
}

test('rent math streets and railroads', () => {
  resetState();
  // Give player 1 a monopoly on BROWN group (0,1 indices)
  STATE.properties[0].owner = 1;
  STATE.properties[1].owner = 1;
  // No houses: base rent doubled for monopoly
  assert.equal(calcRent(STATE, 0), PROPS[0].rents[0]*2);
  // Add house: use rents[houses]
  STATE.properties[0].houses = 2;
  assert.equal(calcRent(STATE, 0), PROPS[0].rents[2]);
  // Railroads based on count
  const rrIdx = PROPS.findIndex(p => p.type==='rr');
  STATE.properties[rrIdx].owner = 2;
  assert.equal(calcRent(STATE, rrIdx), 25);
  const rrIdx2 = PROPS.findIndex((p,i) => p.type==='rr' && i!==rrIdx);
  STATE.properties[rrIdx2].owner = 2;
  assert.equal(calcRent(STATE, rrIdx), 50);
});

test('rent via nearest railroad card doubles', () => {
  resetState();
  // Put player 0 at Reading RR board index 5
  const rrIdx = PROPS.findIndex(p => p.type==='rr' && p.board===5);
  STATE.playerPos[0] = PROPS[rrIdx].board;
  // Owner is player 2
  STATE.properties[rrIdx].owner = 3; // owner fields are 1-based
  let debited=0, credited=0;
  maybeChargeRent(0, { card:'nearestRailroad' }, { credit:(i,amt)=>{ if(i===2) credited+=amt; }, debit:(i,amt)=>{ if(i===0) debited+=amt; }, dbg:()=>{} });
  // Base RR rent for owning one is 25; doubled by card => 50
  assert.equal(debited, 50);
  assert.equal(credited, 50);
});

test('card effects: move, go to jail, nearest', () => {
  resetState();
  // Move to Illinois
  applyCardEffect('chance', { type:'move', target:24 }, 0, { credit:()=>{}, debit:()=>{} });
  assert.equal(STATE.playerPos[0], 24);
  // Go to Jail
  applyCardEffect('chance', { type:'goToJail' }, 0, { credit:()=>{}, debit:()=>{} });
  assert.equal(STATE.playerPos[0], 10);
  assert.equal(STATE.inJail[0], true);
  // Nearest Utility from position 7 -> 12
  STATE.inJail[0] = false; STATE.playerPos[0] = 7;
  applyCardEffect('chance', { type:'nearestUtility' }, 0, { credit:()=>{}, debit:()=>{} });
  assert.equal(STATE.playerPos[0], 12);
});

test('jail: doubles frees, third try pays 50', () => {
  resetState();
  STATE.inJail[0] = true; STATE.playerPos[0] = 10; STATE.jailTries[0] = 0;
  // Doubles: leaves jail and can move
  let moved = false;
  const info1 = handleJailRoll(0, 3, 3, { autoMove: true, credit:()=>{}, debit:()=>{}, afterMove:()=>{ moved=true; } });
  assert.equal(info1.wasInJail, true);
  assert.equal(moved, true);
  // Reset: three non-doubles -> pay 50 and leave
  resetState();
  STATE.inJail[0] = true; STATE.playerPos[0] = 10; STATE.jailTries[0] = 2; let debited=0;
  const info3 = handleJailRoll(0, 1, 2, { autoMove:false, credit:()=>{}, debit:(i,amt)=>{ if(i===0) debited+=amt; } });
  assert.equal(STATE.inJail[0], false);
  assert.equal(debited, 50);
});

test('even-building rule and bank limits', () => {
  resetState();
  // Give player 1 monopoly on LIGHT BLUE (6,8,9)
  // Compute indices for group
  const streets = PROPS.map((p,i)=>({p,i})).filter(({p})=>p.type==='street' && p.group===1).map(x=>x.i);
  for (const i of streets) STATE.properties[i].owner = 1;

  const messages = applyPropertyPatchByRules(STATE, streets[0], { houses: 2 }, { debitFn: ()=>{} });
  // First property can only go to 1 house until others catch up
  assert.ok(messages.join(' ').toLowerCase().includes('even-build') || STATE.properties[streets[0]].houses <= 1);

  // Exhaust houses
  STATE.properties.forEach((s, i) => { if (PROPS[i].type==='street') s.houses = 4; });
  const messages2 = applyPropertyPatchByRules(STATE, streets[0], { houses: 4 }, { debitFn: ()=>{} });
  assert.ok(bankHousesAvailable(STATE) <= 0);

  // Exhaust hotels
  // Prepare target group with 4 houses each (eligible for hotel)
  for (const i of streets) { STATE.properties[i].houses = 4; STATE.properties[i].owner = 1; }
  // Exhaust bank hotels elsewhere
  let hotelsPlaced = 0; for (let i=0;i<STATE.properties.length;i++){ if (!streets.includes(i) && PROPS[i].type==='street' && hotelsPlaced<12){ STATE.properties[i].hotel=1; STATE.properties[i].houses=0; hotelsPlaced++; } }
  const prev = { ...STATE.properties[streets[1]] };
  const msgHotel = applyPropertyPatchByRules(STATE, streets[1], { hotel: 1 }, { debitFn: ()=>{} });
  // Should not place hotel and should not remove the four houses
  assert.equal(STATE.properties[streets[1]].hotel|0, 0);
  assert.equal(STATE.properties[streets[1]].houses|0, prev.houses|0);
  // And the message should indicate hotel shortage, not missing houses
  assert.ok((msgHotel.join(' ').toLowerCase().includes('out of hotels')));
});

test('can place hotels across a group sequentially', () => {
  resetState();
  // LIGHT BLUE group (6,8,9)
  const streets = PROPS.map((p,i)=>({p,i})).filter(({p})=>p.type==='street' && p.group===1).map(x=>x.i);
  for (const i of streets) { STATE.properties[i].owner = 1; STATE.properties[i].houses = 4; }

  // Place first hotel
  let msgs1 = applyPropertyPatchByRules(STATE, streets[0], { hotel: 1 }, { debitFn: ()=>{} });
  assert.equal(STATE.properties[streets[0]].hotel|0, 1);
  assert.equal(STATE.properties[streets[0]].houses|0, 0);
  assert.ok(!msgs1.join(' ').toLowerCase().includes('needs 4 houses'));

  // Place second hotel (should still be allowed: hotel counts as satisfying requirement)
  let msgs2 = applyPropertyPatchByRules(STATE, streets[1], { hotel: 1 }, { debitFn: ()=>{} });
  assert.equal(STATE.properties[streets[1]].hotel|0, 1);
  assert.equal(STATE.properties[streets[1]].houses|0, 0);
  assert.ok(!msgs2.join(' ').toLowerCase().includes('needs 4 houses'));

  // Place third hotel
  let msgs3 = applyPropertyPatchByRules(STATE, streets[2], { hotel: 1 }, { debitFn: ()=>{} });
  assert.equal(STATE.properties[streets[2]].hotel|0, 1);
  assert.equal(STATE.properties[streets[2]].houses|0, 0);
  assert.ok(!msgs3.join(' ').toLowerCase().includes('needs 4 houses'));
});

test('auctions basic', () => {
  startAuction(5, [0,1,2]);
  assert.equal(placeBid(0, 100), true);
  assert.equal(placeBid(1, 90), false);
  assert.equal(placeBid(2, 200), true);
  const res = endAuction();
  assert.equal(res.propIndex, 5);
  assert.equal(res.winner, 2);
  assert.equal(res.price, 200);
});

test('turn rotation skips disabled', () => {
  resetState();
  STATE.turn.order = [0,1,2]; STATE.turn.active = 0;
  STATE.enabled = [true,false,true,true,true,true];
  nextEnabledActive(STATE, 1);
  assert.equal(STATE.turn.active, 2); // active is index into order array; 1 is disabled so next should be 2
});
