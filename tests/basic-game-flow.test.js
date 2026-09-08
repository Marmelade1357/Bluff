// Regressionstest für den kompletten Spielablauf: Raum erstellen, Deck-
// Einstellungen anpassen, mit Bots auffüllen, Spiel starten und eine
// komplette Runde bis zum Rundenende durchspielen (nur Bots + 1 Autopilot-
// Client, damit es vollautomatisch läuft). Prüft vor allem, dass der Server
// dabei nicht abstürzt oder hängen bleibt, und dass am Ende ein konsistentes
// Ergebnis steht (jeder Spieler taucht genau einmal in der Ranglisten-
// Reihenfolge auf, der letzte Eintrag hat 0 Karten übrig).

const { startServer, stopServer, connectClient, emitAsync, waitForState, attachAutopilot, assert } = require('./helpers');

const PORT = 3801;

async function main() {
  const proc = await startServer(PORT, {
    BOT_DELAY_MIN_MS: '5',
    BOT_DELAY_MAX_MS: '20',
    REVEAL_DELAY_MS: '30',
  });
  try {
    const url = `http://localhost:${PORT}`;
    const host = await connectClient(url);
    let myId = null;
    attachAutopilot(host, () => myId);

    const created = await emitAsync(host, 'createRoom', { name: 'TestHost' });
    assert(created.ok, `createRoom sollte erfolgreich sein, war aber: ${JSON.stringify(created)}`);
    myId = created.playerId;

    // Deck-Einstellungen anpassen und prüfen, dass sie im State ankommen.
    host.emit('updateSettings', { deckRange: '32', deckCount: 1, jackCount: 2 });
    const settingsState = await waitForState(host, (s) => s.settings.deckRange === '32' && s.settings.jackCount === 2);
    assert(settingsState.deckSize === 30, `32er-Deck mit 2 Buben sollte 30 Karten ergeben, waren aber ${settingsState.deckSize}`);
    assert(!settingsState.claimableRanks.includes('J'), 'Bube darf nicht in den ansagbaren Sorten auftauchen');

    host.emit('fillBots');
    const lobbyState = await waitForState(host, (s) => s.players.length === 2);
    assert(lobbyState.players.length === 2, 'Raum sollte nach fillBots mindestens 2 Spieler haben');

    host.emit('addBot');
    host.emit('addBot');
    const filledState = await waitForState(host, (s) => s.players.length === 4);
    assert(filledState.players.length === 4, 'Raum sollte 4 Spieler haben');

    host.emit('startGame');
    const playingState = await waitForState(host, (s) => s.phase === 'playing');
    assert(playingState.roundNumber === 1, 'Erste Runde sollte Nummer 1 haben');
    assert(playingState.starterPlayerId, 'Es sollte ein Startspieler (Würfelergebnis) feststehen');
    assert(playingState.diceRoll && playingState.diceRoll.starterId === playingState.starterPlayerId, 'Würfelergebnis sollte zum Startspieler passen');

    const totalHandsAtStart = playingState.players.reduce((sum, p) => sum + p.handCount, 0);
    assert(totalHandsAtStart === playingState.deckSize, `Alle ${playingState.deckSize} Karten sollten verteilt sein, waren aber ${totalHandsAtStart}`);

    const roundEndState = await waitForState(host, (s) => s.phase === 'roundend', 60000);
    assert(roundEndState.finishedOrder.length === 4, `Am Rundenende sollten alle 4 Spieler in der Reihenfolge stehen, waren aber ${roundEndState.finishedOrder.length}`);
    assert(new Set(roundEndState.finishedOrder).size === 4, 'Jeder Spieler darf nur einmal in der Reihenfolge auftauchen');
    // Der Verlierer ist, wer als letzte:r noch Karten auf der Hand hat (Regel 3.1) -
    // alle anderen Einträge davor müssen dagegen mit 0 Karten fertig geworden sein.
    const loserId = roundEndState.finishedOrder[roundEndState.finishedOrder.length - 1];
    const loserPlayer = roundEndState.players.find((p) => p.id === loserId);
    assert(loserPlayer.handCount > 0, 'Der Verlierer sollte am Rundenende noch Karten auf der Hand haben');
    roundEndState.finishedOrder.slice(0, -1).forEach((id) => {
      const p = roundEndState.players.find((pl) => pl.id === id);
      assert(p.handCount === 0, `Spieler ${id} steht vor dem Verlierer in der Reihenfolge, sollte also 0 Karten haben, hat aber ${p.handCount}`);
    });
    assert(roundEndState.history.length === 1, `Es sollte 1 Runden-Eintrag in der Historie stehen, waren aber ${roundEndState.history.length}`);
    assert(roundEndState.history[0].starterId === loserId, 'Der Verlierer der Runde sollte als nächster Startspieler vermerkt sein');

    // Nächste Runde starten und prüfen, dass der Verlierer sie eröffnet.
    host.emit('nextRound');
    const round2State = await waitForState(host, (s) => s.phase === 'playing' && s.roundNumber === 2);
    assert(round2State.starterPlayerId === loserId, 'Der Verlierer der letzten Runde sollte die neue Runde eröffnen');

    // Zurück zur Lobby.
    host.emit('resetGame');
    const lobbyAgain = await waitForState(host, (s) => s.phase === 'lobby');
    assert(lobbyAgain.roundNumber === 0, 'Nach resetGame sollte die Rundenzahl zurückgesetzt sein');

    console.log('OK: basic-game-flow.test.js');
  } finally {
    await stopServer(proc);
  }
}

main().catch((err) => {
  console.error('FEHLER in basic-game-flow.test.js:', err);
  process.exitCode = 1;
});
