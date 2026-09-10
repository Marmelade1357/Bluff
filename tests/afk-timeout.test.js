// Regressionstest für das AFK-Timeout: Eine verbundene, aber untätige Person
// am Zug (z. B. gesperrtes Handy) wird nach der eingestellten Zeit automatisch
// übersprungen - legt Karten nach (oder eröffnet den Stapel), damit niemand
// den Tisch unbegrenzt blockiert. Prüft außerdem, dass der Host diese
// Funktion in den Lobby-Einstellungen abschalten kann, und dass der Server
// dabei NIE automatisch "Bluff!" für die abwesende Person ruft.

const { startServer, stopServer, connectClient, emitAsync, waitForState, assert } = require('./helpers');

const AFK_TIMEOUT_MS = 300;
const FAST_ENV = {
  AFK_TIMEOUT_MS: String(AFK_TIMEOUT_MS),
  BOT_DELAY_MIN_MS: '20',
  BOT_DELAY_MAX_MS: '40',
  REVEAL_DELAY_MS: '30',
};

async function testEnabled() {
  const PORT = 3910;
  const proc = await startServer(PORT, FAST_ENV);
  try {
    const url = `http://localhost:${PORT}`;
    const host = await connectClient(url);
    let latestState = null;
    let bluffCalledAgainstMe = false;
    host.on('gameState', (s) => {
      latestState = s;
      if (s.lastReveal && s.lastReveal.targetId === myId) bluffCalledAgainstMe = true;
    });

    const created = await emitAsync(host, 'createRoom', { name: 'AFKHuman' });
    assert(created.ok, `createRoom fehlgeschlagen: ${JSON.stringify(created)}`);
    const myId = created.playerId;

    host.emit('fillBots');
    await waitForState(host, (s) => s.players.length === 2);
    host.emit('startGame');

    // Bewusst KEINE Aktion senden, sobald wir am Zug sind - simuliert genau
    // das Szenario "Handy gesperrt, Person reagiert nicht".
    const myTurnState = await waitForState(host, (s) => s.phase === 'playing' && s.currentTurnId === myId, 15000);
    assert(!!myTurnState, 'Sollte irgendwann am Zug sein');
    const t0 = Date.now();

    const afterState = await waitForState(
      host,
      (s) => s.phase !== 'playing' || s.currentTurnId !== myId,
      AFK_TIMEOUT_MS + 5000
    );
    const elapsed = Date.now() - t0;

    assert(
      elapsed >= AFK_TIMEOUT_MS - 100,
      `Zug wurde zu früh übersprungen (${elapsed}ms, Limit war ${AFK_TIMEOUT_MS}ms) - das AFK-Timeout wurde offenbar nicht abgewartet`
    );
    assert(
      afterState.phase !== 'playing' || afterState.currentTurnId !== myId,
      'Der Zug sollte nach dem AFK-Timeout automatisch weitergegangen sein'
    );
    assert(!bluffCalledAgainstMe, 'Der Server darf NIE automatisch "Bluff!" gegen eine andere Person rufen, wenn die AFK-Person eigentlich hätte reagieren sollen');

    console.log(`OK: afk-timeout.test.js - aktiviert (Zug nach ${elapsed}ms automatisch übersprungen)`);
  } finally {
    await stopServer(proc);
  }
}

async function testDisabled() {
  const PORT = 3911;
  const proc = await startServer(PORT, FAST_ENV);
  try {
    const url = `http://localhost:${PORT}`;
    const host = await connectClient(url);
    let latestState = null;
    host.on('gameState', (s) => { latestState = s; });

    const created = await emitAsync(host, 'createRoom', { name: 'AFKHuman2' });
    assert(created.ok, `createRoom fehlgeschlagen: ${JSON.stringify(created)}`);
    const myId = created.playerId;

    host.emit('updateSettings', { afkTimeoutEnabled: false });
    host.emit('fillBots');
    await waitForState(host, (s) => s.players.length === 2 && s.settings.afkTimeoutEnabled === false);
    host.emit('startGame');

    await waitForState(host, (s) => s.phase === 'playing' && s.currentTurnId === myId, 15000);

    // Deutlich länger als AFK_TIMEOUT_MS warten, ohne selbst zu handeln - bei
    // abgeschaltetem Timeout darf der Server NICHT automatisch für uns handeln.
    await new Promise((resolve) => setTimeout(resolve, AFK_TIMEOUT_MS * 4));

    assert(latestState.phase === 'playing' && latestState.currentTurnId === myId,
      'Bei abgeschaltetem AFK-Timeout sollte der Zug NICHT automatisch weitergegangen sein');

    console.log('OK: afk-timeout.test.js - abgeschaltet (kein automatischer Zug)');
  } finally {
    await stopServer(proc);
  }
}

async function main() {
  await testEnabled();
  await testDisabled();
}

main().catch((err) => {
  console.error('FEHLER in afk-timeout.test.js:', err);
  process.exitCode = 1;
});
