/**
 * Aisho — UNO Game · Multiplayer Server (Node.js + Express + Socket.io)
 * Rooms lobby + authoritative game + chat + WebRTC voice signaling.
 * Advanced rules: cross-stacking +2/+4, Wild+4 challenge, UNO call + catch (draw 4), round scoring.
 */
const path = require("path");
const http = require("http");
const express = require("express");
const { Server } = require("socket.io");

const app = express();
app.use(express.static(path.join(__dirname, "public")));
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });
const PORT = process.env.PORT || 3000;
const UNO_PENALTY = 4; // cards drawn when caught not saying UNO

const COLORS = ["red", "yellow", "green", "blue"];
function buildDeck() {
  const d = [];
  for (const c of COLORS) {
    d.push({ color: c, kind: "num", val: 0 });
    for (let n = 1; n <= 9; n++) { d.push({ color: c, kind: "num", val: n }); d.push({ color: c, kind: "num", val: n }); }
    for (const k of ["skip", "reverse", "draw2"]) { d.push({ color: c, kind: k }); d.push({ color: c, kind: k }); }
  }
  for (let i = 0; i < 4; i++) { d.push({ color: "wild", kind: "wild" }); d.push({ color: "wild", kind: "wild4" }); }
  return shuffle(d);
}
function shuffle(a) { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
function isDraw(card) { return card.kind === "draw2" || card.kind === "wild4"; }
function cardValue(c) { if (c.kind === "num") return c.val; if (c.kind === "wild" || c.kind === "wild4") return 50; return 20; }
function canPlay(card, activeColor, top) {
  if (card.color === "wild") return true;
  if (card.color === activeColor) return true;
  if (card.kind === "num" && top.kind === "num" && card.val === top.val) return true;
  if (card.kind !== "num" && card.kind === top.kind) return true;
  return false;
}

const rooms = new Map();
function genId() { return Math.random().toString(36).slice(2, 7).toUpperCase(); }
function createRoom(hostName, opts = {}) {
  let id; do { id = genId(); } while (rooms.has(id));
  const room = {
    id, name: opts.name || `${hostName}'s room`,
    maxPlayers: Math.min(4, Math.max(2, opts.maxPlayers || 4)),
    started: false, hostId: null, players: [], game: null,
    voice: new Set(), chat: [], createdAt: Date.now(),
  };
  rooms.set(id, room);
  return room;
}
function publicRoomList() {
  return [...rooms.values()].filter(r => !r.started && r.players.length < r.maxPlayers)
    .map(r => ({ id: r.id, name: r.name, players: r.players.length, maxPlayers: r.maxPlayers }));
}
function broadcastLobby() { io.to("lobby").emit("lobby", publicRoomList()); }

function startGame(room) {
  const deck = buildDeck();
  for (const p of room.players) { p.hand = deck.splice(0, 7); p.saidUno = false; }
  const idx = deck.findIndex(c => c.kind === "num");
  const first = deck.splice(idx, 1)[0];
  room.game = {
    deck, discard: [first], activeColor: first.color, cur: 0, dir: 1,
    over: false, winner: null, log: [],
    pendingDraw: 0, wild4By: -1, wild4Legal: true, unoVuln: -1, scores: null,
  };
  room.started = true;
  broadcastLobby();
  pushState(room, `Round started! ${room.players[0].name} goes first.`);
  maybeAI(room);
}
function topCard(g) { return g.discard[g.discard.length - 1]; }
function nextIndex(room, steps = 1) { const n = room.players.length; return (((room.game.cur + room.game.dir * steps) % n) + n) % n; }
function advance(room, steps = 1) { room.game.cur = nextIndex(room, steps); }
function drawFor(room, pIndex, k) {
  const g = room.game, p = room.players[pIndex];
  for (let i = 0; i < k; i++) { if (g.deck.length === 0) reshuffle(g); if (g.deck.length === 0) break; p.hand.push(g.deck.shift()); }
  p.saidUno = false;
  if (g.unoVuln === pIndex) g.unoVuln = -1;
}
function reshuffle(g) { const top = g.discard.pop(); g.deck = shuffle(g.discard); g.discard = [top]; }

function closeUnoWindow(room, actingIndex) {
  const g = room.game;
  if (g.unoVuln !== -1 && g.unoVuln !== actingIndex) g.unoVuln = -1;
}

function playCard(room, pIndex, handIndex, chosenColor) {
  const g = room.game;
  if (!g || g.over) return { ok: false, msg: "Game not active" };
  if (g.cur !== pIndex) return { ok: false, msg: "Not your turn" };
  const p = room.players[pIndex];
  const card = p.hand[handIndex];
  if (!card) return { ok: false, msg: "No such card" };
  const top = topCard(g);
  const chain = g.pendingDraw > 0;
  if (chain) {
    if (!isDraw(card)) return { ok: false, msg: "Stack a +2/+4 or draw the pile" };
  } else {
    if (!canPlay(card, g.activeColor, top)) return { ok: false, msg: "Illegal move" };
  }

  const preColor = g.activeColor;
  const handBefore = p.hand.slice();
  p.hand.splice(handIndex, 1);
  g.discard.push(card);
  g.activeColor = card.color === "wild" ? (chosenColor || "red") : card.color;
  closeUnoWindow(room, pIndex);

  let msg = `${p.name} played ${describe(card)}`;
  let skip = false;
  if (card.kind === "skip") { skip = true; }
  else if (card.kind === "reverse") { g.dir *= -1; if (room.players.length === 2) skip = true; }
  else if (card.kind === "draw2") { g.pendingDraw += 2; msg += ` — +${g.pendingDraw} pending`; g.wild4By = -1; }
  else if (card.kind === "wild4") {
    const hadColor = handBefore.some(c => c.color === preColor && c.color !== "wild");
    g.pendingDraw += 4; g.wild4By = pIndex; g.wild4Legal = !hadColor;
    msg += ` (color ${g.activeColor}) — +${g.pendingDraw} pending`;
  }
  else if (card.kind === "wild") { msg += ` (color ${g.activeColor})`; }

  if (p.hand.length === 0) { endRound(room, pIndex); return { ok: true }; }

  // UNO state — honor a pre-call made while holding 2 cards
  if (p.hand.length === 1) {
    if (p.isAI || p.saidUno) { p.saidUno = true; }
    else { g.unoVuln = pIndex; p.saidUno = false; msg += ` — UNO?`; }
  } else { p.saidUno = false; }

  advance(room, skip ? 2 : 1);
  pushState(room, msg);
  maybeAI(room);
  return { ok: true };
}

function drawTurn(room, pIndex) {
  const g = room.game;
  if (!g || g.over || g.cur !== pIndex) return { ok: false, msg: "Not your turn" };
  closeUnoWindow(room, pIndex);
  if (g.pendingDraw > 0) {
    const n = g.pendingDraw;
    drawFor(room, pIndex, n);
    g.pendingDraw = 0; g.wild4By = -1;
    advance(room, 1);
    pushState(room, `${room.players[pIndex].name} drew ${n} and was skipped`);
    maybeAI(room);
    return { ok: true, drewPile: true };
  }
  drawFor(room, pIndex, 1);
  const p = room.players[pIndex];
  const card = p.hand[p.hand.length - 1];
  if (canPlay(card, g.activeColor, topCard(g))) { pushState(room, `${p.name} drew a card`); return { ok: true, canPlayDrawn: true }; }
  advance(room, 1); pushState(room, `${p.name} drew and passed`); maybeAI(room);
  return { ok: true, canPlayDrawn: false };
}
function passTurn(room, pIndex) {
  const g = room.game;
  if (!g || g.over || g.cur !== pIndex || g.pendingDraw > 0) return { ok: false };
  closeUnoWindow(room, pIndex);
  advance(room, 1); pushState(room, `${room.players[pIndex].name} passed`); maybeAI(room);
  return { ok: true };
}

function challenge(room, pIndex) {
  const g = room.game;
  if (!g || g.over || g.cur !== pIndex) return { ok: false, msg: "Not your turn" };
  if (g.pendingDraw <= 0 || topCard(g).kind !== "wild4" || g.wild4By < 0)
    return { ok: false, msg: "Nothing to challenge" };
  const accuser = room.players[pIndex];
  const accused = room.players[g.wild4By];
  if (!g.wild4Legal) {
    const n = g.pendingDraw;
    drawFor(room, g.wild4By, n);
    g.pendingDraw = 0; g.wild4By = -1;
    pushState(room, `${accuser.name} challenged — ${accused.name} bluffed and draws ${n}! ${accuser.name}'s turn.`);
    maybeAI(room);
  } else {
    const n = g.pendingDraw + 2;
    drawFor(room, pIndex, n);
    g.pendingDraw = 0; g.wild4By = -1;
    advance(room, 1);
    pushState(room, `${accuser.name} challenged and was wrong — draws ${n} and is skipped.`);
    maybeAI(room);
  }
  return { ok: true };
}

function catchUno(room, byIndex, targetIndex) {
  const g = room.game;
  if (!g || g.over) return { ok: false };
  if (g.unoVuln !== targetIndex || targetIndex < 0) return { ok: false, msg: "Nobody to catch" };
  const t = room.players[targetIndex];
  if (t.saidUno || t.hand.length !== 1) { g.unoVuln = -1; return { ok: false }; }
  drawFor(room, targetIndex, UNO_PENALTY);
  g.unoVuln = -1;
  pushState(room, `${room.players[byIndex].name} caught ${t.name} — +${UNO_PENALTY} for not saying UNO!`);
  return { ok: true };
}
function callUno(room, pIndex) {
  const g = room.game; if (!g) return;
  const p = room.players[pIndex];
  if (p && p.hand && p.hand.length <= 2) { p.saidUno = true; if (g.unoVuln === pIndex) g.unoVuln = -1; pushState(room, `${p.name}: UNO!`); }
}

function endRound(room, winnerIndex) {
  const g = room.game;
  g.over = true; g.winner = room.players[winnerIndex].name;
  g.pendingDraw = 0; g.unoVuln = -1;
  let total = 0;
  const breakdown = room.players.map((p, i) => {
    const pts = (p.hand || []).reduce((s, c) => s + cardValue(c), 0);
    if (i !== winnerIndex) total += pts;
    return { name: p.name, leftover: i === winnerIndex ? 0 : pts, cards: p.hand ? p.hand.length : 0, winner: i === winnerIndex };
  });
  g.scores = { winner: g.winner, winnerPoints: total, breakdown };
  pushState(room, `${g.winner} wins the round for ${total} points! 🎉`);
}

function describe(c) {
  if (c.kind === "num") return `${c.color} ${c.val}`;
  const names = { skip: "Skip", reverse: "Reverse", draw2: "Draw Two", wild: "Wild", wild4: "Wild Draw Four" };
  return c.color === "wild" ? names[c.kind] : `${c.color} ${names[c.kind]}`;
}

function maybeAI(room) {
  const g = room.game; if (!g || g.over) return;
  const p = room.players[g.cur]; if (!p || !p.isAI) return;
  setTimeout(() => aiMove(room), 850);
}
function aiMove(room) {
  const g = room.game; if (!g || g.over) return;
  const pIndex = g.cur, p = room.players[pIndex]; if (!p.isAI) return;

  if (g.unoVuln !== -1 && g.unoVuln !== pIndex) {
    const t = room.players[g.unoVuln];
    if (t && !t.isAI && !t.saidUno && t.hand.length === 1) catchUno(room, pIndex, g.unoVuln);
  }
  if (g.over) return;

  if (g.pendingDraw > 0) {
    const i = p.hand.findIndex(c => isDraw(c));
    if (i >= 0) { setTimeout(() => aiPlay(room, pIndex, i), 350); }
    else { drawTurn(room, pIndex); }
    return;
  }

  const top = topCard(g);
  const choices = []; p.hand.forEach((c, i) => { if (canPlay(c, g.activeColor, top)) choices.push(i); });
  if (choices.length === 0) {
    const r = drawTurn(room, pIndex);
    if (r.canPlayDrawn) {
      const i = p.hand.findIndex(c => canPlay(c, g.activeColor, topCard(g)));
      if (i >= 0) setTimeout(() => aiPlay(room, pIndex, i), 500); else passTurn(room, pIndex);
    }
    return;
  }
  let best = choices[0], bestScore = -1e9;
  for (const i of choices) {
    const c = p.hand[i]; let s = 0;
    if (c.kind === "num") s = c.val;
    else if (c.kind === "draw2") s = 22;
    else if (c.kind === "skip" || c.kind === "reverse") s = 16;
    else if (c.kind === "wild4") s = 8;
    else if (c.kind === "wild") s = 5;
    if (c.color === g.activeColor) s += 2;
    if (s > bestScore) { bestScore = s; best = i; }
  }
  aiPlay(room, pIndex, best);
}
function aiPlay(room, pIndex, handIndex) {
  const g = room.game; if (!g || g.over) return;
  const p = room.players[pIndex]; const card = p.hand[handIndex]; if (!card) return;
  let chosen = card.color;
  if (card.color === "wild") {
    const tally = { red: 0, yellow: 0, green: 0, blue: 0 };
    p.hand.forEach((c, i) => { if (i !== handIndex && c.color !== "wild") tally[c.color]++; });
    chosen = Object.keys(tally).sort((a, b) => tally[b] - tally[a])[0];
    if (tally[chosen] === 0) chosen = COLORS[Math.floor(Math.random() * 4)];
  }
  playCard(room, pIndex, handIndex, chosen);
}

function stateFor(room, socketId) {
  const g = room.game;
  const me = room.players.findIndex(p => p.id === socketId);
  const base = {
    roomId: room.id, roomName: room.name, started: room.started, hostId: room.hostId,
    maxPlayers: room.maxPlayers, me,
    players: room.players.map((p, i) => ({
      index: i, name: p.name, isAI: p.isAI, connected: p.connected,
      count: p.hand ? p.hand.length : 0,
      vulnerable: g ? (g.unoVuln === i) : false,
    })),
  };
  if (g) {
    const top = topCard(g);
    base.game = {
      activeColor: g.activeColor, top, cur: g.cur, dir: g.dir,
      over: g.over, winner: g.winner, deckCount: g.deck.length, lastMsg: g.log[g.log.length - 1] || "",
      pendingDraw: g.pendingDraw,
      canChallenge: g.pendingDraw > 0 && top.kind === "wild4" && g.wild4By >= 0 && g.cur === me,
      scores: g.scores,
    };
    base.hand = (me >= 0 && room.players[me].hand) ? room.players[me].hand : [];
  }
  return base;
}
function pushState(room, msg) {
  if (room.game && msg) { room.game.log.push(msg); if (room.game.log.length > 30) room.game.log.shift(); }
  for (const p of room.players) { if (p.isAI || !p.connected) continue; io.to(p.id).emit("state", stateFor(room, p.id)); }
}

function nameFor(room, sid) { const p = room.players.find(x => x.id === sid); return p ? p.name : "Player"; }
function broadcastVoiceRoster(room) {
  io.to(room.id).emit("voiceRoster", [...room.voice].map(sid => ({ id: sid, name: nameFor(room, sid) })));
}
function leaveVoice(room, sid) {
  if (!room || !room.voice.has(sid)) return;
  room.voice.delete(sid);
  io.to(room.id).emit("voice-peer-left", { id: sid });
  broadcastVoiceRoster(room);
}
function idxOf(room, sid) { return room.players.findIndex(p => p.id === sid); }

io.on("connection", (socket) => {
  socket.data.roomId = null;
  socket.join("lobby");
  socket.emit("lobby", publicRoomList());

  socket.on("listRooms", () => socket.emit("lobby", publicRoomList()));

  socket.on("createRoom", ({ name, roomName, maxPlayers, aiSeats }, cb) => {
    const room = createRoom(name || "Player", { name: roomName, maxPlayers });
    room.hostId = socket.id;
    joinRoom(socket, room, name || "Player");
    const ai = Math.max(0, Math.min((room.maxPlayers - 1), aiSeats || 0));
    for (let i = 0; i < ai; i++) room.players.push({ id: "AI_" + genId(), name: "CPU " + (i + 1), hand: [], isAI: true, connected: true, saidUno: false });
    cb && cb({ ok: true, roomId: room.id });
    broadcastLobby();
    pushState(room, "");
  });

  socket.on("joinRoom", ({ roomId, name }, cb) => {
    const room = rooms.get((roomId || "").toUpperCase());
    if (!room) return cb && cb({ ok: false, msg: "Room not found" });
    if (room.started) return cb && cb({ ok: false, msg: "Game already started" });
    if (room.players.filter(p => !p.isAI).length >= room.maxPlayers) return cb && cb({ ok: false, msg: "Room full" });
    if (room.players.length >= room.maxPlayers) {
      const aiIdx = room.players.findIndex(p => p.isAI);
      if (aiIdx >= 0) room.players.splice(aiIdx, 1); else return cb && cb({ ok: false, msg: "Room full" });
    }
    joinRoom(socket, room, name || "Player");
    cb && cb({ ok: true, roomId: room.id });
    broadcastLobby();
    pushState(room, `${name || "Player"} joined`);
  });

  socket.on("startGame", () => {
    const room = rooms.get(socket.data.roomId);
    if (!room || room.hostId !== socket.id) return;
    if (room.players.length < 2) { socket.emit("err", "Need at least 2 players"); return; }
    startGame(room);
  });
  socket.on("newRound", () => {
    const room = rooms.get(socket.data.roomId);
    if (!room || room.hostId !== socket.id) return;
    if (room.players.length < 2) return;
    startGame(room);
  });

  socket.on("addAI", () => {
    const room = rooms.get(socket.data.roomId);
    if (!room || room.hostId !== socket.id || room.started) return;
    if (room.players.length >= room.maxPlayers) return;
    room.players.push({ id: "AI_" + genId(), name: "CPU " + room.players.length, hand: [], isAI: true, connected: true });
    broadcastLobby();
    pushState(room, "");
  });

  socket.on("play", ({ handIndex, color }) => {
    const room = rooms.get(socket.data.roomId); if (!room) return;
    const r = playCard(room, idxOf(room, socket.id), handIndex, color);
    if (!r.ok) socket.emit("err", r.msg);
  });
  socket.on("draw", () => {
    const room = rooms.get(socket.data.roomId); if (!room) return;
    const r = drawTurn(room, idxOf(room, socket.id));
    if (r.ok && r.canPlayDrawn) socket.emit("drewPlayable");
  });
  socket.on("pass", () => {
    const room = rooms.get(socket.data.roomId); if (!room) return;
    passTurn(room, idxOf(room, socket.id));
  });
  socket.on("challenge", () => {
    const room = rooms.get(socket.data.roomId); if (!room) return;
    const r = challenge(room, idxOf(room, socket.id));
    if (!r.ok && r.msg) socket.emit("err", r.msg);
  });
  socket.on("callUno", () => {
    const room = rooms.get(socket.data.roomId); if (!room) return;
    callUno(room, idxOf(room, socket.id));
  });
  socket.on("catchUno", ({ target }) => {
    const room = rooms.get(socket.data.roomId); if (!room) return;
    catchUno(room, idxOf(room, socket.id), typeof target === "number" ? target : -1);
  });

  socket.on("chat", ({ text }) => {
    const room = rooms.get(socket.data.roomId); if (!room) return;
    const clean = String(text || "").trim().slice(0, 300); if (!clean) return;
    const msg = { name: nameFor(room, socket.id), text: clean, ts: Date.now() };
    room.chat.push(msg); if (room.chat.length > 100) room.chat.shift();
    io.to(room.id).emit("chat", msg);
  });

  socket.on("voice-join", () => {
    const room = rooms.get(socket.data.roomId); if (!room) return;
    const others = [...room.voice].filter(id => id !== socket.id);
    room.voice.add(socket.id);
    socket.emit("voice-peers", { peers: others });
    broadcastVoiceRoster(room);
  });
  socket.on("voice-signal", ({ to, data }) => { if (to) io.to(to).emit("voice-signal", { from: socket.id, data }); });
  socket.on("voice-leave", () => { const room = rooms.get(socket.data.roomId); leaveVoice(room, socket.id); });

  socket.on("leaveRoom", () => handleLeave(socket));
  socket.on("disconnect", () => handleLeave(socket));
});

function joinRoom(socket, room, name) {
  socket.leave("lobby");
  socket.join(room.id);
  socket.data.roomId = room.id;
  room.players.push({ id: socket.id, name, hand: [], isAI: false, connected: true, saidUno: false });
  if (!room.hostId) room.hostId = socket.id;
}
function handleLeave(socket) {
  const room = rooms.get(socket.data.roomId);
  socket.data.roomId = null;
  socket.join("lobby");
  if (!room) return;
  leaveVoice(room, socket.id);
  const idx = room.players.findIndex(p => p.id === socket.id);
  if (idx < 0) return;
  if (room.started && room.game && !room.game.over) {
    room.players[idx].connected = false;
    room.players[idx].isAI = true;
    room.players[idx].name += " (left)";
    pushState(room, `${room.players[idx].name} disconnected`);
    maybeAI(room);
  } else {
    room.players.splice(idx, 1);
    if (room.hostId === socket.id) { const nh = room.players.find(p => !p.isAI); room.hostId = nh ? nh.id : null; }
    pushState(room, "");
  }
  if (room.players.filter(p => !p.isAI).length === 0) rooms.delete(room.id);
  broadcastLobby();
}

server.listen(PORT, () => { console.log(`Aisho — UNO Game server running:  http://localhost:${PORT}`); });
