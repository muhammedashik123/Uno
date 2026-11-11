/**
 * Wildcard — UNO-style Card Game · Multiplayer Server (Node.js + Express + Socket.io)
 * Rooms lobby + authoritative game + chat + WebRTC voice signaling.
 * Advanced rules: stacking +2/+4 (only +4 on +4), mandatory draws, UNO call + catch (draw 4), round scoring.
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
const UNO_PENALTY = 4;        // cards drawn when caught not saying UNO
const MAX_PLAYERS = 20;       // upper safety limit per room (raise if you like)
const STACK_DECIDE_MS = 20000; // time to stack or draw before the draw is forced
const FORCED_DRAW_MS = 1200;   // short pause so everyone sees the forced draw happen
const CATCH_DELAY_MS = 2000;   // others can only tap "Catch" this long after the card was played
const CATCH_OPEN_MS = 3000;    // ...and the catch window then stays open at least this long
const NOTE_MAX_LEN = 40;       // player marks ("no red", "holding +4?")
const NOTES_PER_PLAYER = 4;

const MOCK = {
  skip:    ["got skipped 😢", "lost the turn 😭", "got skipped — so sad 😿", "must sit this one out 🥲"],
  draw:    ["got +{n} and lost the turn 😭", "ate +{n} cards 🥴", "took +{n}… ouch 😵", "picked up +{n}, no turn 😢"],
  last:    ["came last with {n} cards 😭", "is the last one standing — {n} cards 🥲"],
  caught:  ["forgot to say UNO — +{n} 🤦", "got caught napping — +{n} 😴"],
};
function mockLine(kind, n) { const a = MOCK[kind]; return a[Math.floor(Math.random() * a.length)].replace("{n}", n); }
// Everyone in the room sees this pop-up (the victim too).
function react(room, kind, index, n, extra = {}) {
  const p = room.players[index]; if (!p) return;
  io.to(room.id).emit("react", { kind, index, name: p.name, text: mockLine(kind, n), ...extra });
}

const COLORS = ["red", "yellow", "green", "blue"];
// One 108-card deck covers ~8 players. More players get more decks shuffled
// together, so a +2/+4 can always be paid in full.
function decksFor(players) { return Math.max(1, Math.ceil((players * 7 + 50) / 108)); }
function buildDeck(numDecks = 1) {
  const d = [];
  for (let k = 0; k < numDecks; k++) addOneDeck(d);
  return shuffle(d);
}
function addOneDeck(d) {
  for (const c of COLORS) {
    d.push({ color: c, kind: "num", val: 0 });
    for (let n = 1; n <= 9; n++) { d.push({ color: c, kind: "num", val: n }); d.push({ color: c, kind: "num", val: n }); }
    for (const k of ["skip", "reverse", "draw2"]) { d.push({ color: c, kind: k }); d.push({ color: c, kind: k }); }
  }
  for (let i = 0; i < 4; i++) { d.push({ color: "wild", kind: "wild" }); d.push({ color: "wild", kind: "wild4" }); }
}
const createAce = require("./ace");
let ace; // set up below once io + pushState exist
function shuffle(a) { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
function isDraw(card) { return card.kind === "draw2" || card.kind === "wild4"; }
// Stacking rule: only like on like — a +2 on a +2, a +4 on a +4.
function canStack(card, top) {
  if (!top || !isDraw(top)) return false;
  return card.kind === top.kind;
}
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
    gameType: opts.gameType === "ace" ? "ace" : "wildcard",
    hiddenCut: opts.gameType === "ace" && !!opts.hiddenCut,   // Ace: cut card played face down
    maxPlayers: Math.min(opts.gameType === "ace" ? 12 : MAX_PLAYERS, Math.max(2, parseInt(opts.maxPlayers, 10) || 4)),
    started: false, hostId: null, players: [], game: null,
    voice: new Set(), chat: [], notes: {}, createdAt: Date.now(),
  };
  rooms.set(id, room);
  return room;
}
function publicRoomList() {
  return [...rooms.values()].filter(r => !r.started && r.players.length < r.maxPlayers)
    .map(r => ({ id: r.id, name: r.name, players: r.players.length, maxPlayers: r.maxPlayers, gameType: r.gameType, hiddenCut: !!r.hiddenCut }));
}
function broadcastLobby() { io.to("lobby").emit("lobby", publicRoomList()); }

function startGame(room) {
  if (room.game) { clearTurnTimer(room.game); clearUnoVuln(room.game); ace.stop(room.game); }
  room.notes = {};
  if (room.gameType === "ace") { ace.start(room); broadcastLobby(); return; }
  const deck = buildDeck(decksFor(room.players.length));
  for (const p of room.players) { p.hand = deck.splice(0, 7); p.saidUno = false; }
  const idx = deck.findIndex(c => c.kind === "num");
  const first = deck.splice(idx, 1)[0];
  const starter = Math.floor(Math.random() * room.players.length); // random first player every round
  room.game = {
    deck, discard: [first], activeColor: first.color, cur: starter, dir: 1,
    over: false, winner: null, log: [],
    pendingDraw: 0, unoVuln: -1, scores: null,
    drewThisTurn: false, turnSeq: 0, timer: null, forceAt: 0, finished: [],
    unoVulnAt: 0, unoTimer: null, aiCatchTimer: null,
  };
  room.started = true;
  broadcastLobby();
  pushState(room, `Round started! ${room.players[starter].name} goes first (picked at random).`);
  onTurn(room);
}
function topCard(g) { return g.discard[g.discard.length - 1]; }
// Players who already emptied their hand are skipped in the turn order.
function isOut(g, i) { return !!(g.finished && g.finished.includes(i)); }
function activeCount(room) { const g = room.game; return room.players.length - (g.finished ? g.finished.length : 0); }
function nextIndex(room, steps = 1) {
  const g = room.game, n = room.players.length;
  let i = g.cur;
  for (let s = 0; s < steps; s++) {
    for (let k = 0; k < n; k++) { i = (((i + g.dir) % n) + n) % n; if (!isOut(g, i)) break; }
  }
  return i;
}
function advance(room, steps = 1) {
  const g = room.game;
  g.cur = nextIndex(room, steps);
  g.drewThisTurn = false;
}
function clearTurnTimer(g) { if (g && g.timer) { clearTimeout(g.timer); g.timer = null; } if (g) g.forceAt = 0; }
function drawFor(room, pIndex, k) {
  const g = room.game, p = room.players[pIndex];
  for (let i = 0; i < k; i++) { if (g.deck.length === 0) reshuffle(g); if (g.deck.length === 0) break; p.hand.push(g.deck.shift()); }
  p.saidUno = false;
  if (g.unoVuln === pIndex) clearUnoVuln(g);
}
function reshuffle(g) { const top = g.discard.pop(); g.deck = shuffle(g.discard); g.discard = [top]; }

function clearUnoVuln(g) {
  g.unoVuln = -1; g.unoVulnAt = 0;
  if (g.unoTimer) { clearTimeout(g.unoTimer); g.unoTimer = null; }
  if (g.aiCatchTimer) { clearTimeout(g.aiCatchTimer); g.aiCatchTimer = null; }
}
// The catch window normally closes when the next player acts — but never before
// CATCH_DELAY_MS + CATCH_OPEN_MS, so people get a fair chance to tap "Catch".
function closeUnoWindow(room, actingIndex) {
  const g = room.game;
  if (g.unoVuln === -1 || g.unoVuln === actingIndex) return;
  const closeAt = g.unoVulnAt + CATCH_DELAY_MS + CATCH_OPEN_MS;
  const wait = closeAt - Date.now();
  if (wait <= 0) { clearUnoVuln(g); return; }
  if (!g.unoTimer) {
    const target = g.unoVuln, at = g.unoVulnAt;
    g.unoTimer = setTimeout(() => {
      g.unoTimer = null;
      if (g.unoVuln === target && g.unoVulnAt === at) { clearUnoVuln(g); pushState(room, ""); }
    }, wait);
  }
}
function openUnoVuln(room, pIndex) {
  const g = room.game;
  clearUnoVuln(g);
  g.unoVuln = pIndex; g.unoVulnAt = Date.now();
  const at = g.unoVulnAt;
  // let everyone's screen enable the Catch button once the delay is over
  setTimeout(() => { if (g.unoVuln === pIndex && g.unoVulnAt === at) pushState(room, ""); }, CATCH_DELAY_MS + 30);
  // computer players also catch you, but only after the same delay
  const ai = room.players.findIndex((p, i) => i !== pIndex && p.isAI);
  if (ai >= 0) {
    g.aiCatchTimer = setTimeout(() => {
      g.aiCatchTimer = null;
      if (g.unoVuln === pIndex && g.unoVulnAt === at && !g.over) catchUno(room, ai, pIndex);
    }, CATCH_DELAY_MS + 900 + Math.random() * 1500);
  }
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
    if (!canStack(card, top)) {
      return { ok: false, msg: top.kind === "wild4" ? "Only a +4 can go on a +4 — or draw the cards" : "Only a +2 can go on a +2 — or draw the cards" };
    }
  } else {
    if (!canPlay(card, g.activeColor, top)) return { ok: false, msg: "Illegal move" };
  }

  p.hand.splice(handIndex, 1);
  g.discard.push(card);
  g.activeColor = card.color === "wild" ? (chosenColor || "red") : card.color;
  closeUnoWindow(room, pIndex);

  let msg = `${p.name} played ${describe(card)}`;
  let skip = false, reversed = false;
  if (card.kind === "skip") { skip = true; }
  else if (card.kind === "reverse") { g.dir *= -1; reversed = true; if (activeCount(room) === 2 && p.hand.length > 0) skip = true; }
  else if (card.kind === "draw2") { g.pendingDraw += 2; msg += ` — +${g.pendingDraw} pending`; }
  else if (card.kind === "wild4") {
    g.pendingDraw += 4;
    msg += ` (color ${g.activeColor}) — +${g.pendingDraw} pending`;
  }
  else if (card.kind === "wild") { msg += ` (color ${g.activeColor})`; }

  // Out of cards → this player finishes and the round carries on without them
  let finishedNow = false;
  if (p.hand.length === 0) {
    finishedNow = true;
    if (g.unoVuln === pIndex) clearUnoVuln(g);
    g.finished.push(pIndex);
    const place = g.finished.length;
    msg += ` — and finished ${ordinal(place)}! 🎉`;
    if (activeCount(room) <= 1) {
      pushState(room, msg);
      io.to(room.id).emit("react", { kind: "finish", index: pIndex, name: p.name, text: `finished ${ordinal(place)}! 🎉` });
      endRound(room, room.players.findIndex((_, i) => !isOut(g, i)));
      return { ok: true };
    }
  }

  // UNO state — honor a pre-call made while holding 2 cards
  if (finishedNow) { p.saidUno = false; }
  else if (p.hand.length === 1) {
    if (p.isAI || p.saidUno) { p.saidUno = true; }
    else { openUnoVuln(room, pIndex); p.saidUno = false; msg += ` — UNO?`; }
  } else { p.saidUno = false; }

  const victim = skip ? nextIndex(room, 1) : -1;
  advance(room, skip ? 2 : 1);
  pushState(room, msg);
  if (reversed) io.to(room.id).emit("react", { kind: "reverse", index: pIndex, name: p.name, dir: g.dir, text: "reversed the direction 🔄" });
  if (victim >= 0 && victim !== pIndex) react(room, "skip", victim, 0, { by: p.name });
  if (finishedNow) io.to(room.id).emit("react", { kind: "finish", index: pIndex, name: p.name, text: `finished ${ordinal(g.finished.length)}! 🎉` });
  onTurn(room);
  return { ok: true };
}

function drawTurn(room, pIndex) {
  const g = room.game;
  if (!g || g.over || g.cur !== pIndex) return { ok: false, msg: "Not your turn" };
  closeUnoWindow(room, pIndex);
  if (g.pendingDraw > 0) {
    const n = g.pendingDraw;
    clearTurnTimer(g);
    drawFor(room, pIndex, n);
    g.pendingDraw = 0;
    advance(room, 1);
    pushState(room, `${room.players[pIndex].name} drew ${n} and lost the turn`);
    react(room, "draw", pIndex, n);
    onTurn(room);
    return { ok: true, drewPile: true };
  }
  if (g.drewThisTurn) return { ok: false, msg: "You already drew — play it or pass" };
  drawFor(room, pIndex, 1);
  const p = room.players[pIndex];
  const card = p.hand[p.hand.length - 1];
  if (canPlay(card, g.activeColor, topCard(g))) {
    g.drewThisTurn = true;
    pushState(room, `${p.name} drew a card`);
    return { ok: true, canPlayDrawn: true };
  }
  advance(room, 1); pushState(room, `${p.name} drew and passed`); onTurn(room);
  return { ok: true, canPlayDrawn: false };
}
// You can only pass after drawing a card this turn, and never while a +2/+4 is waiting.
function passTurn(room, pIndex) {
  const g = room.game;
  if (!g || g.over || g.cur !== pIndex) return { ok: false, msg: "Not your turn" };
  if (g.pendingDraw > 0) return { ok: false, msg: `You must draw ${g.pendingDraw} cards (or stack)` };
  if (!g.drewThisTurn) return { ok: false, msg: "Draw a card first" };
  closeUnoWindow(room, pIndex);
  advance(room, 1); pushState(room, `${room.players[pIndex].name} passed`); onTurn(room);
  return { ok: true };
}

function catchUno(room, byIndex, targetIndex) {
  const g = room.game;
  if (!g || g.over) return { ok: false };
  if (g.unoVuln !== targetIndex || targetIndex < 0) return { ok: false, msg: "Nobody to catch" };
  if (Date.now() < g.unoVulnAt + CATCH_DELAY_MS) return { ok: false, msg: "Wait a moment — catch opens 2 seconds after the card is played" };
  const t = room.players[targetIndex];
  if (t.saidUno || t.hand.length !== 1) { clearUnoVuln(g); return { ok: false }; }
  drawFor(room, targetIndex, UNO_PENALTY);
  clearUnoVuln(g);
  pushState(room, `${room.players[byIndex].name} caught ${t.name} — +${UNO_PENALTY} for not saying UNO!`);
  react(room, "caught", targetIndex, UNO_PENALTY, { by: room.players[byIndex].name });
  return { ok: true };
}
function callUno(room, pIndex) {
  const g = room.game; if (!g) return;
  const p = room.players[pIndex];
  if (!p || !p.hand || g.over) return;
  // Allowed when already on 1 card, or on your turn with 2 cards and one of them is playable
  const top = topCard(g);
  const playableNow = g.cur === pIndex && p.hand.length === 2 &&
    p.hand.some(c => g.pendingDraw > 0 ? canStack(c, top) : canPlay(c, g.activeColor, top));
  if (p.hand.length === 1 || playableNow) { p.saidUno = true; if (g.unoVuln === pIndex) clearUnoVuln(g); pushState(room, `${p.name}: UNO!`); }
}

// The round ends when only one player still has cards: they come last.
function endRound(room, loserIndex) {
  const g = room.game;
  clearTurnTimer(g);
  g.over = true; g.pendingDraw = 0; clearUnoVuln(g);
  const loser = room.players[loserIndex];
  g.winner = room.players[g.finished[0]].name;
  room.wcTally = room.wcTally || {};
  const bump = (name, key) => { const t = room.wcTally[name] || (room.wcTally[name] = { wins: 0, lasts: 0 }); t[key]++; };
  bump(g.winner, "wins");
  if (loser) bump(loser.name, "lasts");
  g.scores = {
    order: g.finished.map(i => room.players[i].name),
    loser: loser ? loser.name : "",
    loserCards: loser ? loser.hand.length : 0,
    tally: room.players.map(p => ({ name: p.name, ...(room.wcTally[p.name] || { wins: 0, lasts: 0 }) })),
  };
  pushState(room, loser ? `${g.winner} won! ${loser.name} came last with ${loser.hand.length} cards.` : `${g.winner} won!`);
  if (loser) react(room, "last", loserIndex, loser.hand.length);
}
function ordinal(n) { const s = ["th", "st", "nd", "rd"], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); }

function describe(c) {
  if (c.kind === "num") return `${c.color} ${c.val}`;
  const names = { skip: "Skip", reverse: "Reverse", draw2: "Draw Two", wild: "Wild", wild4: "Wild Draw Four" };
  return c.color === "wild" ? names[c.kind] : `${c.color} ${names[c.kind]}`;
}

/**
 * Runs every time the turn changes. This is what makes +2 / +4 draws mandatory:
 *  - no legal stack card                         -> the cards are drawn automatically
 *  - a legal stack card in hand                       -> STACK_DECIDE_MS to stack, then auto-draw
 */
function onTurn(room) {
  if (room.gameType === "ace") return ace.onTurn(room);
  const g = room.game; if (!g || g.over) return;
  clearTurnTimer(g);
  g.turnSeq++;
  const seq = g.turnSeq, pIndex = g.cur, p = room.players[pIndex];
  if (!p) return;
  const force = (delay) => {
    g.forceAt = Date.now() + delay;
    g.timer = setTimeout(() => {
      g.timer = null;
      if (g.over || g.turnSeq !== seq || g.cur !== pIndex || g.pendingDraw <= 0) return;
      drawTurn(room, pIndex);
    }, delay);
  };
  if (g.pendingDraw > 0) {
    const top = topCard(g);
    const hasStack = p.hand.some(c => canStack(c, top));
    if (!hasStack) { force(FORCED_DRAW_MS); pushState(room, ""); return; }
    if (!p.isAI) { force(STACK_DECIDE_MS); pushState(room, ""); return; }
  }
  if (p.isAI) setTimeout(() => { if (g.turnSeq === seq) aiMove(room); }, 850);
}
function aiMove(room) {
  const g = room.game; if (!g || g.over) return;
  const pIndex = g.cur, p = room.players[pIndex]; if (!p.isAI) return;


  if (g.pendingDraw > 0) {
    const i = p.hand.findIndex(c => canStack(c, topCard(g)));
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
  const now = Date.now();
  const base = {
    roomId: room.id, roomName: room.name, started: room.started, hostId: room.hostId, gameType: room.gameType, hiddenCut: !!room.hiddenCut,
    maxPlayers: room.maxPlayers, me,
    players: room.players.map((p, i) => ({
      index: i, name: p.name, isAI: p.isAI, connected: p.connected,
      count: p.hand ? p.hand.length : 0,
      saidUno: !!p.saidUno,
      vulnerable: g ? (g.unoVuln === i) : false,
      catchIn: g && g.unoVuln === i ? Math.max(0, g.unoVulnAt + CATCH_DELAY_MS - now) : 0,
      // marks other players left on this seat — never shown to the player they're about
      notes: i === me ? [] : (room.notes[p.id] || []).map(n => ({ id: n.id, text: n.text, by: n.byName, mine: n.by === socketId })),
    })),
  };
  if (g && g.type === "ace") {
    base.game = ace.stateFor(room, me);
    base.hand = (me >= 0 && room.players[me].hand) ? room.players[me].hand : [];
    return base;
  }
  if (g) {
    const top = topCard(g);
    base.game = {
      activeColor: g.activeColor, top, cur: g.cur, dir: g.dir,
      over: g.over, winner: g.winner, deckCount: g.deck.length, lastMsg: g.log[g.log.length - 1] || "",
      pendingDraw: g.pendingDraw,
      finished: g.finished.slice(),
      drew: g.drewThisTurn,
      forceIn: g.forceAt ? Math.max(0, g.forceAt - Date.now()) : 0,
      log: g.log.slice(-4),
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

ace = createAce({ io, pushState, shuffle });
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

  socket.on("createRoom", ({ name, roomName, maxPlayers, aiSeats, gameType, hiddenCut }, cb) => {
    const room = createRoom(name || "Player", { name: roomName, maxPlayers, gameType, hiddenCut });
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
    room.players.push({ id: "AI_" + genId(), name: "CPU " + room.players.length, hand: [], isAI: true, connected: true, saidUno: false });
    broadcastLobby();
    pushState(room, "");
  });

  socket.on("play", ({ handIndex, color }) => {
    const room = rooms.get(socket.data.roomId); if (!room) return;
    const r = room.gameType === "ace"
      ? ace.play(room, idxOf(room, socket.id), handIndex)
      : playCard(room, idxOf(room, socket.id), handIndex, color);
    if (!r.ok && r.msg) socket.emit("err", r.msg);
  });
  socket.on("draw", () => {
    const room = rooms.get(socket.data.roomId); if (!room || room.gameType === "ace") return;
    const r = drawTurn(room, idxOf(room, socket.id));
    if (!r.ok && r.msg) socket.emit("err", r.msg);
    if (r.ok && r.canPlayDrawn) socket.emit("drewPlayable");
  });
  socket.on("pass", () => {
    const room = rooms.get(socket.data.roomId); if (!room || room.gameType === "ace") return;
    const r = passTurn(room, idxOf(room, socket.id));
    if (!r.ok && r.msg) socket.emit("err", r.msg);
  });
  socket.on("callUno", () => {
    const room = rooms.get(socket.data.roomId); if (!room || room.gameType === "ace") return;
    callUno(room, idxOf(room, socket.id));
  });
  socket.on("catchUno", ({ target }) => {
    const room = rooms.get(socket.data.roomId); if (!room || room.gameType === "ace") return;
    catchUno(room, idxOf(room, socket.id), typeof target === "number" ? target : -1);
  });

  // ---- player marks ("no red", "holding +4?") ----
  socket.on("note", ({ target, text }) => {
    const room = rooms.get(socket.data.roomId); if (!room || !room.started) return;
    const by = idxOf(room, socket.id), t = room.players[target];
    if (by < 0 || !t || target === by) return;
    const clean = String(text || "").replace(/\s+/g, " ").trim().slice(0, NOTE_MAX_LEN); if (!clean) return;
    const now = Date.now();
    if (socket.data.lastNote && now - socket.data.lastNote < 1500) { socket.emit("err", "Slow down a little"); return; }
    socket.data.lastNote = now;
    const list = room.notes[t.id] || (room.notes[t.id] = []);
    list.push({ id: genId(), by: socket.id, byName: room.players[by].name, text: clean, ts: now });
    while (list.length > NOTES_PER_PLAYER) list.shift();
    // alert everyone except the player being marked
    for (const p of room.players) {
      if (p.isAI || !p.connected || p.id === t.id) continue;
      io.to(p.id).emit("noteAlert", { by: room.players[by].name, target: t.name, targetIndex: target, text: clean, mine: p.id === socket.id });
    }
    pushState(room, "");
  });
  socket.on("noteRemove", ({ target, id }) => {
    const room = rooms.get(socket.data.roomId); if (!room) return;
    const t = room.players[target]; if (!t) return;
    const list = room.notes[t.id] || [];
    const i = list.findIndex(n => n.id === id && (n.by === socket.id || room.hostId === socket.id));
    if (i >= 0) { list.splice(i, 1); pushState(room, ""); }
  });

  // ---- host removes a player ----
  socket.on("kick", ({ target }) => {
    const room = rooms.get(socket.data.roomId);
    if (!room || room.hostId !== socket.id) return;
    const t = room.players[target];
    if (!t || t.id === socket.id) return;
    const inRound = room.started && room.game && !room.game.over;
    if (t.isAI) {
      if (inRound) { socket.emit("err", "Computer players can be removed between rounds"); return; }
      room.players.splice(target, 1);
      pushState(room, `${t.name} was removed`); broadcastLobby(); return;
    }
    const ts = io.sockets.sockets.get(t.id);
    if (ts) { ts.emit("kicked", { by: nameFor(room, socket.id) }); }
    removeSocketFromRoom(ts, room, t.id, "removed");
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
  if (!room) { socket.data.roomId = null; return; }
  removeSocketFromRoom(socket, room, socket.id, "left");
}
// Used for leaving, disconnecting and being removed by the host.
// Mid-round the seat is handed to a computer player so the game can carry on.
function removeSocketFromRoom(socket, room, sid, why) {
  if (socket) {
    socket.data.roomId = null;
    socket.leave(room.id);
    socket.join("lobby");
    socket.emit("lobby", publicRoomList());
  }
  leaveVoice(room, sid);
  const idx = room.players.findIndex(p => p.id === sid);
  if (idx < 0) return;
  const p = room.players[idx];
  if (room.hostId === sid) { const nh = room.players.find(x => !x.isAI && x.connected && x.id !== sid); room.hostId = nh ? nh.id : null; }
  if (room.started && room.game && !room.game.over) {
    p.connected = false;
    p.isAI = true;
    p.id = "AI_" + genId();   // the old socket no longer controls this seat
    p.name += why === "removed" ? " (removed)" : " (left)";
    pushState(room, `${p.name.replace(/ \((left|removed)\)$/, "")} ${why === "removed" ? "was removed by the host" : "left the game"}`);
    if (room.game.cur === idx) onTurn(room);
  } else {
    room.players.splice(idx, 1);
    pushState(room, why === "removed" ? `${p.name} was removed by the host` : `${p.name} left`);
  }
  if (room.players.filter(p => !p.isAI).length === 0) {
    if (room.game) { clearTurnTimer(room.game); clearUnoVuln(room.game); ace.stop(room.game); room.game.over = true; }
    rooms.delete(room.id);
  }
  broadcastLobby();
}

server.listen(PORT, () => { console.log(`Wildcard server running:  http://localhost:${PORT}`); });
