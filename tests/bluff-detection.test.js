// Gezielter Test für den Kern der Lüg-Erkennung (Regel 2.4/2.5): steuert 2
// echte Clients (keine Bots) direkt, damit exakt eine bewusste Lüge und
// danach eine bewusst wahre Aussage jeweils angeklagt werden - und prüft,
// wer am Ende die Karten aufnehmen muss und wer neu eröffnet.

const { startServer, stopServer, connectClient, emitAsync, waitForState, assert } = require('./helpers');

const PORT = 3803;

// "gameState" und "yourHand" gehören zum selben Broadcast, kommen aber als
// getrennte Socket.IO-Pakete an und können clientseitig in unterschiedlichen
// Ticks verarbeitet werden. Statt auf ein einzelnes "yourHand"-Event zu warten
// (Race-Risiko, falls noch ein älteres Lobby-Update in der Pipeline ist),
// wird hier so lange gewartet, bis eine Bedingung über den kontinuierlich
// nachgeführten Zustand erfüllt ist.
function waitUntil(fn, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (fn()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error('Timeout beim Warten auf lokale Bedingung'));
      setTimeout(tick, 15);
    };
    tick();
  });
}

async function main() {
  const proc = await startServer(PORT, { REVEAL_DELAY_MS: '30' });
  try {
    const url = `http://localhost:${PORT}`;
    const a = await connectClient(url);
    const b = await connectClient(url);

    // Beide Clients halten ihre zuletzt bekannte eigene Hand laufend nach -
    // der Server schickt "yourHand" bei jedem broadcastState neu.
    let handA = [];
    let handB = [];
    a.on('yourHand', (h) => { handA = h.hand; });
    b.on('yourHand', (h) => { handB = h.hand; });

    const createdA = await emitAsync(a, 'createRoom', { name: 'A' });
    assert(createdA.ok, 'A sollte Raum erstellen können');
    const code = createdA.code;
    const idA = createdA.playerId;

    // Kein Joker im Deck, damit "wahr/gelogen" für den Test eindeutig ist.
    a.emit('updateSettings', { deckRange: '32', deckCount: 1, jackCount: 0 });
    await waitForState(a, (s) => s.settings.jackCount === 0);

    const joinedB = await emitAsync(b, 'joinRoom', { code, name: 'B' });
    assert(joinedB.ok, 'B sollte dem Raum beitreten können');
    const idB = joinedB.playerId;

    a.emit('startGame');
    const state1 = await waitForState(a, (s) => s.phase === 'playing');
    // deckSize (28 bei 32er-Deck ohne Buben) kann durch die automatische
    // 4er-Ablage direkt nach dem Austeilen (Regel 2.8) noch kleiner ausfallen -
    // daher gegen die tatsächlichen Handgrößen aus dem State prüfen, nicht fest gegen 28/32.
    const dealtTotal = state1.players.reduce((sum, p) => sum + p.handCount, 0);
    const expectedA = state1.players.find((p) => p.id === idA).handCount;
    const expectedB = state1.players.find((p) => p.id === idB).handCount;
    await waitUntil(() => handA.length === expectedA && handB.length === expectedB);
    assert(dealtTotal > 0 && dealtTotal <= state1.deckSize, `Verteilte Kartenzahl (${dealtTotal}) sollte zwischen 1 und der Deckgröße (${state1.deckSize}) liegen`);

    const socketOf = (id) => (id === idA ? a : b);
    const handOf = (id) => (id === idA ? handA : handB);
    const otherOf = (id) => (id === idA ? idB : idA);
    // Wartet, bis die lokal nachgeführte Hand von playerId exakt so viele Karten
    // zeigt, wie der öffentliche State es für diesen Spieler gerade angibt -
    // schließt die "gameState vor yourHand angekommen"-Race zuverlässig.
    async function syncHand(playerId, state) {
      const expected = state.players.find((p) => p.id === playerId).handCount;
      await waitUntil(() => handOf(playerId).length === expected);
    }

    // --- Teil 1: bewusste Lüge, korrekt erkannt ---
    const starterId = state1.currentTurnId;
    const startHandLen = handOf(starterId).length;
    const lieCard = handOf(starterId)[0];
    // Eine einzelne Karte legen und dabei bewusst eine ANDERE Sorte behaupten,
    // als die gespielte Karte tatsächlich hat - das ist unabhängig vom Rest der
    // Hand immer eine eindeutige Lüge (kein Joker im Deck für diesen Test).
    const claimedRank = state1.claimableRanks.find((r) => r !== lieCard.rank);
    assert(claimedRank, 'Es sollte eine andere ansagbare Sorte als die der Testkarte geben');

    socketOf(starterId).emit('startPile', { rank: claimedRank, cardIds: [lieCard.id] });
    await waitForState(socketOf(otherOf(starterId)), (s) => !s.isPileEmpty);

    socketOf(otherOf(starterId)).emit('callBluff');
    const reveal1 = await waitForState(socketOf(otherOf(starterId)), (s) => s.phase === 'reveal' && s.lastReveal);
    assert(reveal1.lastReveal.wasLie === true, 'Der Server sollte die Lüge korrekt erkennen');
    assert(reveal1.lastReveal.recipientId === starterId, 'Der Lügner sollte die aufgedeckte Karte zurückbekommen');
    assert(reveal1.players.find((p) => p.id === starterId).handCount === startHandLen, 'Lügner sollte danach wieder genauso viele Karten haben wie vor der Lüge (1 abgelegt, 1 zurück)');

    const afterReveal1 = await waitForState(socketOf(starterId), (s) => s.phase === 'playing' && s.isPileEmpty);
    assert(afterReveal1.currentTurnId === otherOf(starterId), 'Wer den Bluff korrekt erkannt hat, sollte jetzt neu eröffnen');
    await syncHand(idA, afterReveal1);
    await syncHand(idB, afterReveal1);

    // --- Teil 2: bewusst wahre Aussage, fälschlich angezweifelt ---
    const starter2Id = afterReveal1.currentTurnId;
    const accuser2Id = otherOf(starter2Id);
    const truthCandidateRank = state1.claimableRanks.find((r) => handOf(starter2Id).some((c) => c.rank === r));
    assert(truthCandidateRank, 'Starter der 2. Teilprobe sollte mindestens eine ansagbare, tatsächlich besessene Sorte haben');
    const truthCard = handOf(starter2Id).find((c) => c.rank === truthCandidateRank);
    const starter2HandLen = handOf(starter2Id).length;
    const accuser2HandLenBefore = handOf(accuser2Id).length;

    socketOf(starter2Id).emit('startPile', { rank: truthCandidateRank, cardIds: [truthCard.id] });
    await waitForState(socketOf(accuser2Id), (s) => !s.isPileEmpty);

    socketOf(accuser2Id).emit('callBluff');
    const reveal2 = await waitForState(socketOf(accuser2Id), (s) => s.phase === 'reveal' && s.lastReveal);
    assert(reveal2.lastReveal.wasLie === false, 'Der Server sollte die wahre Aussage korrekt als Wahrheit erkennen');
    assert(reveal2.lastReveal.recipientId === accuser2Id, 'Wer fälschlich "Bluff!" ruft, sollte die Karte(n) selbst aufnehmen müssen');
    assert(reveal2.players.find((p) => p.id === starter2Id).handCount === starter2HandLen - 1, 'Wahrheitssager sollte seine gespielte Karte dauerhaft los sein');
    // Der fälschliche Ankläger nimmt die 1 Karte aus dem Stapel auf - hat er
    // danach zufällig 4 gleiche auf der Hand, greift sofort die automatische
    // Ablage (Regel 2.8) und zieht nochmal 4 ab. Beides zusammen ist nur an
    // einem Vielfachen von 4 unterhalb von "+1" erkennbar.
    const accuser2HandLenAfter = reveal2.players.find((p) => p.id === accuser2Id).handCount;
    const accuserDelta = accuser2HandLenBefore + 1 - accuser2HandLenAfter;
    assert(accuserDelta >= 0 && accuserDelta % 4 === 0, `Fälschlicher Ankläger sollte die 1 Karte aufnehmen (evtl. minus automatischer 4er-Ablage), Differenz war aber ${accuserDelta}`);

    const afterReveal2 = await waitForState(socketOf(starter2Id), (s) => s.phase === 'playing' && s.isPileEmpty);
    // Bei nur 2 Spielern ist "der Spieler nach dem Ankläger" wieder der ursprüngliche starter2Id.
    assert(afterReveal2.currentTurnId === starter2Id, 'Nach falschem Verdacht sollte der Spieler NACH dem Ankläger neu eröffnen');

    console.log('OK: bluff-detection.test.js');
  } finally {
    await stopServer(proc);
  }
}

main().catch((err) => {
  console.error('FEHLER in bluff-detection.test.js:', err);
  process.exitCode = 1;
});
