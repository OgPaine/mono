import { createApp, ref, computed, onMounted, onUnmounted, watch, nextTick } from "vue";
import {
  PROPS, COLORS, boardIndexToPropIndex, NON_BUY_LABELS,
  isRR, isUtil, rent, utilMult, groupMembers
} from "./props.js";
import { OLED } from "./oled.js";
import { makeWire } from "./wire.js";

const DICE = ["","⚀","⚁","⚂","⚃","⚄","⚅"];

createApp({
  setup(){
    // Resolve player index from URL
    function parseIdxFromURL(){
      const sp = new URLSearchParams(location.search);
      let n = 0;
      if (sp.has("p")) n = parseInt(sp.get("p")||"0",10);
      else if (sp.has("player")) n = parseInt(sp.get("player")||"0",10);
      else {
        for (const k of sp.keys()){
          let m = /^p([1-6])$/i.exec(k); if (m){ n = parseInt(m[1],10); break; }
          m = /^([1-6])$/.exec(k);       if (m){ n = parseInt(m[1],10); break; }
        }
      }
      return (n>=1 && n<=6) ? n : 0;
    }

    const initialIdx = parseIdxFromURL();
    const wire = makeWire({
      role: initialIdx>0 ? "player" : "viewer",
      idx: (initialIdx>0 ? (initialIdx-1) : -1)
    });

    const state = wire.state;
    const canv = new Map();
    const CARD_W = 64;
    const CARD_H = 32;
    const buffers = new Map();
    const dirtyCards = new Set();
    const prevPropertySig = PROPS.map(() => null);
    const prevOwnerTags = Array(6).fill(null);
    let flushPending = false;
    const renderTick = ref(0);

    const oledScale  = ref(2);
    const oledBold   = ref(false);
    const oledInvert = ref(false);

    const my = ref(initialIdx);
    const stopRole = wire.onRole(({ role, idx }) => {
      if (role === "player") {
        my.value = (idx|0) + 1;
      } else {
        my.value = 0;
      }
    });
    const myName = computed(() => {
      renderTick.value;
      return my.value>0 ? (state.playerNames[my.value-1] || `P${my.value}`) : "";
    });
    const myMoney = computed(() => {
      renderTick.value;
      return my.value>0 ? ((state.money?.[my.value-1] | 0)) : 0;
    });

    function shouldPromptForName(){
      const idx = my.value;
      if (!(idx>=1 && idx<=6)) return false;
      const stored = parseInt(localStorage.getItem("mono:name:epoch")||"0",10);
      const curr = (state.nameEpoch | 0);
      const empty = !String(state.playerNames[idx-1]||"").trim();
      return curr > (stored|0) || empty;
    }
    function promptMyName(){
      const idx = my.value; if (!(idx>=1 && idx<=6)) return;
      const suggested = state.playerNames[idx-1] || `Player ${idx}`;
      const name = (prompt(`Game started Enter your display name for P${idx}:`, suggested) || "").trim();
      const capped = (name || suggested).slice(0, 18);
      wire.setPlayerName(idx-1, capped);
      localStorage.setItem("mono:name:epoch", String(state.nameEpoch|0));
    }

    const myPos = computed(() => {
      renderTick.value;
      return my.value>0 ? (state.playerPos[my.value-1] | 0) : 0;
    });
    const posDraft = ref(0);
    watch(myPos, v => { posDraft.value = v; }, { immediate: true });

    function setMyPos(pos){
      if (!(my.value>=1 && my.value<=6)) return;
      wire.setPlayerPos(my.value-1, pos);
    }
    function bumpMyPos(delta){
      if (!(my.value>=1 && my.value<=6)) return;
      const cur = state.playerPos[my.value-1] | 0;
      wire.setPlayerPos(my.value-1, cur + delta);
    }
    function applyPosDraft(){
      const n = Math.max(0, Math.min(39, parseInt(posDraft.value,10) || 0));
      setMyPos(n);
    }

    // Shared dice
    const diceSeq = ref(state.dice.seq|0);
    const diceA = ref(state.dice.a|0);
    const diceB = ref(state.dice.b|0);
    const diceBy = ref((state.dice.by ?? -1)|0);
    const lastRoller = computed(() => {
      renderTick.value;
      return diceBy.value>=0 ? (state.playerNames[diceBy.value] || `P${diceBy.value+1}`) : "??";
    });
    const lastCard = computed(() => {
      renderTick.value;
      return state.cardsLast || null;
    });

    // Turn gating
    const order = computed(() => {
      renderTick.value;
      return (state.turn.order && state.turn.order.length ? state.turn.order : [0]);
    });
    const activeIdx = computed(() => {
      renderTick.value;
      const len = order.value.length;
      return len ? ((state.turn.active|0) % len + len) % len : 0;
    });
    const activePlayerIdx = computed(() => {
      renderTick.value;
      return order.value[activeIdx.value]|0;
    });
    const isMeEnabled = computed(() => {
      renderTick.value;
      return my.value>=1 && my.value<=6 && (state.enabled?.[my.value-1] ?? true);
    });
    const amInJail = computed(() => {
      renderTick.value;
      return my.value>=1 && my.value<=6 ? !!(state.inJail?.[my.value-1]) : false;
    });
    const hasGOJ = computed(() => {
      renderTick.value;
      if (!(my.value>=1 && my.value<=6)) return false;
      const holder = state.cardsHolding || {};
      const idx0 = my.value-1;
      return (holder.chanceGOJ|0) === idx0 || (holder.chestGOJ|0) === idx0;
    });
    const isMyTurn = computed(() => {
      renderTick.value;
      return isMeEnabled.value && activePlayerIdx.value === (my.value-1);
    });

    function rollMine(){
      if (!(my.value>=1 && my.value<=6)) return;
      if (!isMyTurn.value) return; // UI hard gate
      wire.rollDice(my.value-1, { autoMove:true, requireTurn:true });
    }
    function useGOJ(deck){
      if (!(my.value>=1 && my.value<=6)) return;
      wire.useGetOutOfJail(deck || null, my.value-1);
    }

    // board helpers
    function markPropertyDirty(i){
      if (i>=0 && i<PROPS.length) dirtyCards.add(i);
    }
    function markCascade(i){
      const prop = PROPS[i];
      if (!prop) return;
      markPropertyDirty(i);
      if (isRR(prop)) {
        PROPS.forEach((p, idx) => { if (isRR(p)) markPropertyDirty(idx); });
      } else if (isUtil(prop)) {
        PROPS.forEach((p, idx) => { if (isUtil(p)) markPropertyDirty(idx); });
      } else if (prop.type === 'street') {
        for (const idx of groupMembers(prop.group)) markPropertyDirty(idx);
      }
    }
    function markAllDirty(){
      for (let i=0;i<PROPS.length;i++) dirtyCards.add(i);
      scheduleDirtyFlush();
    }
    function scheduleDirtyFlush(){
      if (dirtyCards.size === 0) return;
      if (flushPending) return;
      flushPending = true;
      const run = () => {
        flushPending = false;
        const pending = Array.from(dirtyCards);
        dirtyCards.clear();
        for (const idx of pending) draw(idx);
      };
      if (typeof requestAnimationFrame === "function") {
        requestAnimationFrame(run);
      } else {
        setTimeout(run, 0);
      }
    }

    function setCanvas(i, el){
      if(el){
        canv.set(i, el);
        markPropertyDirty(i);
        scheduleDirtyFlush();
      } else {
        canv.delete(i);
      }
    }
    function pIndex(boardIndex){ return boardIndexToPropIndex[boardIndex]; }
    function propName(boardIndex){ const i=pIndex(boardIndex); return PROPS[i].name; }
    function kindLabel(boardIndex){
      const i=pIndex(boardIndex);
      const t=PROPS[i].type;
      return t==='street'?'Street': t==='rr'?'Railroad':'Utility';
    }
    const colors = COLORS;
    function groupOf(boardIndex){ const i=pIndex(boardIndex); return PROPS[i].group; }
    function gridPos(k){
      let x,y;
      if(k<=10){ x=10-k;y=10; }
      else if(k<=19){ x=0;y=20-k; }
      else if(k<=30){ x=k-20;y=0; }
      else { x=10;y=k-30; }
      return {gridColumn:(x+1),gridRow:(y+1)};
    }

    function ownerTag(o){
      if(o===0) return 'BANK';
      const n = (state.playerNames[o-1] || `P${o}`).toUpperCase().trim();
      return n.slice(0,10);
    }

    function playersAt(boardIndex){
      const acc = [];
      for (let i=0;i<6;i++){
        if (!state.enabled?.[i]) continue;
        if ((state.playerPos[i]|0) === (boardIndex|0)) acc.push(i+1);
      }
      return acc;
    }
    function initials(pi){
      const n = (state.playerNames[(pi|0)-1]||`P${pi}`).trim();
      const m = n.match(/\b([A-Za-z0-9])/g);
      return (m && m.slice(0,2).join("").toUpperCase()) || `P${pi}`;
    }

    function cardPayload(i){
      const p = PROPS[i], s = state.properties[i];
      let L1='',L2='',L3='',L4='';
      if (s.owner===0){
        L1='PRICE'; L2=''; L3='$'+p.price; L4='MORT $'+p.mort;
      } else if (isRR(p)){
        const owned = PROPS.reduce((n,pp,ii)=>
          n + ((pp.type==='rr' && state.properties[ii].owner===s.owner) ? 1 : 0), 0);
        const rrRent = [0,25,50,100,200][owned];
        L1=ownerTag(s.owner); L2='RENT'; L3='$'+rrRent; L4=owned+' RR OWNED';
      } else if (isUtil(p)){
        L1=ownerTag(s.owner); L2='RENT'; L3=utilMult(state,i)+' DICE'; L4='';
      } else {
        const r=rent(state,i);
        L1=ownerTag(s.owner); L2='RENT'; L3='$'+r; L4 = s.hotel>0 ? 'H 0 HT 1' : ('H '+s.houses+' HT 0');
      }
      onUnmounted(() => stopRole());

    return {
        lines: { L1, L2, L3, L4 },
        options: { invert: oledInvert.value, bold: oledBold.value }
      };
    }

    function ensureBuffer(i){
      let entry = buffers.get(i);
      if (!entry) {
        const buffer = document.createElement('canvas');
        buffer.width = CARD_W;
        buffer.height = CARD_H;
        const ctx = buffer.getContext('2d', { alpha:false });
        entry = { buffer, ctx, signature: null };
        buffers.set(i, entry);
      }
      return entry;
    }

    function draw(i){
      const canvas = canv.get(i);
      if(!canvas) return;
      const payload = cardPayload(i);
      const entry = ensureBuffer(i);
      const signature = JSON.stringify(payload);
      if (entry.signature !== signature){
        entry.signature = signature;
        entry.ctx.clearRect(0, 0, CARD_W, CARD_H);
        OLED.card(entry.ctx, payload.lines, payload.options);
      }
      const ctx = canvas.getContext('2d',{alpha:false});
      ctx.drawImage(entry.buffer, 0, 0);
    }

    function trackDirtyFromState(){
      let changed = false;
      for (let i=0;i<PROPS.length;i++){
        const s = state.properties[i];
        const sig = `${s.owner|0}:${s.houses|0}:${s.hotel|0}`;
        if (sig !== prevPropertySig[i]){
          prevPropertySig[i] = sig;
          markCascade(i);
          changed = true;
        }
      }
      for (let i=0;i<6;i++){
        const tag = ownerTag(i+1);
        if (tag !== prevOwnerTags[i]){
          prevOwnerTags[i] = tag;
          changed = true;
          for (let j=0;j<PROPS.length;j++){
            if ((state.properties[j].owner|0) === (i+1)) markPropertyDirty(j);
          }
        }
      }
      if (changed || dirtyCards.size) scheduleDirtyFlush();
    }

    function infoLine(i){
      const p = PROPS[i], s = state.properties[i];
      if (s.owner===0) return `Price: $${p.price} Mort $${p.mort}`;
      if (isUtil(p))   return `Rent: ${utilMult(state,i)} dice`;
      if (isRR(p))     return `Rent: $${rent(state,i)}`;
      const mono = (s.houses===0 && s.hotel===0 &&
        groupMembers(p.group).every(j => state.properties[j].owner===s.owner)
      ) ? ' (MonopolyÃ—2)' : '';
      return `Rent: $${rent(state,i)}${mono}`;
    }

    wire.on(() => nextTick().then(() => {
      trackDirtyFromState();
      if (shouldPromptForName()) setTimeout(promptMyName, 0);

      if ((state.dice.seq|0) !== (diceSeq.value|0)) {
        diceSeq.value = state.dice.seq|0;
        diceA.value = state.dice.a|0;
        diceB.value = state.dice.b|0;
        diceBy.value = (state.dice.by ?? -1)|0;
      }
      renderTick.value++;
    }));

    watch([oledBold, oledInvert], () => markAllDirty());
    onMounted(() => {
      for (let i=0;i<PROPS.length;i++){
        const s = state.properties[i];
        prevPropertySig[i] = `${s.owner|0}:${s.houses|0}:${s.hotel|0}`;
      }
      for (let i=0;i<6;i++){
        prevOwnerTags[i] = ownerTag(i+1);
      }
      markAllDirty();
      if (shouldPromptForName()) setTimeout(promptMyName, 0);
    });

    return {
      state, boardIndexToPropIndex, nonBuy: NON_BUY_LABELS,
      setCanvas, pIndex, propName, kindLabel, colors, groupOf, gridPos,
      oledScale, oledBold, oledInvert,
      playersAt, initials, infoLine,
      renderTick,
      myName, myMoney, myPos, posDraft, applyPosDraft, bumpMyPos, setMyPos,
      diceSeq, diceA, diceB, diceBy, lastRoller, lastCard, DICE, rollMine, useGOJ,
      isMyTurn, isMeEnabled, amInJail, hasGOJ
    };
  }
}).mount("#app");


