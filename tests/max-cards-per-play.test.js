// Regressionstest für die Regel "man darf pro Zug höchstens 3 Karten legen":
// sowohl beim Eröffnen des Stapels (startPile) als auch beim Nachlegen
// (playCards) muss der Server einen Versuch mit mehr als 3 Karten
// stillschweigend ablehnen (keine Zustandsänderung), einen Versuch mit
// höchstens 3 Karten aber zulassen.

const { startServer, stopServer, connectClient, emitAsync, waitForState, assert } = require('./helpers');

const PORT = 3902;

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Liefert die Handkarten, die als direkte Folge der NÄCHSTEN 'yourHand'-Nachricht
// ankommen. Muss VOR dem auslösenden emit() aufgerufen werden, damit garantiert
// die eigene Aktion erfasst wird und nicht ein späteres (schnelles Bot-)Ereignis.
function nextHand(socket) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timeout beim Warten auf yourHand')), 5000);
    socket.once('yourHand', (h) => { clearTimeout(timer); resolve(h.hand || []); });
  });
}

async function main() {
  // Kurze Bot-Verzögerung, damit der Test schnell durchläuft - die Bots agieren
  // hier nur als zweiter Mitspieler, gesteuert wird ausschließlich der Host.
  const proc = await startServer(PORT, { BOT_DELAY_MIN_MS: '5', BOT_DELAY_MAX_MS: '20', REVEAL_DELAY_MS: '30' });
  try {
    const url = `http://localhost:${PORT}`;
    const host = await connectClient(url);
    let myId = null;
    let myHand = [];
    host.on('yourHand', (h) => { myHand = h.hand || []; });

    const created = await emitAsync(host, 'createRoom', { name: 'TestHost' });
    myId = created.playerId;

    host.emit('fillBots');
    await waitForState(host, (s) => s.players.length === 2);
    host.emit('startGame');

    // Warten, bis der Host selbst am Zug ist (Bot könnte laut Würfelwurf zuerst dran sein,
    // spielt dann aber automatisch, bis der Host an der Reihe ist).
    const myTurnState = await waitForState(host, (s) => s.phase === 'playing' && s.currentTurnId === myId, 20000);
    await wait(200); // sicherstellen, dass 'yourHand' für diesen Stand bereits angekommen ist

    assert(myHand.length >= 4, `Für den Test werden mindestens 4 Handkarten benötigt, hatte aber nur ${myHand.length}`);
    const handCountBefore = myHand.length;

    if (myTurnState.isPileEmpty) {
      const rank = myTurnState.claimableRanks[0];

      // 1) Versuch mit 4 Karten (zu viel) - sollte abgelehnt werden (keine
      //    Zustandsänderung, also bleibt es weiter der Zug des Hosts, es kann
      //    also gar kein neues 'yourHand' hereinkommen).
      host.emit('startPile', { rank, cardIds: myHand.slice(0, 4).map((c) => c.id) });
      await wait(300);
      assert(myHand.length === handCountBefore, 'Ein Eröffnungsversuch mit 4 Karten sollte abgelehnt werden (Handkarten unverändert)');

      // 2) Versuch mit 3 Karten (Maximum) - sollte funktionieren. Die Karten
      //    werden verdeckt abgelegt, daher zählt nur die Kartenanzahl, nicht
      //    ob die Ansage "wahr" ist.
      const handPromise = nextHand(host);
      host.emit('startPile', { rank, cardIds: myHand.slice(0, 3).map((c) => c.id) });
      const handAfterOpen = await handPromise;
      assert(handAfterOpen.length === handCountBefore - 3, `Nach dem gültigen Eröffnen sollten genau 3 Karten von der Hand verschwunden sein, waren aber ${handCountBefore - handAfterOpen.length}`);
    } else {
      // Stapel ist schon offen (Bot hat eröffnet) - hier wird "nachgelegt" getestet.
      // Damit ein evtl. wahrheitsgemäßer/verlogener Zug keine Rolle spielt, wird
      // ausschließlich die unmittelbare Auswirkung auf die eigene Hand geprüft
      // (das nächste 'yourHand' danach, bevor ein Bot reagieren kann).

      // 1) Versuch mit 4 Karten (zu viel) - sollte abgelehnt werden.
      host.emit('playCards', { cardIds: myHand.slice(0, 4).map((c) => c.id) });
      await wait(300);
      assert(myHand.length === handCountBefore, 'Ein Nachlege-Versuch mit 4 Karten sollte abgelehnt werden (Handkarten unverändert)');

      // 2) Versuch mit 3 Karten (Maximum) - sollte funktionieren.
      const handPromise = nextHand(host);
      host.emit('playCards', { cardIds: myHand.slice(0, 3).map((c) => c.id) });
      const handAfterPlay = await handPromise;
      assert(handAfterPlay.length === handCountBefore - 3, `Nach dem gültigen Nachlegen sollten genau 3 Karten von der Hand verschwunden sein, waren aber ${handCountBefore - handAfterPlay.length}`);
    }

    console.log('OK: max-cards-per-play.test.js');
  } finally {
    await stopServer(proc);
  }
}

main().catch((err) => {
  console.error('FEHLER in max-cards-per-play.test.js:', err);
  process.exitCode = 1;
});
