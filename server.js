// Bluff / Lügen - Online-Server
// Einfacher, selbst-gehosteter Mehrspieler-Server auf Basis von Express + Socket.IO.
// Kann lokal, im Heimnetz oder z.B. auf einem Raspberry Pi laufen.
// Regelwerk: siehe README.md ("Lügen" - hausinterne Regeln, digital umgesetzt).

const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));

// ---------------------------------------------------------------------------
// Spielregeln / Konstanten
// ---------------------------------------------------------------------------

const MIN_PLAYERS = 2;
const MAX_PLAYERS = 8;
const MAX_ROOMS = 500; // Sicherheitsventil gegen Speicher-Erschöpfung durch Missbrauch
const ROOM_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // ohne verwechselbare Zeichen

const SUITS = ['pik', 'herz', 'karo', 'kreuz'];
const SUIT_INFO = {
  pik: { symbol: '♠', color: 'black' },
  kreuz: { symbol: '♣', color: 'black' },
  herz: { symbol: '♥', color: 'red' },
  karo: { symbol: '♦', color: 'red' },
};

// "32 Karten" = klassisches Skatblatt (7 bis Ass), "52 Karten" = voller Satz (2 bis Ass).
// Das entspricht der Regel 1.4 ("Je nach Spielerzahl und eigenem Ermessen wird die
// Anzahl an Karten ... im Deck gesetzt") - online per Lobby-Einstellung statt per
// Hand voller aufgedeckter Kartenstapel.
const RANKS_32 = ['7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
const RANKS_52 = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
const RANK_LABELS = { J: 'Bube', Q: 'Dame', K: 'König', A: 'Ass' };

function ranksFor(deckRange) {
  return deckRange === '32' ? RANKS_32 : RANKS_52;
}

// Buben sind laut Regel 2.9 Joker (zählen als jede Karte), dürfen aber nie selbst
// als Kartensorte angesagt werden ("Nicht gestattet: Ich lege einen Buben").
function claimableRanksFor(deckRange) {
  return ranksFor(deckRange).filter((r) => r !== 'J');
}

function rankLabel(rank) {
  return RANK_LABELS[rank] || rank;
}

const DEFAULT_SETTINGS = { deckRange: '52', deckCount: 1, jackCount: 4 };

function maxJackCount(deckCount) {
  return 4 * deckCount;
}

function clampSettings(settings) {
  const s = Object.assign({}, DEFAULT_SETTINGS, settings || {});
  s.deckRange = s.deckRange === '32' ? '32' : '52';
  s.deckCount = [1, 2].includes(Number(s.deckCount)) ? Number(s.deckCount) : 1;
  const maxJacks = maxJackCount(s.deckCount);
  s.jackCount = Math.max(0, Math.min(maxJacks, Number.isFinite(Number(s.jackCount)) ? Math.round(Number(s.jackCount)) : maxJacks));
  return s;
}

// Baut das komplette Spieldeck nach den Lobby-Einstellungen. Buben werden zuerst
// regulär eingefügt und danach - falls die Einstellung weniger Buben vorsieht -
// wieder auf die gewünschte Anzahl gekürzt (Regel 1.4.1/1.4.2: Buben werden
// einzeln, nicht stapelweise, ins Deck aufgenommen).
function buildDeck(settings) {
  const s = clampSettings(settings);
  const ranks = ranksFor(s.deckRange);
  const deck = [];
  for (let d = 0; d < s.deckCount; d++) {
    SUITS.forEach((suit) => {
      ranks.forEach((rank) => {
        deck.push({ id: `${d}-${suit}-${rank}`, suit, rank });
      });
    });
  }
  const jacks = deck.filter((c) => c.rank === 'J');
  const nonJacks = deck.filter((c) => c.rank !== 'J');
  const keptJacks = jacks.slice(0, s.jackCount);
  return nonJacks.concat(keptJacks);
}

function deckComposition(settings) {
  const s = clampSettings(settings);
  const ranks = ranksFor(s.deckRange);
  const comp = {};
  ranks.forEach((r) => { comp[r] = r === 'J' ? s.jackCount : 4 * s.deckCount; });
  return comp;
}

const BOT_NAME_POOL = [
  'Bot Lügenbaron', 'Bot Pokerface', 'Bot Schlitzohr', 'Bot Trickser',
  'Bot Mogelmax', 'Bot Blender', 'Bot Falschspieler', 'Bot Hochstapler',
];

function makeRoomCode() {
  let code;
  do {
    code = '';
    for (let i = 0; i < 4; i++) {
      code += ROOM_CODE_CHARS[Math.floor(Math.random() * ROOM_CODE_CHARS.length)];
    }
  } while (rooms.has(code));
  return code;
}

function makeId() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ---------------------------------------------------------------------------
// Einfaches Rate-Limiting (Schutz vor Missbrauch, da öffentlich erreichbar)
// ---------------------------------------------------------------------------

function getClientIp(socket) {
  const forwarded = socket.handshake.headers['x-forwarded-for'];
  if (forwarded) return forwarded.split(',')[0].trim();
  return socket.handshake.address || 'unknown';
}

const rateLimitHits = new Map();

function isRateLimited(key, limit, windowMs) {
  const now = Date.now();
  const hits = (rateLimitHits.get(key) || []).filter((t) => now - t < windowMs);
  if (hits.length >= limit) {
    rateLimitHits.set(key, hits);
    return true;
  }
  hits.push(now);
  rateLimitHits.set(key, hits);
  return false;
}

setInterval(() => {
  const now = Date.now();
  for (const [key, hits] of rateLimitHits) {
    const fresh = hits.filter((t) => now - t < 10 * 60 * 1000);
    if (fresh.length) rateLimitHits.set(key, fresh);
    else rateLimitHits.delete(key);
  }
}, 10 * 60 * 1000).unref();

// ---------------------------------------------------------------------------
// Raumverwaltung
// ---------------------------------------------------------------------------

const rooms = new Map(); // code -> room
const ROOM_CLEANUP_MS = 3 * 60 * 60 * 1000;

function createRoom() {
  const code = makeRoomCode();
  const room = {
    code,
    hostId: null,
    players: [], // { id, token, name, socketId, connected, isBot } - Reihenfolge = Sitz-/Zugreihenfolge
    phase: 'lobby', // lobby | playing | reveal | roundend
    settings: Object.assign({}, DEFAULT_SETTINGS),
    hands: {}, // playerId -> [card,...]
    pile: [], // [{ playerId, cards: [card,...], claimedCount }]
    requiredRank: null,
    currentTurnIndex: 0,
    finishedOrder: [], // playerIds, in Reihenfolge des Fertigwerdens (letzter = Verlierer der Runde)
    roundNumber: 0,
    starterPlayerId: null, // wer diese/die nächste Runde eröffnet
    diceRoll: null, // transient: { rolls: {playerId: value}, starterId }
    lastReveal: null, // transient: Ergebnis des letzten Bluff-Rufs
    revealTimer: null,
    history: [], // [{ round, order: [playerId,...], starterId }]
    logs: [],
    lastActivity: Date.now(),
    cleanupTimer: null,
  };
  rooms.set(code, room);
  touchRoom(room);
  return room;
}

function touchRoom(room) {
  room.lastActivity = Date.now();
  if (room.cleanupTimer) clearTimeout(room.cleanupTimer);
  room.cleanupTimer = setTimeout(() => { rooms.delete(room.code); }, ROOM_CLEANUP_MS);
}

function log(room, text) {
  room.logs.push({ text, at: Date.now() });
  if (room.logs.length > 200) room.logs.shift();
}

function findPlayer(room, playerId) {
  return room.players.find((p) => p.id === playerId);
}

function findPlayerIndex(room, playerId) {
  return room.players.findIndex((p) => p.id === playerId);
}

function publicPlayer(room, p) {
  return {
    id: p.id,
    name: p.name,
    connected: p.connected,
    isHost: p.id === room.hostId,
    isBot: p.isBot === true,
    handCount: room.hands[p.id] ? room.hands[p.id].length : 0,
    finished: room.finishedOrder.includes(p.id),
    place: room.finishedOrder.includes(p.id) ? room.finishedOrder.indexOf(p.id) + 1 : null,
  };
}

function currentActor(room) {
  if (room.phase !== 'playing' || !room.players.length) return null;
  return room.players[room.currentTurnIndex % room.players.length];
}

// ---------------------------------------------------------------------------
// Kern-Spiellogik (als reine Funktionen, damit sie isoliert testbar sind)
// ---------------------------------------------------------------------------

// Nächster Spieler mit Karten auf der Hand (überspringt bereits fertige Spieler),
// ausgehend von fromIndex (exklusiv), im Uhrzeigersinn (aufsteigender Index).
function nextActiveIndex(players, hands, fromIndex) {
  const n = players.length;
  if (!n) return -1;
  for (let step = 1; step <= n; step++) {
    const idx = (fromIndex + step) % n;
    const hand = hands[players[idx].id] || [];
    if (hand.length > 0) return idx;
  }
  return -1; // niemand mehr mit Karten
}

function activeCount(players, hands) {
  return players.filter((p) => (hands[p.id] || []).length > 0).length;
}

// Deckt auf, ob ein bestimmter Zug (Kartenstapel) gelogen war: wahr ist er nur,
// wenn ALLE gelegten Karten entweder die angesagte Sorte sind oder ein Bube
// (Joker, zählt als jede Karte - Regel 2.9).
function wasTruthful(cards, requiredRank) {
  return cards.every((c) => c.rank === requiredRank || c.rank === 'J');
}

// Regel 2.8: Hat ein Spieler 4 Karten derselben Sorte auf der Hand, müssen diese
// weggelegt werden - automatisch, ohne Wahlmöglichkeit. Wird wiederholt
// angewendet (falls durch mehrere kombinierte Decks z.B. 8 gleiche möglich sind).
function extractFourOfAKind(hand) {
  let remaining = hand.slice();
  const discarded = [];
  let changed = true;
  while (changed) {
    changed = false;
    const counts = {};
    remaining.forEach((c) => { counts[c.rank] = (counts[c.rank] || 0) + 1; });
    for (const rank of Object.keys(counts)) {
      if (counts[rank] >= 4) {
        const toDiscard = remaining.filter((c) => c.rank === rank).slice(0, 4);
        const discardIds = new Set(toDiscard.map((c) => c.id));
        remaining = remaining.filter((c) => !discardIds.has(c.id));
        discarded.push(...toDiscard);
        changed = true;
        break;
      }
    }
  }
  return { hand: remaining, discarded };
}

// Verteilt das gemischte Deck reihum, so gleichmäßig wie möglich (Regel 1.1).
function dealCards(players, deck) {
  const hands = {};
  players.forEach((p) => { hands[p.id] = []; });
  let i = 0;
  deck.forEach((card) => {
    hands[players[i % players.length].id].push(card);
    i++;
  });
  return hands;
}

// ---------------------------------------------------------------------------
// Öffentlicher Zustand
// ---------------------------------------------------------------------------

function publicState(room, viewerId) {
  const actor = currentActor(room);
  return {
    code: room.code,
    phase: room.phase,
    players: room.players.map((p) => publicPlayer(room, p)),
    hostId: room.hostId,
    minPlayers: MIN_PLAYERS,
    maxPlayers: MAX_PLAYERS,
    settings: room.settings,
    maxJackCount: maxJackCount(room.settings.deckCount),
    claimableRanks: claimableRanksFor(room.settings.deckRange),
    deckComposition: deckComposition(room.settings),
    deckSize: buildDeck(room.settings).length,
    roundNumber: room.roundNumber,
    starterPlayerId: room.starterPlayerId,
    diceRoll: room.diceRoll,
    requiredRank: room.requiredRank,
    pile: room.pile.map((play) => ({ playerId: play.playerId, claimedCount: play.claimedCount })),
    pileTotalCount: room.pile.reduce((sum, play) => sum + play.claimedCount, 0),
    currentTurnId: actor ? actor.id : null,
    isPileEmpty: room.pile.length === 0,
    finishedOrder: room.finishedOrder,
    lastReveal: maskRevealFor(room.lastReveal, viewerId),
    history: room.history,
    logs: room.logs.slice(-40),
  };
}

// Nur wer "Bluff!" gerufen hat, bekommt die tatsächlich aufgedeckten Karten zu
// sehen. Alle anderen (inkl. der/dem Beschuldigten) sehen nur Kartenrücken in
// der richtigen Anzahl - das Ergebnis (gelogen/Wahrheit) bleibt für alle sichtbar.
function maskRevealFor(reveal, viewerId) {
  if (!reveal) return null;
  if (viewerId != null && viewerId === reveal.accuserId) return reveal;
  return { ...reveal, revealedCards: reveal.revealedCards.map(() => ({ hidden: true })) };
}

function sendHandTo(room, player) {
  if (!player.socketId) return;
  const hand = room.hands[player.id] || [];
  io.to(player.socketId).emit('yourHand', { hand });
}

function broadcastState(room) {
  // Pro Spieler-Socket einzeln senden (nicht als ein gemeinsamer Raum-Broadcast),
  // weil die Bluff-Aufdeckung für den Ankläger anders aussieht als für alle anderen.
  room.players.forEach((p) => {
    if (!p.socketId) return;
    io.to(p.socketId).emit('gameState', publicState(room, p.id));
  });
  room.players.forEach((p) => sendHandTo(room, p));
  scheduleBotTurnIfNeeded(room);
}

// ---------------------------------------------------------------------------
// Rundenablauf
// ---------------------------------------------------------------------------

function startGame(room) {
  room.roundNumber = 0;
  room.history = [];
  room.logs = [];

  // Regel 1.3: In der ersten Runde entscheidet ein Würfelwurf, wer anfängt.
  const roller = room.players[Math.floor(Math.random() * room.players.length)];
  const rolls = {};
  room.players.forEach((p) => { rolls[p.id] = 1 + Math.floor(Math.random() * 6); });
  rolls[roller.id] = 6; // der Würfelsieger bekommt sichtbar die höchste Zahl
  room.diceRoll = { rolls, starterId: roller.id };
  room.starterPlayerId = roller.id;
  log(room, `Das Spiel beginnt. ${roller.name} würfelt die höchste Zahl und fängt an.`);
  startRound(room);
}

function startRound(room) {
  // Zufällige Sitz-/Zugreihenfolge für diese Runde, unabhängig von der Beitritts-
  // reihenfolge und unabhängig von der Sitzordnung der vorigen Runde - wird also
  // vor jeder neuen Runde (auch der ersten) neu ausgelost.
  room.players = shuffle(room.players);
  const deck = shuffle(buildDeck(room.settings));
  if (deck.length < room.players.length) {
    log(room, 'Zu wenige Karten im Deck für so viele Spieler - Deckgröße wurde nicht angepasst.');
  }
  room.roundNumber += 1;
  room.hands = dealCards(room.players, deck);
  room.pile = [];
  room.requiredRank = null;
  room.finishedOrder = [];
  room.lastReveal = null;

  // Regel 2.8 gilt auch direkt nach dem Austeilen.
  room.players.forEach((p) => applyAutoDiscard(room, p.id));

  const starterIdx = findPlayerIndex(room, room.starterPlayerId);
  room.currentTurnIndex = starterIdx >= 0 ? starterIdx : 0;
  // Falls der vorgesehene Starter (Verlierer der Vorrunde o.ä.) durch Auto-Ablage
  // schon fertig sein sollte (Extremfall bei sehr kleinen Händen), zum nächsten
  // aktiven Spieler weiterrücken.
  if ((room.hands[room.players[room.currentTurnIndex].id] || []).length === 0) {
    room.currentTurnIndex = nextActiveIndex(room.players, room.hands, room.currentTurnIndex);
  }
  room.phase = 'playing';
  log(room, `Runde ${room.roundNumber} beginnt - ${findPlayer(room, room.players[room.currentTurnIndex].id).name} eröffnet den Stapel.`);
  touchRoom(room);
}

function applyAutoDiscard(room, playerId) {
  const hand = room.hands[playerId] || [];
  const { hand: remaining, discarded } = extractFourOfAKind(hand);
  room.hands[playerId] = remaining;
  if (discarded.length) {
    const counts = {};
    discarded.forEach((c) => { counts[c.rank] = (counts[c.rank] || 0) + 1; });
    const parts = Object.entries(counts).map(([rank, n]) => `${n}× ${rankLabel(rank)}`);
    log(room, `${findPlayer(room, playerId).name} hat 4 gleiche Karten auf der Hand und legt sie automatisch ab (${parts.join(', ')}).`);
  }
  updateFinishedStatus(room, playerId);
}

function updateFinishedStatus(room, playerId) {
  const hand = room.hands[playerId] || [];
  const idx = room.finishedOrder.indexOf(playerId);
  if (hand.length === 0 && idx === -1) {
    room.finishedOrder.push(playerId);
  } else if (hand.length > 0 && idx !== -1) {
    room.finishedOrder.splice(idx, 1);
  }
}

// Prüft, ob die Runde vorbei ist (nur noch <=1 Spieler mit Karten). Der letzte
// verbleibende Spieler ist der Verlierer der Runde und eröffnet die nächste
// Runde (Regel 1.3, zweiter Satz).
function checkRoundEnd(room) {
  const active = room.players.filter((p) => (room.hands[p.id] || []).length > 0);
  if (active.length > 1) return false;
  if (active.length === 1) {
    const loser = active[0];
    if (!room.finishedOrder.includes(loser.id)) room.finishedOrder.push(loser.id);
    room.starterPlayerId = loser.id;
    log(room, `${loser.name} bleibt als letzte:r mit Karten übrig und beginnt die nächste Runde.`);
  }
  room.phase = 'roundend';
  room.history.push({ round: room.roundNumber, order: room.finishedOrder.slice(), starterId: room.starterPlayerId });
  touchRoom(room);
  return true;
}

function handleStartPile(room, playerId, rank, cardIds) {
  if (room.phase !== 'playing' || room.pile.length !== 0) return;
  const actor = currentActor(room);
  if (!actor || actor.id !== playerId) return;
  const claimable = claimableRanksFor(room.settings.deckRange);
  if (!claimable.includes(rank)) return;
  if (!Array.isArray(cardIds) || cardIds.length === 0) return;
  const hand = room.hands[playerId] || [];
  const cards = cardIds.map((id) => hand.find((c) => c.id === id)).filter(Boolean);
  if (cards.length !== cardIds.length) return; // eine Karte war nicht in der Hand

  const cardIdSet = new Set(cardIds);
  room.hands[playerId] = hand.filter((c) => !cardIdSet.has(c.id));
  room.requiredRank = rank;
  room.pile = [{ playerId, cards, claimedCount: cards.length }];
  log(room, `${actor.name} eröffnet: ${cards.length}× ${rankLabel(rank)} (verdeckt).`);

  updateFinishedStatus(room, playerId);
  if (checkRoundEnd(room)) { broadcastState(room); return; }

  room.currentTurnIndex = nextActiveIndex(room.players, room.hands, room.currentTurnIndex);
  touchRoom(room);
  broadcastState(room);
}

function handlePlayCards(room, playerId, cardIds) {
  if (room.phase !== 'playing' || room.pile.length === 0) return;
  const actor = currentActor(room);
  if (!actor || actor.id !== playerId) return;
  if (!Array.isArray(cardIds) || cardIds.length === 0) return;
  const hand = room.hands[playerId] || [];
  const cards = cardIds.map((id) => hand.find((c) => c.id === id)).filter(Boolean);
  if (cards.length !== cardIds.length) return;

  const cardIdSet = new Set(cardIds);
  room.hands[playerId] = hand.filter((c) => !cardIdSet.has(c.id));
  room.pile.push({ playerId, cards, claimedCount: cards.length });
  log(room, `${actor.name} legt ${cards.length}× ${rankLabel(room.requiredRank)} nach (verdeckt).`);

  updateFinishedStatus(room, playerId);
  if (checkRoundEnd(room)) { broadcastState(room); return; }

  room.currentTurnIndex = nextActiveIndex(room.players, room.hands, room.currentTurnIndex);
  touchRoom(room);
  broadcastState(room);
}

const REVEAL_DELAY_MS = Number(process.env.REVEAL_DELAY_MS) || 3200;

function handleCallBluff(room, playerId) {
  if (room.phase !== 'playing' || room.pile.length === 0) return;
  const actor = currentActor(room);
  if (!actor || actor.id !== playerId) return;

  const target = room.pile[room.pile.length - 1];
  const targetPlayer = findPlayer(room, target.playerId);
  const claimedRank = room.requiredRank; // vor dem Leeren des Stapels sichern (für die Reveal-Anzeige)
  const wasLie = !wasTruthful(target.cards, claimedRank);
  const allPileCards = room.pile.reduce((acc, play) => acc.concat(play.cards), []);

  let recipientId;
  if (wasLie) {
    recipientId = target.playerId; // Lügner nimmt den ganzen Stapel auf
    log(room, `${actor.name} ruft "Bluff!" - ${targetPlayer.name} hat gelogen und nimmt ${allPileCards.length} Karten auf.`);
  } else {
    recipientId = playerId; // falscher Verdacht: Ankläger nimmt den Stapel auf
    log(room, `${actor.name} ruft "Bluff!" - ${targetPlayer.name} hatte aber die Wahrheit gesagt. ${actor.name} nimmt ${allPileCards.length} Karten auf.`);
  }

  room.hands[recipientId] = (room.hands[recipientId] || []).concat(allPileCards);
  room.pile = [];
  room.requiredRank = null;

  applyAutoDiscard(room, recipientId);

  room.lastReveal = {
    accuserId: playerId,
    targetId: target.playerId,
    claimedRank,
    revealedCards: target.cards,
    claimedCount: target.claimedCount,
    wasLie,
    recipientId,
    pileSize: allPileCards.length,
  };

  if (checkRoundEnd(room)) {
    touchRoom(room);
    broadcastState(room);
    return;
  }

  if (!wasLie) {
    // Nächster Spieler NACH dem (falsch) anklagenden Spieler eröffnet neu.
    const accuserIdx = findPlayerIndex(room, playerId);
    room.currentTurnIndex = nextActiveIndex(room.players, room.hands, accuserIdx);
  } else {
    room.currentTurnIndex = findPlayerIndex(room, playerId); // wer den Bluff erkannt hat, eröffnet neu
  }

  room.phase = 'reveal';
  touchRoom(room);
  broadcastState(room);

  if (room.revealTimer) clearTimeout(room.revealTimer);
  room.revealTimer = setTimeout(() => {
    if (!rooms.has(room.code)) return;
    if (room.phase !== 'reveal') return;
    room.lastReveal = null;
    room.phase = 'playing';
    touchRoom(room);
    broadcastState(room);
  }, REVEAL_DELAY_MS);
}

// ---------------------------------------------------------------------------
// Bots
// ---------------------------------------------------------------------------

function addBot(room) {
  if (room.players.length >= MAX_PLAYERS) return null;
  const usedNames = new Set(room.players.map((p) => p.name));
  const name = BOT_NAME_POOL.find((n) => !usedNames.has(n)) || `Bot ${room.players.length + 1}`;
  const bot = { id: makeId(), token: null, name, socketId: null, connected: true, isBot: true };
  room.players.push(bot);
  log(room, `${name} (Bot) wurde hinzugefügt.`);
  return bot;
}

const BOT_DELAY_MIN = Number(process.env.BOT_DELAY_MIN_MS) || 1000;
const BOT_DELAY_MAX = Number(process.env.BOT_DELAY_MAX_MS) || 2600;

function randomDelay(min = BOT_DELAY_MIN, max = BOT_DELAY_MAX) {
  return min + Math.random() * (max - min);
}

function tally(hand) {
  const counts = {};
  hand.forEach((c) => { counts[c.rank] = (counts[c.rank] || 0) + 1; });
  return counts;
}

function pickCardsForClaim(hand, rank, count) {
  const counts = tally(hand);
  const real = hand.filter((c) => c.rank === rank);
  const jacks = hand.filter((c) => c.rank === 'J');
  const others = hand.filter((c) => c.rank !== rank && c.rank !== 'J')
    .sort((a, b) => (counts[a.rank] || 0) - (counts[b.rank] || 0)); // seltene/einzelne Karten zuerst loswerden
  const picked = [];
  for (const c of real) { if (picked.length >= count) break; picked.push(c); }
  for (const c of jacks) { if (picked.length >= count) break; picked.push(c); }
  for (const c of others) { if (picked.length >= count) break; picked.push(c); }
  return picked.slice(0, count);
}

function decideBotStart(room, bot) {
  const hand = room.hands[bot.id] || [];
  const claimable = claimableRanksFor(room.settings.deckRange);
  const counts = tally(hand);
  const jackCount = counts.J || 0;
  let bestRank = claimable[0];
  let bestScore = -1;
  claimable.forEach((r) => {
    const score = (counts[r] || 0) + jackCount * 0.5 + Math.random() * 0.2;
    if (score > bestScore) { bestScore = score; bestRank = r; }
  });
  const available = (counts[bestRank] || 0) + jackCount;
  const playCount = Math.max(1, Math.min(hand.length, available > 0 ? Math.min(available, 1 + Math.floor(Math.random() * 3)) : 1));
  const cards = pickCardsForClaim(hand, bestRank, playCount);
  return { rank: bestRank, cardIds: cards.map((c) => c.id) };
}

// Grobe Bluff-Erkennung: wie viele Karten der geforderten Sorte (oder Buben)
// könnten realistisch noch im Spiel sein, gemessen an dem, was der Bot selbst
// auf der Hand hat und was in diesem Stapel bereits behauptet wurde?
function computeSuspicion(room, bot) {
  const hand = room.hands[bot.id] || [];
  const comp = deckComposition(room.settings);
  const totalWild = (comp[room.requiredRank] || 0) + (comp.J || 0);
  const ownRelevant = hand.filter((c) => c.rank === room.requiredRank || c.rank === 'J').length;
  const claimedSoFar = room.pile.reduce((sum, p) => sum + p.claimedCount, 0);
  const overcommit = claimedSoFar + ownRelevant - totalWild;
  return overcommit; // > 0 => rechnerisch unmöglich, dass alles ehrlich war
}

function decideBotAction(room, bot) {
  const suspicion = computeSuspicion(room, bot);
  const lastCount = room.pile[room.pile.length - 1].claimedCount;
  let callThreshold = 0.15; // Grundrauschen: auch ohne Beweise ab und zu anzweifeln
  if (suspicion > 0) callThreshold += 0.55 + Math.min(0.35, suspicion * 0.12);
  if (lastCount >= 3) callThreshold += 0.1; // große Behauptungen wirken verdächtiger
  if (Math.random() < callThreshold) return { type: 'bluff' };

  const hand = room.hands[bot.id] || [];
  const counts = tally(hand);
  const realCount = counts[room.requiredRank] || 0;
  const jackCount = counts.J || 0;
  const honestAvailable = realCount + jackCount;
  let playCount;
  if (honestAvailable > 0 && Math.random() < 0.75) {
    playCount = Math.max(1, Math.min(honestAvailable, hand.length, 1 + Math.floor(Math.random() * 2)));
  } else {
    playCount = Math.max(1, Math.min(hand.length, 1 + Math.floor(Math.random() * 2)));
  }
  const cards = pickCardsForClaim(hand, room.requiredRank, playCount);
  return { type: 'play', cardIds: cards.map((c) => c.id) };
}

function scheduleBotTurnIfNeeded(room) {
  if (room.phase !== 'playing') return;
  const actor = currentActor(room);
  if (!actor || !actor.isBot) return;
  const turnIdxAtSchedule = room.currentTurnIndex;
  const pileLenAtSchedule = room.pile.length;
  setTimeout(() => {
    if (!rooms.has(room.code)) return;
    if (room.phase !== 'playing') return;
    if (room.currentTurnIndex !== turnIdxAtSchedule || room.pile.length !== pileLenAtSchedule) return;
    if (room.pile.length === 0) {
      const { rank, cardIds } = decideBotStart(room, actor);
      if (cardIds.length) handleStartPile(room, actor.id, rank, cardIds);
    } else {
      const action = decideBotAction(room, actor);
      if (action.type === 'bluff') handleCallBluff(room, actor.id);
      else if (action.cardIds.length) handlePlayCards(room, actor.id, action.cardIds);
    }
  }, randomDelay());
}

// ---------------------------------------------------------------------------
// Socket.IO
// ---------------------------------------------------------------------------

io.on('connection', (socket) => {
  socket.on('createRoom', ({ name }, cb) => {
    try {
      if (isRateLimited(`createRoom:${getClientIp(socket)}`, 8, 60 * 1000)) {
        return cb({ ok: false, error: 'Zu viele neue Räume in kurzer Zeit. Bitte kurz warten und erneut versuchen.' });
      }
      if (rooms.size >= MAX_ROOMS) {
        return cb({ ok: false, error: 'Gerade sind zu viele Räume aktiv. Bitte versuche es in ein paar Minuten erneut.' });
      }
      name = (name || '').trim().slice(0, 20) || 'Spieler';
      const room = createRoom();
      const player = { id: makeId(), token: makeId(), name, socketId: socket.id, connected: true };
      room.hostId = player.id;
      room.players.push(player);
      socket.join(room.code);
      socket.data.roomCode = room.code;
      socket.data.playerId = player.id;
      log(room, `${name} hat den Raum erstellt.`);
      touchRoom(room);
      cb({ ok: true, code: room.code, playerId: player.id, token: player.token });
      broadcastState(room);
    } catch (err) {
      cb({ ok: false, error: 'Raum konnte nicht erstellt werden.' });
    }
  });

  socket.on('joinRoom', ({ code, name, token }, cb) => {
    if (isRateLimited(`joinRoom:${getClientIp(socket)}`, 20, 60 * 1000)) {
      return cb({ ok: false, error: 'Zu viele Versuche in kurzer Zeit. Bitte kurz warten und erneut versuchen.' });
    }
    code = (code || '').trim().toUpperCase();
    const room = rooms.get(code);
    if (!room) return cb({ ok: false, error: 'Diesen Raum gibt es nicht.' });

    if (token) {
      const existing = room.players.find((p) => p.token === token);
      if (existing) {
        existing.socketId = socket.id;
        existing.connected = true;
        socket.join(room.code);
        socket.data.roomCode = room.code;
        socket.data.playerId = existing.id;
        touchRoom(room);
        log(room, `${existing.name} ist wieder verbunden.`);
        cb({ ok: true, code: room.code, playerId: existing.id, token: existing.token, rejoined: true });
        broadcastState(room);
        return;
      }
    }

    if (room.phase !== 'lobby') {
      return cb({ ok: false, error: 'Das Spiel läuft bereits. Bitte warte auf die nächste Runde.' });
    }
    if (room.players.length >= MAX_PLAYERS) {
      return cb({ ok: false, error: `Der Raum ist bereits voll (max. ${MAX_PLAYERS} Spieler).` });
    }
    name = (name || '').trim().slice(0, 20) || 'Spieler';
    if (room.players.some((p) => p.name.toLowerCase() === name.toLowerCase())) {
      return cb({ ok: false, error: 'Dieser Name ist im Raum bereits vergeben.' });
    }
    const player = { id: makeId(), token: makeId(), name, socketId: socket.id, connected: true };
    room.players.push(player);
    if (!room.hostId) room.hostId = player.id;
    socket.join(room.code);
    socket.data.roomCode = room.code;
    socket.data.playerId = player.id;
    touchRoom(room);
    log(room, `${name} ist dem Raum beigetreten.`);
    cb({ ok: true, code: room.code, playerId: player.id, token: player.token });
    broadcastState(room);
  });

  socket.on('leaveRoom', () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return;
    const player = findPlayer(room, socket.data.playerId);
    if (!player) return;

    if (room.phase === 'lobby') {
      room.players = room.players.filter((p) => p.id !== player.id);
      if (room.hostId === player.id) {
        room.hostId = room.players.length ? room.players[0].id : null;
      }
      log(room, `${player.name} hat den Raum verlassen.`);
    } else {
      player.connected = false;
      log(room, `${player.name} hat das Spiel verlassen.`);
    }

    socket.leave(room.code);
    socket.data.roomCode = null;
    socket.data.playerId = null;
    touchRoom(room);
    if (room.players.length === 0) {
      rooms.delete(room.code);
    } else {
      broadcastState(room);
    }
  });

  socket.on('kickPlayer', ({ playerId }) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.phase !== 'lobby') return;
    if (socket.data.playerId !== room.hostId) return;
    if (playerId === room.hostId) return;
    room.players = room.players.filter((p) => p.id !== playerId);
    touchRoom(room);
    broadcastState(room);
  });

  socket.on('addBot', () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.phase !== 'lobby') return;
    if (socket.data.playerId !== room.hostId) return;
    addBot(room);
    touchRoom(room);
    broadcastState(room);
  });

  socket.on('removeBot', ({ botId }) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.phase !== 'lobby') return;
    if (socket.data.playerId !== room.hostId) return;
    const bot = findPlayer(room, botId);
    if (!bot || !bot.isBot) return;
    room.players = room.players.filter((p) => p.id !== botId);
    touchRoom(room);
    broadcastState(room);
  });

  socket.on('fillBots', () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.phase !== 'lobby') return;
    if (socket.data.playerId !== room.hostId) return;
    while (room.players.length < MIN_PLAYERS) addBot(room);
    touchRoom(room);
    broadcastState(room);
  });

  socket.on('updateSettings', (settings) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.phase !== 'lobby') return;
    if (socket.data.playerId !== room.hostId) return;
    room.settings = clampSettings(Object.assign({}, room.settings, settings));
    touchRoom(room);
    broadcastState(room);
  });

  socket.on('startGame', () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.phase !== 'lobby') return;
    if (socket.data.playerId !== room.hostId) return;
    if (room.players.length < MIN_PLAYERS || room.players.length > MAX_PLAYERS) return;
    if (buildDeck(room.settings).length < room.players.length) return;
    startGame(room);
    broadcastState(room);
  });

  socket.on('startPile', ({ rank, cardIds }) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return;
    handleStartPile(room, socket.data.playerId, rank, cardIds);
  });

  socket.on('playCards', ({ cardIds }) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return;
    handlePlayCards(room, socket.data.playerId, cardIds);
  });

  socket.on('callBluff', () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return;
    handleCallBluff(room, socket.data.playerId);
  });

  socket.on('nextRound', () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.phase !== 'roundend') return;
    if (socket.data.playerId !== room.hostId) return;
    startRound(room);
    broadcastState(room);
  });

  socket.on('resetGame', () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return;
    if (socket.data.playerId !== room.hostId) return;
    if (room.revealTimer) clearTimeout(room.revealTimer);
    room.phase = 'lobby';
    room.hands = {};
    room.pile = [];
    room.requiredRank = null;
    room.finishedOrder = [];
    room.roundNumber = 0;
    room.starterPlayerId = null;
    room.diceRoll = null;
    room.lastReveal = null;
    room.history = [];
    room.logs = [];
    log(room, 'Zurück zur Lobby. Bereit für eine neue Partie.');
    touchRoom(room);
    broadcastState(room);
  });

  socket.on('disconnect', () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return;
    const player = findPlayer(room, socket.data.playerId);
    if (!player) return;
    player.connected = false;
    log(room, `${player.name} hat die Verbindung verloren.`);
    touchRoom(room);
    broadcastState(room);
  });
});

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`Bluff läuft auf Port ${PORT}`);
    console.log(`Lokal öffnen unter: http://localhost:${PORT}`);
  });
}

module.exports = {
  buildDeck, shuffle, dealCards, wasTruthful, extractFourOfAKind,
  nextActiveIndex, activeCount, claimableRanksFor, ranksFor, deckComposition,
  clampSettings, maxJackCount, SUITS, SUIT_INFO, RANK_LABELS,
};
