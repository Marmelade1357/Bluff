// Regressionstest: Host überspringen + Host-Übergabe (ersetzt den früheren
// AFK-Auto-Zug). Eine verbundene, untätige Person wird NIE automatisch
// bewegt - erst nach Wartezeit darf der Host sie überspringen. Fällt der
// Host aus, geht die Host-Rolle an den nächsten verbundenen Menschen.

const { startServer, stopServer, connectClient, emitAsync, waitForState, assert } = require('./helpers');

const PORT = 3940;
const MIN_PLAYERS = 2;
const SKIP_MS = 500;
const ENV = { SKIP_MIN_WAIT_MS: String(SKIP_MS), HOST_HANDOVER_MS: '400', BOT_DELAY_MIN_MS: '20', BOT_DELAY_MAX_MS: '40' };

async function until(sock, pred, ms = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (sock._last && pred(sock._last)) return sock._last;
    await new Promise((r) => setTimeout(r, 30));
  }
  throw new Error('Timeout beim Warten auf einen bestimmten Spielzustand');
}

async function setup(url) {
  const host = await connectClient(url);
  host.on('gameState', (s) => { host._last = s; });
  const created = await emitAsync(host, 'createRoom', { name: 'Host' });
  assert(created.ok, 'createRoom fehlgeschlagen');
  const guest = await connectClient(url);
  guest.on('gameState', (s) => { guest._last = s; });
  const joined = await emitAsync(guest, 'joinRoom', { code: created.code, name: 'Gast' });
  assert(joined.ok, 'joinRoom fehlgeschlagen');
  
  for (let i = 2; i < MIN_PLAYERS; i++) host.emit('addBot');
  await waitForState(host, (s) => s.players.length >= MIN_PLAYERS);
  host.emit('startGame');
  
  return { host, guest, hostId: created.playerId, guestId: joined.playerId };
}

async function testSkip() {
  const proc = await startServer(PORT, ENV);
  try {
    const url = `http://localhost:${PORT}`;
    const { host, guest, hostId, guestId } = await setup(url);
    let st = await until(host, (s) => s.waiting && s.waiting.ids.length > 0, 30000);
    
    st = await until(host, (s) => s.waiting && s.waiting.ids.length === 1, 10000);
    const waitedId = st.waiting.ids[0];
    const skipper = waitedId === hostId ? guest : host;
    // zu früh -> nichts passiert
    skipper.emit('skipTurn');
    await new Promise((r) => setTimeout(r, 200));
    const still = await until(host, (s) => !!s.waiting, 2000);
    assert(still.waiting.ids[0] === waitedId, 'Zu frühes Überspringen darf nichts bewirken');
    // Der Spieler bleibt untätig: KEIN automatischer Zug in der Wartezeit
    await new Promise((r) => setTimeout(r, SKIP_MS));
    skipper.emit('skipTurn');
    const after = await until(host, (s) => !s.waiting || s.waiting.ids[0] !== waitedId || s.waiting.elapsedMs < 250, 8000);
    assert(after, 'Überspringen nach der Wartezeit hätte den Zug weitergeben müssen');
    console.log('OK: skip-and-host.test.js - Überspringen');
  } finally { await stopServer(proc); }
}

async function testHandover() {
  const proc = await startServer(PORT + 1, ENV);
  try {
    const url = `http://localhost:${PORT + 1}`;
    const { host, guest, hostId, guestId } = await setup(url);
    await until(guest, (s) => s.phase !== 'lobby', 30000);
    host.disconnect();
    const st = await until(guest, (s) => s.hostId === guestId, 5000);
    assert(st.hostId === guestId && st.hostId !== hostId, 'Host-Rolle sollte an den Gast übergehen');
    console.log('OK: skip-and-host.test.js - Host-Übergabe');
  } finally { await stopServer(proc); }
}

(async () => {
  await testSkip();
  await testHandover();
  process.exit(0);
})().catch((e) => { console.error('FEHLER in skip-and-host.test.js:', e); process.exit(1); });
