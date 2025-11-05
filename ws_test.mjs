import WebSocket from "ws";
const ws = new WebSocket("ws://localhost:8080");
let gotState = false;
ws.on("message", (raw) => {
  const msg = JSON.parse(raw.toString());
  if (msg.type === 'state' && !gotState) {
    gotState = true;
    ws.send(JSON.stringify({ type:"setPlayerPos", index:0, pos:39 }));
    setTimeout(()=> ws.send(JSON.stringify({ type:"rollDice", by:0, autoMove:true, requireTurn:false })), 10);
  }
  if (msg.type === 'money') {
    console.log('money update:', msg.data[0]);
    ws.close();
  }
});
