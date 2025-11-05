// public/js/props.js
export const GROUP = { BROWN:0, LBLUE:1, MAG:2, ORANGE:3, RED:4, YELLOW:5, GREEN:6, DBLUE:7, RR:8, UTIL:9 };

export const PROPS = [
  { id:  1, name:'Mediterranean Avenue', type:'street', group:GROUP.BROWN, price:60,  mort:30,  house:50,  rents:[2,10,30,90,160,250], board:1 },
  { id:  3, name:'Baltic Avenue',        type:'street', group:GROUP.BROWN, price:60,  mort:30,  house:50,  rents:[4,20,60,180,320,450], board:3 },
  { id:  6, name:'Oriental Avenue',      type:'street', group:GROUP.LBLUE, price:100, mort:50,  house:50,  rents:[6,30,90,270,400,550], board:6 },
  { id:  8, name:'Vermont Avenue',       type:'street', group:GROUP.LBLUE, price:100, mort:50,  house:50,  rents:[6,30,90,270,400,550], board:8 },
  { id:  9, name:'Connecticut Avenue',   type:'street', group:GROUP.LBLUE, price:120, mort:60,  house:50,  rents:[8,40,100,300,450,600], board:9 },
  { id: 11, name:'St. Charles Place',    type:'street', group:GROUP.MAG,   price:140, mort:70,  house:100, rents:[10,50,150,450,625,750], board:11 },
  { id: 13, name:'States Avenue',        type:'street', group:GROUP.MAG,   price:140, mort:70,  house:100, rents:[10,50,150,450,625,750], board:13 },
  { id: 14, name:'Virginia Avenue',      type:'street', group:GROUP.MAG,   price:160, mort:80,  house:100, rents:[12,60,180,500,700,900], board:14 },
  { id: 16, name:'St. James Place',      type:'street', group:GROUP.ORANGE,price:180, mort:90,  house:100, rents:[14,70,200,550,750,950], board:16 },
  { id: 18, name:'Tennessee Avenue',     type:'street', group:GROUP.ORANGE,price:180, mort:90,  house:100, rents:[14,70,200,550,750,950], board:18 },
  { id: 19, name:'New York Avenue',      type:'street', group:GROUP.ORANGE,price:200, mort:100, house:100, rents:[16,80,220,600,800,1000],board:19 },
  { id: 21, name:'Kentucky Avenue',      type:'street', group:GROUP.RED,   price:220, mort:110, house:150, rents:[18,90,250,700,875,1050],board:21 },
  { id: 23, name:'Indiana Avenue',       type:'street', group:GROUP.RED,   price:220, mort:110, house:150, rents:[18,90,250,700,875,1050],board:23 },
  { id: 24, name:'Illinois Avenue',      type:'street', group:GROUP.RED,   price:240, mort:120, house:150, rents:[20,100,300,750,925,1100],board:24 },
  { id: 26, name:'Atlantic Avenue',      type:'street', group:GROUP.YELLOW,price:260, mort:130, house:150, rents:[22,110,330,800,975,1150],board:26 },
  { id: 27, name:'Ventnor Avenue',       type:'street', group:GROUP.YELLOW,price:260, mort:130, house:150, rents:[22,110,330,800,975,1150],board:27 },
  { id: 29, name:'Marvin Gardens',       type:'street', group:GROUP.YELLOW,price:280, mort:140, house:150, rents:[24,120,360,850,1025,1200],board:29 },
  { id: 31, name:'Pacific Avenue',       type:'street', group:GROUP.GREEN, price:300, mort:150, house:200, rents:[26,130,390,900,1100,1275],board:31 },
  { id: 32, name:'North Carolina Avenue',type:'street', group:GROUP.GREEN, price:300, mort:150, house:200, rents:[26,130,390,900,1100,1275],board:32 },
  { id: 34, name:'Pennsylvania Avenue',  type:'street', group:GROUP.GREEN, price:320, mort:160, house:200, rents:[28,150,450,1000,1200,1400],board:34 },
  { id: 37, name:'Park Place',           type:'street', group:GROUP.DBLUE, price:350, mort:175, house:200, rents:[35,175,500,1100,1300,1500],board:37 },
  { id: 39, name:'Boardwalk',            type:'street', group:GROUP.DBLUE, price:400, mort:200, house:200, rents:[50,200,600,1400,1700,2000],board:39 },
  { id:  5, name:'Reading Railroad',     type:'rr',     group:GROUP.RR,    price:200, mort:100, board:5  },
  { id: 15, name:'Pennsylvania Railroad',type:'rr',     group:GROUP.RR,    price:200, mort:100, board:15 },
  { id: 25, name:'B. & O. Railroad',     type:'rr',     group:GROUP.RR,    price:200, mort:100, board:25 },
  { id: 35, name:'Short Line',           type:'rr',     group:GROUP.RR,    price:200, mort:100, board:35 },
  { id: 12, name:'Electric Company',     type:'util',   group:GROUP.UTIL,  price:150, mort:75,  board:12 },
  { id: 28, name:'Water Works',          type:'util',   group:GROUP.UTIL,  price:150, mort:75,  board:28 }
];

export const boardIndexToPropIndex = (() => {
  const map = Array(40).fill(null);
  PROPS.forEach((p, i) => { map[p.board] = i; });
  return map;
})();

export const NON_BUY_LABELS = {
  0:'GO',2:'Community Chest',4:'Income Tax',7:'Chance',10:'Jail / Just Visiting',
  17:'Community Chest',20:'Free Parking',22:'Chance',30:'Go To Jail',
  33:'Community Chest',36:'Chance',38:'Luxury Tax'
};

export const COLORS = ['#580b37','#86a4d6','#c43467','#f58023','#f70f0fff','#fdca01','#11a55b','#284ea1','#252525ff','#faa747ff'];

export const isStreet = p => p.type==='street';
export const isRR     = p => p.type==='rr';
export const isUtil   = p => p.type==='util';

export function groupMembers(group){
  const idx=[]; PROPS.forEach((p,i)=>{ if(isStreet(p)&&p.group===group) idx.push(i); });
  return idx;
}
export function hasMonopoly(state, i){
  const p = PROPS[i]; if (!isStreet(p)) return false;
  const o = state.properties[i].owner; if (o===0) return false;
  return groupMembers(p.group).every(j => state.properties[j].owner === o);
}
export function rrCount(state, owner){
  let c=0; PROPS.forEach((p,i)=>{ if(isRR(p) && state.properties[i].owner === owner) c++; });
  return c;
}
export function rent(state, i){
  const p=PROPS[i], s=state.properties[i];
  if (s.owner===0) return 0;
  if (isStreet(p)){
    if (s.hotel>0) return p.rents[5];
    if (s.houses>0) return p.rents[Math.min(4,s.houses)];
    let base=p.rents[0]; if (hasMonopoly(state,i)) base*=2; return base;
  }
  if (isRR(p))   return [0,25,50,100,200][rrCount(state, s.owner)];
  if (isUtil(p)) return 0;
  return 0;
}
export function utilMult(state, i){
  const p=PROPS[i], s=state.properties[i]; if (!isUtil(p) || s.owner===0) return '';
  let both=false; PROPS.forEach((pp,ii)=>{ if(isUtil(pp) && state.properties[ii].owner===s.owner && ii!==i) both=true; });
  return both ? '10x' : '4x';
}

// ---- Chance / Community Chest (classic US edition)
// Structured card definitions; wording may vary by edition.
export const CHANCE_CARDS = [
  { id:'chance-advance-go',           deck:'chance', text:'Advance to GO (Collect $200)',            type:'move', target:0 },
  { id:'chance-illinois',             deck:'chance', text:'Advance to Illinois Ave.',                 type:'move', target:24 },
  { id:'chance-st-charles',           deck:'chance', text:'Advance to St. Charles Place',             type:'move', target:11 },
  { id:'chance-nearest-utility',      deck:'chance', text:'Advance to nearest Utility',               type:'nearestUtility' },
  { id:'chance-nearest-rr-1',         deck:'chance', text:'Advance to nearest Railroad',              type:'nearestRailroad' },
  { id:'chance-dividend-50',          deck:'chance', text:'Bank pays you dividend of $50',            type:'collect', amount:50 },
  { id:'chance-get-out-of-jail',      deck:'chance', text:'Get Out of Jail Free',                     type:'getOutOfJail' },
  { id:'chance-back-3',               deck:'chance', text:'Go back three spaces',                      type:'back3' },
  { id:'chance-go-to-jail',           deck:'chance', text:'Go to Jail',                                 type:'goToJail', target:10 },
  { id:'chance-repairs',              deck:'chance', text:'Make general repairs ($25/house, $100/hotel)', type:'repairs', perHouse:25, perHotel:100 },
  { id:'chance-poor-tax-15',          deck:'chance', text:'Pay poor tax of $15',                       type:'pay', amount:15 },
  { id:'chance-reading-rr',           deck:'chance', text:'Take a trip to Reading Railroad',           type:'move', target:5 },
  { id:'chance-boardwalk',            deck:'chance', text:'Advance to Boardwalk',                       type:'move', target:39 },
  { id:'chance-chairman-50-each',     deck:'chance', text:'Elected Chairman – Pay each player $50',    type:'payEachPlayer', amount:50 },
  { id:'chance-nearest-rr-2',         deck:'chance', text:'Advance to nearest Railroad',              type:'nearestRailroad' },
  { id:'chance-loan-matures-150',     deck:'chance', text:'Building loan matures – Collect $150',     type:'collect', amount:150 },
];

export const CHEST_CARDS = [
  { id:'chest-advance-go',            deck:'chest',  text:'Advance to GO (Collect $200)',             type:'move', target:0 },
  { id:'chest-bank-error-200',        deck:'chest',  text:'Bank error in your favor – Collect $200',  type:'collect', amount:200 },
  { id:'chest-doctors-fee-50',        deck:'chest',  text:"Doctor's fees – Pay $50",                 type:'pay', amount:50 },
  { id:'chest-stock-sale-50',         deck:'chest',  text:'From sale of stock you get $50',           type:'collect', amount:50 },
  { id:'chest-get-out-of-jail',       deck:'chest',  text:'Get Out of Jail Free',                     type:'getOutOfJail' },
  { id:'chest-go-to-jail',            deck:'chest',  text:'Go to Jail',                                 type:'goToJail', target:10 },
  { id:'chest-opera-night-50-each',   deck:'chest',  text:'Grand Opera Night – Collect $50 from each player', type:'collectFromEachPlayer', amount:50 },
  { id:'chest-holiday-fund-100',      deck:'chest',  text:'Holiday Fund matures – Receive $100',      type:'collect', amount:100 },
  { id:'chest-tax-refund-20',         deck:'chest',  text:'Income tax refund – Collect $20',          type:'collect', amount:20 },
  { id:'chest-birthday-10-each',      deck:'chest',  text:'It is your birthday – Collect $10 from each player', type:'collectFromEachPlayer', amount:10 },
  { id:'chest-life-insurance-100',    deck:'chest',  text:'Life insurance matures – Collect $100',    type:'collect', amount:100 },
  { id:'chest-hospital-fees-50',      deck:'chest',  text:'Hospital Fees – Pay $50',                  type:'pay', amount:50 },
  { id:'chest-school-fees-50',        deck:'chest',  text:'School Fees – Pay $50',                    type:'pay', amount:50 },
  { id:'chest-consultancy-25',        deck:'chest',  text:'Receive $25 consultancy fee',              type:'collect', amount:25 },
  { id:'chest-street-repairs',        deck:'chest',  text:'Street repairs ($40/house, $115/hotel)',   type:'repairs', perHouse:40, perHotel:115 },
  { id:'chest-beauty-contest-10',     deck:'chest',  text:'Second prize in a beauty contest – Collect $10', type:'collect', amount:10 },
  { id:'chest-inherit-100',           deck:'chest',  text:'You inherit $100',                         type:'collect', amount:100 },
];

