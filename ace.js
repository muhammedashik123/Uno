/**
 * ACE (Kazhutha) — the Kerala trick game.
 *
 *  - All 52 cards are dealt. The player holding the A♠ leads it to start.
 *  - Everyone must follow the suit that was led. Ace is high (A K Q J 10 … 2).
 *  - If everyone follows suit, the trick is thrown away and the highest card leads next.
 *  - If someone can't follow, they "cut" with any card. The trick stops right there and
 *    whoever played the highest card of the led suit picks up every card in it, then leads.
 *  - Empty your hand and you escape. The last player still holding cards is the Kazhutha (donkey).
 */
const SUITS = ["S", "H", "C", "D"];
const SUIT_SYM = { S: "♠", H: "♥", D: "♦", C: "♣" };
const RANK_NAME = { 11: "J", 12: "Q", 13: "K", 14: "A" };
const MAX_PLAYERS = 12;
const AI_DELAY_MS = 900;
const TRICK_SHOW_MS = 1700;   // how long a finished trick stays on the table

function rankName(r) { return RANK_NAME[r] || String(r); }
function cardName(c) { return rankName(c.r) + SUIT_SYM[c.s]; }
function isAceOfSpades(c) { return c.s === "S" && c.r === 14; }

module.exports = function createAce({ io, pushState, shuffle }) {

  function buildDeck() {
    const d = [];
    for (const s of SUITS) for (let r = 2; r <= 14; r++) d.push({ s, r });
    return shuffle(d);
  }
  const alive = (room, i) => room.players[i] && room.players[i].hand.length > 0;

  function emit(room, kind, index, text) {
    const p = room.players[index]; if (!p) return;
    io.to(room.id).emit("react", { kind, index, name: p.name, text });
  }

  // Seats that take part in a trick: everyone with cards, clockwise from the leader.
  function trickOrder(room, leader) {
    const n = room.players.length, order = [];
    for (let k = 0; k < n; k++) { const i = (leader + k) % n; if (alive(room, i)) order.push(i); }
    return order;
  }
  function beginTrick(room, leader) {
    const g = room.game;
    g.trick = []; g.ledSuit = null; g.result = null;
    g.order = trickOrder(room, leader);
    g.cur = g.order[0];
  }

  function start(room) {
    const deck = buildDeck();
    const n = room.players.length;
    for (const p of room.players) { p.hand = []; p.saidUno = false; }
    deck.forEach((c, i) => room.players[i % n].hand.push(c));
    const starter = room.players.findIndex(p => p.hand.some(isAceOfSpades));
    room.game = {
      type: "ace", cur: starter, dir: 1, over: false, log: [],
      trick: [], ledSuit: null, order: [], result: null, firstTrick: true,
      thrown: 0, escaped: [], loser: -1, turnSeq: 0, timer: null, timer2: null, tookSeq: -1,
    };
    room.aceTally = room.aceTally || {};
    room.started = true;
    beginTrick(room, starter);
    pushState(room, `New game of Ace! ${room.players[starter].name} has the A♠ and starts.`);
    onTurn(room);
  }

  function play(room, pIndex, handIndex) {
    const g = room.game;
    if (!g || g.type !== "ace" || g.over) return { ok: false };
    if (g.result) return { ok: false, msg: "Wait — the trick is being cleared" };
    if (g.cur !== pIndex) return { ok: false, msg: "Not your turn" };
    const p = room.players[pIndex];
    const card = p.hand[handIndex];
    if (!card) return { ok: false, msg: "Card not found" };

    if (g.trick.length === 0) {
      if (g.firstTrick && !isAceOfSpades(card)) return { ok: false, msg: "The first card must be the A♠" };
    } else if (card.s !== g.ledSuit && p.hand.some(c => c.s === g.ledSuit)) {
      return { ok: false, msg: `You must follow suit — play a ${SUIT_SYM[g.ledSuit]}` };
    }

    p.hand.splice(handIndex, 1);
    g.trick.push({ p: pIndex, card });
    if (g.trick.length === 1) {
      g.ledSuit = card.s;
      pushState(room, `${p.name} led ${cardName(card)}`);
    }

    // Couldn't follow suit → cut
    if (g.trick.length > 1 && card.s !== g.ledSuit) {
      const picker = highestOfLed(g);
      g.result = { kind: "cut", by: pIndex, picker, count: g.trick.length };
      // With "face down" cuts the card is never named in the log or pop-up
      const how = room.hiddenCut ? "cut face down" : `cut with ${cardName(card)}`;
      pushState(room, `${p.name} ${how}! ${room.players[picker].name} picks up ${g.trick.length} cards`);
      emit(room, "cut", pIndex, `${how} ✂️`);
      emit(room, "pickup", picker, `picked up ${g.trick.length} cards 😭`);
      return finishLater(room), { ok: true };
    }
    if (g.trick.length > 1) pushState(room, `${p.name} played ${cardName(card)}`);

    if (g.trick.length === g.order.length) {
      const top = highestOfLed(g);
      g.result = { kind: "clear", picker: top, count: g.trick.length };
      pushState(room, `Everyone followed — trick thrown away. ${room.players[top].name} leads next`);
      return finishLater(room), { ok: true };
    }
    g.cur = g.order[g.trick.length];
    pushState(room, "");
    onTurn(room);
    return { ok: true };
  }

  // Optional house rule: on your turn you may take random, face-down cards from the next player.
  function nextAlive(room, from) {
    const n = room.players.length;
    for (let k = 1; k < n; k++) { const i = (from + k) % n; if (alive(room, i)) return i; }
    return -1;
  }
  function take(room, pIndex, count) {
    const g = room.game;
    if (!g || g.type !== "ace" || g.over) return { ok: false };
    if (!room.allowTake) return { ok: false, msg: "Taking cards is off in this room" };
    if (g.result) return { ok: false, msg: "Wait — the trick is being cleared" };
    if (g.cur !== pIndex) return { ok: false, msg: "Not your turn" };
    if (g.tookSeq === g.turnSeq) return { ok: false, msg: "You already took cards this turn" };
    const t = nextAlive(room, pIndex);
    if (t < 0) return { ok: false, msg: "Nobody to take from" };
    const victim = room.players[t];
    const n = Math.max(1, Math.min(parseInt(count, 10) || 1, victim.hand.length));
    const taken = [];
    for (let k = 0; k < n; k++) taken.push(victim.hand.splice(Math.floor(Math.random() * victim.hand.length), 1)[0]);
    room.players[pIndex].hand.push(...taken);
    g.tookSeq = g.turnSeq;
    pushState(room, `${room.players[pIndex].name} took ${n} card${n === 1 ? "" : "s"} from ${victim.name} 🤫`);
    emit(room, "take", pIndex, `took ${n} card${n === 1 ? "" : "s"} from ${victim.name} 🤫`);
    if (victim.hand.length === 0) {
      g.order = g.order.filter(i => i !== t);          // they were still due to play this trick
      g.escaped.push(t);
      const place = g.escaped.length;
      pushState(room, `${victim.name} escaped ${ordinal(place)}! 🏃`);
      emit(room, "escape", t, `escaped ${ordinal(place)}! 🎉`);
      const left = room.players.map((_, i) => i).filter(i => alive(room, i));
      if (left.length <= 1) end(room, left.length ? left[0] : -1);
    }
    return { ok: true };
  }

  function highestOfLed(g) {
    let best = null;
    for (const t of g.trick) if (t.card.s === g.ledSuit && (!best || t.card.r > best.card.r)) best = t;
    return best.p;
  }

  // Leave the finished trick on the table for a moment so everyone can see it.
  function finishLater(room) {
    const g = room.game;
    g.cur = -1;
    clearTimeout(g.timer2);
    g.timer2 = setTimeout(() => resolve(room), TRICK_SHOW_MS);
  }

  function resolve(room) {
    const g = room.game;
    if (!g || g.over || !g.result) return;
    const { kind, picker } = g.result;
    if (kind === "cut") room.players[picker].hand.push(...g.trick.map(t => t.card));
    else g.thrown += g.trick.length;
    const inTrick = g.order.slice();
    g.trick = []; g.ledSuit = null; g.result = null; g.firstTrick = false;

    for (const i of inTrick) {
      if (!alive(room, i) && !g.escaped.includes(i)) {
        g.escaped.push(i);
        const place = g.escaped.length;
        pushState(room, `${room.players[i].name} escaped ${ordinal(place)}! 🏃`);
        emit(room, "escape", i, `escaped ${ordinal(place)}! 🎉`);
      }
    }
    const left = room.players.map((_, i) => i).filter(i => alive(room, i));
    if (left.length <= 1) return end(room, left.length ? left[0] : -1);

    let leader = picker;
    if (!alive(room, leader)) {               // the high card's owner just escaped → next player leads
      const n = room.players.length;
      for (let k = 1; k <= n; k++) { const i = (picker + k) % n; if (alive(room, i)) { leader = i; break; } }
    }
    beginTrick(room, leader);
    pushState(room, "");
    onTurn(room);
  }

  function end(room, loser) {
    const g = room.game;
    stop(g);
    g.over = true; g.loser = loser; g.cur = -1;
    if (loser >= 0) { const nm = room.players[loser].name; room.aceTally[nm] = (room.aceTally[nm] || 0) + 1; }
    g.scores = {
      escaped: g.escaped.map(i => room.players[i].name),
      tally: room.players.map(p => ({ name: p.name, losses: room.aceTally[p.name] || 0 })),
    };
    if (loser >= 0) {
      const name = room.players[loser].name;
      pushState(room, `${name} is the Kazhutha! 🐴`);
      emit(room, "kazhutha", loser, "is the Kazhutha! 🐴");
    } else {
      pushState(room, "Everyone escaped together — no Kazhutha this time!");
    }
  }

  function stop(g) { if (!g) return; clearTimeout(g.timer); clearTimeout(g.timer2); g.timer = g.timer2 = null; }

  function onTurn(room) {
    const g = room.game; if (!g || g.over || g.result || g.cur < 0) return;
    clearTimeout(g.timer);
    g.turnSeq++;
    const seq = g.turnSeq, p = room.players[g.cur];
    if (p && p.isAI) g.timer = setTimeout(() => { if (g.turnSeq === seq && !g.over) aiMove(room); }, AI_DELAY_MS);
  }

  // Simple computer player: avoid being the highest card when someone might cut,
  // and dump high cards when it's safe or when cutting.
  function aiMove(room) {
    const g = room.game, me = g.cur, hand = room.players[me].hand;
    const pick = (c) => play(room, me, hand.indexOf(c));
    if (g.trick.length === 0) {
      if (g.firstTrick) return pick(hand.find(isAceOfSpades));
      const bySuit = {}; hand.forEach(c => (bySuit[c.s] = bySuit[c.s] || []).push(c));
      const longest = Object.values(bySuit).sort((a, b) => b.length - a.length)[0];
      return pick(longest.reduce((a, b) => (b.r < a.r ? b : a)));
    }
    const follow = hand.filter(c => c.s === g.ledSuit).sort((a, b) => a.r - b.r);
    if (!follow.length) return pick(hand.reduce((a, b) => (b.r > a.r ? b : a)));   // cut with the highest card
    const lastToPlay = g.trick.length === g.order.length - 1;
    if (lastToPlay) return pick(follow[follow.length - 1]);                      // nobody can cut after me
    const high = Math.max(...g.trick.filter(t => t.card.s === g.ledSuit).map(t => t.card.r));
    const under = follow.filter(c => c.r < high);
    return pick(under.length ? under[under.length - 1] : follow[follow.length - 1]);
  }

  function stateFor(room, me) {
    const g = room.game;
    return {
      type: "ace", cur: g.cur, dir: 1, over: g.over,
      // a face-down cut card is hidden from everyone except the player who cut
      trick: g.trick.map((t, k) => {
        const isCut = k > 0 && t.card.s !== g.ledSuit;
        return room.hiddenCut && isCut && t.p !== me ? { p: t.p, hidden: true } : { p: t.p, card: t.card };
      }),
      hiddenCut: !!room.hiddenCut,
      allowTake: !!room.allowTake,
      canTake: !!room.allowTake && !g.over && !g.result && g.cur === me && g.tookSeq !== g.turnSeq && nextAlive(room, me) >= 0,
      takeFrom: nextAlive(room, me),
      ledSuit: g.ledSuit, firstTrick: g.firstTrick, result: g.result,
      thrown: g.thrown, escaped: g.escaped.slice(), loser: g.loser,
      winner: g.loser >= 0 ? room.players[g.loser].name : "",
      log: g.log.slice(-4), scores: g.scores || null,
    };
  }

  return { start, play, take, onTurn, stop, stateFor, MAX_PLAYERS };
};

function ordinal(n) { const s = ["th", "st", "nd", "rd"], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); }
