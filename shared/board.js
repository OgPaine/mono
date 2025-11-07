import { BOARD } from './props-data.js';

const STYLE_ID = 'board-js-runtime-style';
function injectStyleOnce() {
  if (document.getElementById(STYLE_ID)) return;
  const css = `
  .tile-tokens{ position:absolute; inset:auto 4px 4px 4px; display:flex; gap:4px; flex-wrap:wrap; justify-content:center; pointer-events:none }
  .tile-token{ width:16px; height:16px; border-radius:50%; border:2px solid rgba(0,0,0,.4); box-shadow:0 0 0 1px rgba(255,255,255,.15) inset; pointer-events:auto }
  .tile-token.turn{ outline:2px solid #3b82f6; outline-offset:1px }
  .owner-ring{ position:absolute; inset:0px; border:3px solid transparent; border-radius:2px; pointer-events:none; }
  .improvements{ position:absolute; right:4px; top:4px; display:flex; gap:2px; }
  .improvements .house{ width:8px; height:8px; border:1px solid rgba(0,0,0,.4); background:#10b981; border-radius:2px }
  .improvements .hotel{ width:12px; height:10px; border:1px solid rgba(0,0,0,.4); background:#ef4444; border-radius:2px }
  .motion-layer{ position:absolute; inset:0; pointer-events:none; overflow:visible; }
  .token-ghost{ position:absolute; width:16px; height:16px; border-radius:50%; border:2px solid rgba(0,0,0,.4); box-shadow:0 0 0 1px rgba(255,255,255,.15) inset; will-change: transform; transition: transform 160ms ease-out; }
  .gm-menu{ position:fixed; z-index:1000; background:#0e1527; color:#e5e7eb; border:1px solid #1f2937; border-radius:8px; min-width:220px; box-shadow:0 10px 30px rgba(0,0,0,.35) }
  .gm-menu ul{ list-style:none; margin:6px; padding:0 }
  .gm-menu li{ display:flex; justify-content:space-between; gap:8px; padding:6px 8px; border-radius:6px; cursor:pointer }
  .gm-menu li:hover{ background:#111a31 }
  .gm-menu li[aria-disabled="true"]{ opacity:.5; pointer-events:none }
  .gm-menu .sub{ font-size:12px; color:#9ca3af }
  .container{ position:relative }
  [data-idx]{ position:relative }`;
  const el = document.createElement('style'); el.id = STYLE_ID; el.textContent = css; document.head.appendChild(el);
}

function ensureTokenLayer(el){ let t=el.querySelector('.tile-tokens'); if(!t){ t=document.createElement('div'); t.className='tile-tokens'; el.appendChild(t);} return t; }
function setOwnerRing(el,color){ const r=el.querySelector('.owner-ring')||el.appendChild(Object.assign(document.createElement('div'),{className:'owner-ring'})); r.style.display = color?'block':'none'; if(color) r.style.borderColor=color; }
function setImprovements(el,h){ const b=el.querySelector('.improvements')||el.appendChild(Object.assign(document.createElement('div'),{className:'improvements'})); b.textContent=''; if(h<=0)return; if(h<5){ for(let i=0;i<h;i++){ const d=document.createElement('div'); d.className='house'; b.appendChild(d);} } else { const d=document.createElement('div'); d.className='hotel'; b.appendChild(d);} }

function makeSpace(idx, meta){
  const el = document.createElement('div'); el.className='space'; el.dataset.idx=String(idx);
  const price = meta.price ? `<h3>$${meta.price}</h3>` : '';
  const name = meta.name ? meta.name.replace(/\s+/g,' ') : meta.kind;
  el.innerHTML = `${meta.kind==='street'?`<div class="property ${meta.color||''}"></div>`:''}<h3>${name.replaceAll(' ','<br>')}</h3>${price}<div class="tile-tokens"></div>`;
  return el;
}
function makeCorner(idx){
  const el = document.createElement('div'); el.className='corner'; el.dataset.idx=String(idx); el.innerHTML='<div class="tile-tokens"></div>'; if(idx===0)el.classList.add('go'); if(idx===10)el.classList.add('jail'); return el;
}
function build(container){
  container.classList.add('container','stage0');
  container.appendChild(makeCorner(0));
  const mkRow=(cls,from,to,dec=1)=>{ const w=document.createElement('div'); w.className=`gameRow ${cls}`; const r=document.createElement('div'); r.className='row'; for(let i=from;i!==to+dec;i+=dec){ r.appendChild(makeSpace(i, BOARD[i]||{})); } w.appendChild(r); container.appendChild(w); };
  mkRow('bottom',1,9,+1); container.appendChild(makeCorner(10));
  const left=document.createElement('div'); left.className='gameRow left'; const lr=document.createElement('div'); lr.className='row'; for(let i=19;i>=11;i--) lr.appendChild(makeSpace(i, BOARD[i]||{})); left.appendChild(lr); container.appendChild(left);
  container.appendChild(makeCorner(20));
  mkRow('top',29,21,-1);
  container.appendChild(makeCorner(30));
  mkRow('right',31,39,+1);
  const center=document.createElement('div'); center.className='center'; center.innerHTML='<div class="top"></div><div></div><div class="bottom"></div>'; container.appendChild(center);
}
const DEFAULT_COLORS = ['#44ef5bff','#f59e0b','#10b981','#3b82f6','#8b5cf6','#ec4899'];

export function mountBoard(container, opts = {}) {
  injectStyleOnce();
  if (!container.querySelector('[data-idx]')) build(container);
  const tiles = new Map([...container.querySelectorAll('[data-idx]')].map(el=>[Number(el.dataset.idx), el]));
  tiles.forEach(el=>{ ensureTokenLayer(el); setOwnerRing(el,null); setImprovements(el,0); });

  const tokenMap = new Map();
  const motionLayer = container.querySelector('.motion-layer') || container.appendChild(Object.assign(document.createElement('div'), { className: 'motion-layer' }));
  const gm = !!opts.gm;
  let last = null;

  function getState(){ return typeof opts.getState==='function' ? opts.getState() : last; }
  function colorForPid(pid){ const st=getState(); return st?.players?.[pid]?.color || DEFAULT_COLORS[pid%DEFAULT_COLORS.length]; }

  if (gm) {
    container.addEventListener('contextmenu', (e)=>{
      const t = e.target.closest('[data-idx]'); if(!t) return; e.preventDefault();
      const idx = Number(t.dataset.idx); const st=getState()||{};
      const me = st.turn|0; const deed = st.properties?.[idx]; const meta = BOARD[idx]||{};
      const isStreet = meta.kind==='street'; const canBuy=['street','rr','util'].includes(meta.kind);
      const houses = deed?.houses|0; const mort = !!deed?.mortgaged;
      const items = [
        { label:`Teleport P${me+1}`, onClick:()=>opts.onAction?.({ type:'gm.teleport', idx, pid:me }) },
        { label: canBuy?`Buy for P${me+1}`:'Buy (N/A)', disabled:!canBuy, onClick:()=>opts.onAction?.({ type:'gm.buy', idx, pid:me }) },
        { label:'Start auction', onClick:()=>opts.onAction?.({ type:'gm.auction', idx }) },
        { label: mort?'Unmortgage':'Mortgage', onClick:()=>opts.onAction?.({ type: mort?'gm.unmortgage':'gm.mortgage', idx }) },
        isStreet?{ label:'Build house', sub:`now ${houses}`, onClick:()=>opts.onAction?.({ type:'gm.build', idx, delta:+1 }) }:null,
        isStreet?{ label:'Remove house', sub:`now ${houses}`, disabled:houses<=0, onClick:()=>opts.onAction?.({ type:'gm.build', idx, delta:-1 }) }:null,
        { label:'Give to…', onClick:()=>{ const items2=(st.players||[]).map((p,pid)=>p && ({ label:`P${pid+1} • ${p.name||''}`, onClick:()=>opts.onAction?.({ type:'gm.transfer', idx, pid }) } )).filter(Boolean); menu(items2,{ x:e.clientX+230, y:e.clientY }); } },
        deed?.owner!=null?{ label:'Clear owner', onClick:()=>opts.onAction?.({ type:'gm.transfer', idx, pid:null }) }:null
      ].filter(Boolean);
      menu(items,{ x:e.clientX, y:e.clientY });
    });
  }

  function menu(items, at){ const m=document.createElement('div'); m.className='gm-menu'; const ul=document.createElement('ul'); items.forEach(it=>{ const li=document.createElement('li'); li.textContent=it.label; if(it.sub){ const s=document.createElement('span'); s.className='sub'; s.textContent=it.sub; li.appendChild(s);} if(it.disabled) li.setAttribute('aria-disabled','true'); li.onclick=(ev)=>{ ev.stopPropagation(); it.onClick?.(); close(); }; ul.appendChild(li); }); m.appendChild(ul); document.body.appendChild(m); const vw=Math.max(document.documentElement.clientWidth,window.innerWidth||0),vh=Math.max(document.documentElement.clientHeight,window.innerHeight||0); m.style.left=Math.min(at.x, vw-m.offsetWidth-8)+'px'; m.style.top=Math.min(at.y, vh-m.offsetHeight-8)+'px'; function close(){ m.remove(); window.removeEventListener('blur',close); document.removeEventListener('click',onDoc);} function onDoc(){ close(); } window.addEventListener('blur',close,{once:true}); setTimeout(()=>document.addEventListener('click',onDoc,{once:true}),0); }

function clearTokens(){ tiles.forEach(el=>{ const b=el.querySelector('.tile-tokens'); if(b) b.textContent=''; }); }
function renderTokens(st){
    const present = new Set();
    const turn = st?.turn;
    (st?.players||[]).forEach((p,pid)=>{
      if(!p) return; present.add(pid);
      const el=tiles.get((p.pos|0)); if(!el) return; const box=el.querySelector('.tile-tokens');
      let tok=tokenMap.get(pid);
      if(!tok){ tok=document.createElement('div'); tok.className='tile-token'; tok.dataset.pid=String(pid); tokenMap.set(pid,tok); }
      tok.classList.toggle('turn', pid===turn);
      tok.style.background = colorForPid(pid);
      tok.title = `P${pid+1}`;
      if (tok.parentElement !== box) {
        box.appendChild(tok);
      }
    });
    // remove tokens for players no longer present
    [...tokenMap.keys()].forEach(pid=>{ if(!present.has(pid)){ const el=tokenMap.get(pid); if(el && el.parentElement) el.parentElement.removeChild(el); tokenMap.delete(pid); } });
}
  function renderOwnership(st){
    tiles.forEach(el=>{ setOwnerRing(el,null); setImprovements(el,0); });
    (st?.properties||[]).forEach((d,idx)=>{ if(!d) return; const el=tiles.get(idx); if(!el) return; if(d.owner!=null) setOwnerRing(el, colorForPid(d.owner)); const meta=BOARD[idx]; if(meta?.kind==='street') setImprovements(el, d.houses|0); });
  }

  function render(state){ last=state; renderTokens(state); renderOwnership(state); }
  function destroy(){ tokenMap.clear(); clearTokens(); }
  function getTileEl(idx){ return tiles.get(idx)||null; }
  function getToken(pid){ return tokenMap.get(pid)||null; }

  function getTileCenter(idx){
    const el = tiles.get(idx); if(!el) return { x:0, y:0 };
    const box = el.querySelector('.tile-tokens') || el;
    const crect = container.getBoundingClientRect();
    const b = box.getBoundingClientRect();
    return { x: (b.left + b.right)/2 - crect.left, y: (b.top + b.bottom)/2 - crect.top };
  }

  function pathIndices(from, to){ const path=[]; for(let i=1;i<=40;i++){ const idx=(from+i)%40; path.push(idx); if(idx===((to%40)+40)%40) break; } return path; }

  async function animateMove(pid, from, to, opts2 = {}){
    try {
      const tok = getToken(pid);
      if (!tok || typeof from !== 'number' || typeof to !== 'number') return;
      const indices = pathIndices(from, to);
      const totalSteps = Math.max(1, (opts2.steps || indices.length));
      const baseStep = Math.max(140, opts2.stepMs || 240); // slower base step
      const dur = Math.max(300, opts2.durationMs || Math.min(2200, totalSteps * baseStep));
      const vary = opts2.vary !== false; // default to true
      const color = tok.style.background || '#999';
      const start = getTileCenter(from);
      const way = indices.map(idx => getTileCenter(idx));
      const ghost = document.createElement('div');
      ghost.className = 'token-ghost';
      ghost.style.background = color;
      ghost.style.transform = `translate(${start.x - 8}px, ${start.y - 8}px)`;
      // Initial duration; will adjust per step for variation
      ghost.style.transitionDuration = `${Math.max(120, (dur/totalSteps)|0)}ms`;
      ghost.style.transitionTimingFunction = 'ease-out';
      motionLayer.appendChild(ghost);
      const prevVis = tok.style.visibility; tok.style.visibility = 'hidden';
      await new Promise(resolve => setTimeout(resolve, 16));
      for (let i=0;i<way.length;i++){
        const p = way[i];
        // step duration variation and ease tweaks
        let stepMs = dur/totalSteps;
        if (vary) {
          const jitter = 0.9 + Math.random()*0.35; // 0.9..1.25x
          stepMs = Math.max(120, stepMs * jitter);
          // small pause on corners
          const idxHere = indices[i];
          if (idxHere === 0 || idxHere === 10 || idxHere === 20 || idxHere === 30) stepMs += 120;
          ghost.style.transitionTimingFunction = (i % 2 === 0) ? 'cubic-bezier(.22,.67,.3,1)' : 'ease-out';
        }
        ghost.style.transitionDuration = `${stepMs|0}ms`;
        await new Promise(res => {
          const onEnd = () => { ghost.removeEventListener('transitionend', onEnd); res(); };
          ghost.addEventListener('transitionend', onEnd, { once:true });
          ghost.style.transform = `translate(${p.x - 8}px, ${p.y - 8}px)`;
          // Fallback timeout in case transitionend is missed
          setTimeout(onEnd, Math.max(160, stepMs+80));
        });
      }
      if (vary) {
        // Small landing bounce
        const last = way[way.length-1] || start;
        ghost.style.transitionTimingFunction = 'ease-out';
        ghost.style.transitionDuration = '140ms';
        ghost.style.transform = `translate(${last.x - 8}px, ${last.y - 8}px) scale(1.15)`;
        await new Promise(r=> setTimeout(r, 150));
        ghost.style.transitionDuration = '120ms';
        ghost.style.transform = `translate(${last.x - 8}px, ${last.y - 8}px) scale(1.0)`;
        await new Promise(r=> setTimeout(r, 130));
      }
      ghost.remove();
      tok.style.visibility = prevVis || '';
    } catch {}
  }

  return { render, destroy, getTileEl, animateMove, getToken };
}
