import { FONT } from "./font5x7.js";

export const OLED = {
  clear(ctx, invert){ ctx.fillStyle = invert ? "#fff" : "#000"; ctx.fillRect(0,0,64,32); },
  drawChar(ctx,ch,x,y,bold){
    const g = FONT.MAP[ch] || FONT.MAP[' '];
    for(let r=0;r<FONT.H;r++){
      const line=g[r];
      for(let c=0;c<FONT.W;c++){
        if(line[c]==='1'){ ctx.fillRect(x+c,y+r,1,1); if(bold) ctx.fillRect(x+c+1,y+r,1,1); }
      }
    }
    return FONT.W+FONT.GAP+(bold?1:0);
  },
  drawText(ctx,text,x,y,align,bold){
    text = (text||'').toUpperCase().slice(0,12);
    const adv = FONT.W+FONT.GAP+(bold?1:0);
    const w = text.length ? text.length*adv - FONT.GAP : 0;
    let dx=x; if(align==='center') dx = Math.max(0,x-Math.floor(w/2)); if(align==='right') dx=Math.max(0,x-w);
    for(const ch of text){ dx += OLED.drawChar(ctx,ch,dx,y,bold); }
  },
  card(ctx,{L1,L2,L3,L4},{invert=false,bold=true}){
    OLED.clear(ctx,invert);
    ctx.imageSmoothingEnabled=false;
    ctx.fillStyle = invert?'#000':'#fff';
    OLED.drawText(ctx,L1,0,0,'left',bold);
    OLED.drawText(ctx,L2,0,8,'left',bold);
    OLED.drawText(ctx,L3,32,15,'center',bold);
    OLED.drawText(ctx,L4,0,25,'left',bold);
  }
};
