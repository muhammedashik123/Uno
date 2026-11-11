# Wildcard — online multiplayer

Wildcard is a colorful UNO-style card game. One player creates a room and gets a 5-letter code;
others see open rooms in the lobby (or paste the code) and join. It's built for phones, has a
playful animated look, sound effects, **live text chat**, and **voice chat** (mic on/off).
Empty seats can be filled with AI so you can start even on your own.

The server is authoritative — it holds the deck and every hand, so clients can't cheat.

## What's here

```
uno-multiplayer/
├─ server.js          # game engine + lobby + chat + voice signaling (Node + Socket.io)
├─ package.json
├─ render.yaml        # one-click config for deploying on Render
├─ .gitignore
└─ public/
   ├─ index.html      # the game client (lobby, table, chat, voice)
   ├─ manifest.json   # PWA / Add-to-Home-Screen
   └─ logo.svg        # placeholder logo (swap with your own — see below)
```

The single-file offline-vs-AI game lives one level up at `../uno-solo.html` (just open it; no server).

## Run locally

Requires Node.js 18+.

```bash
cd uno-multiplayer
npm install
npm start
```

Open **http://localhost:3000**. (Voice chat needs a secure context: it works on `localhost`
and on a deployed `https://` URL, but not over a raw `http://192.168.x.x` LAN address.)

## Deploy a public link (Render)

1. Push this `uno-multiplayer` folder to a GitHub repo (so `package.json` is at the repo root).
2. On dashboard.render.com → **New → Web Service** → pick the repo.
   Build Command `npm install`, Start Command `npm start`, Instance Type **Free**.
   (Or use **New → Blueprint** and it reads `render.yaml` automatically.)
3. Open the resulting `https://<name>.onrender.com` URL on any phone.

Free tier sleeps after ~15 min idle (first visit then takes ~30–60s to wake). Every push to
your branch auto-redeploys.

## Playing

1. Enter a name. Create a room (any size from 2 to 20 players, plus optional computer players) or join an open one / paste a code.
   Bigger rooms automatically shuffle in extra decks (1 deck up to 8 players, 2 decks up to 23) so draws never run out.
2. Host taps **Start game** once at least 2 players are in.
3. On your turn, tap a glowing card or **Draw a card** (after drawing a playable card you can play it or **Pass**). Wild cards ask for a color. First to
   empty their hand wins (with confetti 🎉).

**Chat:** tap the 💬 button (bottom-right) to open the room chat. Unread messages show a badge.
**Voice:** tap 🎤 to join voice (asks mic permission). Tap again to mute / unmute. A 🎙 shows
next to players who are in voice. Voice uses WebRTC peer-to-peer with Google's public STUN
servers — fine for most networks; very restrictive/corporate networks may need a TURN server
(not included, since TURN hosting costs money).

## Swapping in your own logo

The product is named **Wildcard** (it appears in the header, page titles, `manifest.json`, the
lobby logo, and the card backs as an "A"). `public/logo.svg` is a vector recreation of your
Wildcard logo, shown on the lobby and used as the app icon.

To use your exact original artwork instead of the vector recreation:
- Save your PNG at `public/logo.png` (ideally 512×512, plus a 180×180 works for iOS).
- In `public/index.html`, change the lobby `<img src="/logo.svg">` to `/logo.png`, and change
  the `apple-touch-icon` link's `href` to `/logo.png`.
- For the crispest iOS Home-Screen icon, in `public/index.html` change the `apple-touch-icon`
  link's `href` to `/logo.png`.
- To rename the product, search `index.html` / `../uno-solo.html` for "Wildcard" and replace.

## Rules implemented

Number + color matching, Skip, Reverse, Draw Two, Wild, Wild Draw Four, deck reshuffle when
empty, 2-player reverse acts as a skip, and disconnect-to-AI takeover so a game can continue.

Advanced rules (all on):

- **Random first player:** a random player starts each round.
- **Play until the last player:** when someone empties their hand they finish (1st, 2nd, …) and the round
  carries on without them. It ends when only one player still has cards — they come last.
- **Stacking (+2 / +4):** a draw card passes to the next player, who may stack. You can only stack
  like on like: a **+2 only on a +2**, a **+4 only on a +4**. The "+N" counter grows until someone
  can't or won't stack.
- **Draws are mandatory:** the player under a +N stack cannot pass or play anything else. If they have no
  card that can stack, the cards are drawn for them automatically. If they could stack, they get 20
  seconds to decide, then the draw happens automatically. Passing is only allowed after drawing a card.
- **2-card warning:** when any player gets down to 2 cards, everyone else sees an alert and that
  player's seat glows amber, so nobody misses a forgotten UNO call.
- **Player notes:** tap any opponent to mark them ("No red", "Might have +4", or your own text). Everyone
  except that player sees the note on their seat and gets an alert.
- **Host tools:** the room creator gets a 👥 **Players** button in the top bar listing everyone, each with
  a **Remove** button (also: ✕ in the waiting room, or tap a seat → Remove).
  Mid-round a computer player takes over the removed player's cards. Anyone can leave with the 🚪 button.
- **Reactions:** everyone sees a pop-up (😢 😭 🤦) when someone is skipped, takes a +2/+4, or gets caught
  without UNO. The direction arrows flip when a Reverse is played.
- **UNO call + catch (draw 4):** the Catch button only unlocks 2 seconds after the card is played, and
  stays open at least 3 seconds after that. when you're down to your last card you must call UNO (tap the
  red **UNO!** button — you can pre-call at 2 cards on your turn). If you don't, opponents can
  tap **Catch!** before the next play and you draw 4. AI players always call, and will catch you.
- **Round scoring:** when someone goes out, the end screen tallies points from everyone else's
  leftover cards (number = face value, action = 20, wild = 50). The host can start the next
  round; there's no running match total (points are shown per round).

Not included (easy to add later): the 7-0 rule, jump-in, and a cumulative match target (e.g.
first to 500).

## Ace ♠ (Kerala Kazhutha)

Pick **Ace** when you create a room (2–12 players). The rules live in `ace.js`.

- All 52 cards are dealt. Whoever holds the **A♠** leads it to start.
- Everyone must **follow the suit** that was led. Ace is high (A K Q J 10 … 2).
- If everyone follows suit, the cards are thrown away and the player with the highest card leads next.
- If you can't follow suit, you **cut** with any card. The trick stops there, and whoever played the
  highest card of the led suit **picks up the whole trick** and leads next.
- **Cut face up or face down:** the host picks this when creating the room. Face down hides the cut card
  from everyone except the cutter (the player who picks up sees it once it's in their hand).
- Empty your hand to **escape**. The last player still holding cards is the **Kazhutha** 🐴.
- The end screen shows the escape order and how many times each player has been the Kazhutha in this room.

