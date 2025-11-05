import { createApp, ref, computed, onMounted, watch, nextTick } from "vue";
import {
  PROPS, COLORS, boardIndexToPropIndex, NON_BUY_LABELS,
  isStreet, isRR, isUtil, rent, utilMult, groupMembers
} from "./props.js";
import { OLED } from "./oled.js";
import { makeWire } from "./wire.js";

const DICE = ["","⚀","⚁","⚂","⚃","⚄","⚅"];

createApp({
  setup(){
    const wire  = makeWire({ role: 'gm' });
    const state = wire.state;
    const canv  = new Map();
    const CARD_W = 64;
    const CARD_H = 32;
    const buffers = new Map();
    const dirtyCards = new Set();
    const prevPropertySig = PROPS.map(() => null);
    const prevOwnerTags = Array(6).fill(null);
    let flushPending = false;
    const stateTick = ref(0);

    const oledScale  = ref(2);
    const oledBold   = ref(false);
    const oledInvert = ref(false);
    const localNames = ref([...state.playerNames]);
    const localEnabled = ref([...(state.enabled || [true,true,true,true,true,true])]);
    const propertyDrafts = ref(state.properties.map((p) => ({
      owner: p.owner|0,
      houses: p.houses|0,
      hotel: p.hotel ? 1 : 0,
    })));
    function syncPropertyDrafts(){
      propertyDrafts.value = state.properties.map((p) => ({
        owner: p.owner|0,
        houses: p.houses|0,
        hotel: p.hotel ? 1 : 0,
      }));
    }

    // dice
    const autoMove = ref(true);
    const diceA = ref(state.dice?.a|0);
    const diceB = ref(state.dice?.b|0);
    const diceBy = ref((state.dice?.by ?? -1)|0);
    const diceSeq = ref(state.dice?.seq|0);
    const cardsHolding = computed(() => {
      stateTick.value;
      return state.cardsHolding || { chanceGOJ:-1, chestGOJ:-1 };
    });
    const lastCard = computed(() => {
      stateTick.value;
      return state.cardsLast || null;
    });
    const forceDoubles = computed(() => {
      stateTick.value;
      return !!state.debugForceDoubles;
    });

    // turn
    const order = computed(() => {
      stateTick.value;
      return (state.turn?.order?.length ? state.turn.order : [0]);
    });
    const activeIdx = computed(() => {
      stateTick.value;
      const len = order.value.length;
      return ((state.turn?.active|0) % len + len) % len;
    });
    const activePlayer = computed(() => {
      stateTick.value;
      return order.value[activeIdx.value] | 0;
    });
    const activeName = computed(() => {
      stateTick.value;
      return state.playerNames[activePlayer.value] || `P${activePlayer.value+1}`;
    });

    function doRoll(){
      // Server validates turn and advances to next automatically.
      wire.rollDice(activePlayer.value, { autoMove: autoMove.value, requireTurn:true });
    }
    function drawChance(){ wire.drawCard('chance', activePlayer.value); }
    function drawChest(){ wire.drawCard('chest',  activePlayer.value); }
    function toggleForceDoubles(ev){ wire.setForceDoubles(!!(ev?.target?.checked)); }

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
      } else if (isStreet(prop)) {
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
      if (el) {
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
      const i=pIndex(boardIndex); const t=PROPS[i].type;
      return t==='street' ? 'Street' : t==='rr' ? 'Railroad' : 'Utility';
    }
    const colors = COLORS;
    function groupOf(boardIndex){ const i=pIndex(boardIndex); return PROPS[i].group; }

    function idxToXY(k){
      if (k<=10) return {x:10-k, y:10};
      if (k<=19) return {x:0,    y:20-k};
      if (k<=30) return {x:k-20, y:0};
      return {x:10, y:k-30};
    }
    function gridPos(k){ const {x,y}=idxToXY(k); return {gridColumn:(x+1), gridRow:(y+1)}; }

    function ownerTag(o){
      if (o===0) return 'BANK';
      const n = (state.playerNames[o-1] || `P${o}`).toUpperCase().trim();
      return n.slice(0, 10);
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
        const owned = PROPS.reduce((n,pp,ii)=> n + ((pp.type==='rr' && state.properties[ii].owner===s.owner) ? 1 : 0), 0);
        const rrRent = [0,25,50,100,200][owned];
        L1=ownerTag(s.owner); L2='RENT'; L3='$'+rrRent; L4=owned+' RR OWNED';
      } else if (isUtil(p)){
        L1=ownerTag(s.owner); L2='RENT'; L3=utilMult(state,i)+' DICE'; L4='';
      } else {
        const r = rent(state, i);
        L1=ownerTag(s.owner); L2='RENT'; L3='$'+r; L4 = s.hotel>0 ? 'H 0 HT 1' : ('H '+s.houses+' HT 0');
      }
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
      if (!canvas) return;
      const payload = cardPayload(i);
      const entry = ensureBuffer(i);
      const signature = JSON.stringify(payload);
      if (entry.signature !== signature){
        entry.signature = signature;
        entry.ctx.clearRect(0, 0, CARD_W, CARD_H);
        OLED.card(entry.ctx, payload.lines, payload.options);
      }
      const ctx = canvas.getContext('2d', { alpha:false });
      ctx.drawImage(entry.buffer, 0, 0);
    }

    function trackDirtyFromState(){
      let changed = false;
      for (let i=0;i<PROPS.length;i++){
        const s = state.properties[i];
        const sig = `${s.owner|0}:${s.houses|0}:${s.hotel|0}`;
        if (sig !== prevPropertySig[i]) {
          prevPropertySig[i] = sig;
          markCascade(i);
          changed = true;
        }
      }
      for (let i=0;i<6;i++){
        const tag = ownerTag(i+1);
        if (tag !== prevOwnerTags[i]) {
          prevOwnerTags[i] = tag;
          changed = true;
          for (let j=0;j<PROPS.length;j++){
            if ((state.properties[j].owner|0) === (i+1)) markPropertyDirty(j);
          }
        }
      }
      if (changed || dirtyCards.size) scheduleDirtyFlush();
    }

    function onOwnerChange(i){
      const draft = propertyDrafts.value[i];
      draft.owner = Math.max(0, Math.min(6, draft.owner|0));
      wire.updateProperty(i, { owner: draft.owner });
    }
    function onHousesChange(i){
      const draft = propertyDrafts.value[i];
      draft.houses = Math.max(0, Math.min(4, draft.houses|0));
      draft.hotel = 0;
      wire.updateProperty(i, { houses: draft.houses, hotel: 0 });
    }
    function toggleHotel(i, ev){
      const draft = propertyDrafts.value[i];
      draft.hotel = ev?.target?.checked ? 1 : 0;
      if (draft.hotel) draft.houses = 0;
      wire.updateProperty(i, { hotel: draft.hotel, houses: draft.houses });
    }

    function infoLine(i){
      const p = PROPS[i], s = state.properties[i];
      if (s.owner===0) return `Price: $${p.price} · Mort $${p.mort}`;
      if (isUtil(p))   return `Rent: ${utilMult(state,i)} dice`;
      if (isRR(p))     return `Rent: $${rent(state,i)}`;
      const mono = (s.houses===0 && s.hotel===0 && groupMembers(p.group).every(j => state.properties[j].owner===s.owner)) ? ' (Monopoly×2)' : '';
      return `Rent: $${rent(state,i)}${mono}`;
    }

    function saveName(i){
      const v = (localNames.value[i] || "").trim().slice(0, 18);
      localNames.value[i] = v;
      wire.setPlayerName(i, v);
    }

    function setPos(i, val){
      const pos = Math.max(0, Math.min(39, parseInt(val,10) || 0));
      wire.setPlayerPos(i, pos);
    }
    function bump(i, d){ setPos(i, (state.playerPos[i] + d + 40) % 40); }

    function resetAll(){
      if (!confirm("Reset all properties, names, positions, dice, and roster?")) return;
      wire.resetAll();
    }

    // roster helpers
    function toggleEnabled(i){
      const en = !!localEnabled.value[i];
      wire.setPlayerEnabled(i, en);
    }
    function disable56(){
      localEnabled.value[4] = false; wire.setPlayerEnabled(4, false);
      localEnabled.value[5] = false; wire.setPlayerEnabled(5, false);
    }
    function disable26() {
      localEnabled.value[2] = false;
      wire.setPlayerEnabled(2, false);
      localEnabled.value[3] = false;
      wire.setPlayerEnabled(3, false);
      localEnabled.value[4] = false;
      wire.setPlayerEnabled(4, false);
      localEnabled.value[5] = false;
      wire.setPlayerEnabled(5, false);
    }

    function enableAll(){
      for (let i=0;i<6;i++){ localEnabled.value[i]=true; wire.setPlayerEnabled(i,true); }
    }
    const enabledCount = computed(() => {
      stateTick.value;
      return (state.enabled||[]).filter(Boolean).length;
    });

    // turn controls
    function setActive(i){ wire.setActive(i|0); }
    function nextTurn(d){ wire.nextTurn(d|0); }

    wire.on(() => nextTick().then(() => {
      syncPropertyDrafts();
      localNames.value = [...state.playerNames];
      localEnabled.value = [...(state.enabled||[true,true,true,true,true,true])];

      if ((state.dice?.seq|0)!==(diceSeq.value|0)){
        diceSeq.value = state.dice.seq|0;
        diceA.value = state.dice.a|0;
        diceB.value = state.dice.b|0;
        diceBy.value = (state.dice.by ?? -1)|0;
      }
      trackDirtyFromState();
      stateTick.value++;
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
    });

    return {
      state, propertyDrafts, boardIndexToPropIndex, nonBuy: NON_BUY_LABELS,
      setCanvas, pIndex, propName, kindLabel, colors, groupOf,
      gridPos, infoLine, onOwnerChange, onHousesChange, toggleHotel,
      oledScale, oledBold, oledInvert, localNames, saveName, resetAll,
      stateTick,
      playersAt, initials, setPos, bump, isStreet: (b)=>isStreet(PROPS[pIndex(b)]),
      // dice + turn
      autoMove, forceDoubles, toggleForceDoubles, doRoll, drawChance, drawChest, DICE, diceA, diceB, diceBy, order, activeIdx, activePlayer, activeName, lastCard,
      // roster
      localEnabled, toggleEnabled, disable56, disable26, enableAll, enabledCount,
      // turn controls
      setActive, nextTurn
    };
    }
  }).mount("#app");
