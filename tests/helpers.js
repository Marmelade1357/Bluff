// Kleine Hilfsfunktionen für die Integrationstests unter tests/.
//
// Diese Tests starten den echten server.js als Kindprozess auf einem
// Test-Port und steuern das Spiel über einen echten socket.io-client - genau
// wie ein Browser es tun würde.

const { spawn } = require('child_process');
const path = require('path');
const { io } = require('socket.io-client');

function startServer(port, extraEnv) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
      env: Object.assign({}, process.env, { PORT: String(port) }, extraEnv || {}),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let started = false;
    const onData = (data) => {
      if (!started && data.toString().includes('läuft auf Port')) {
        started = true;
        proc.stdout.off('data', onData);
        resolve(proc);
      }
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', (d) => process.stderr.write(`[server:${port}] ${d}`));
    proc.on('error', reject);
    proc.on('exit', (code) => {
      if (!started) reject(new Error(`Server (Port ${port}) beendete sich vorzeitig mit Code ${code}`));
    });
    setTimeout(() => { if (!started) reject(new Error('Timeout beim Serverstart')); }, 8000);
  });
}

function stopServer(proc) {
  return new Promise((resolve) => {
    if (!proc || proc.killed) return resolve();
    proc.once('exit', () => resolve());
    proc.kill();
    setTimeout(resolve, 2000);
  });
}

function connectClient(url) {
  return new Promise((resolve, reject) => {
    const socket = io(url, { transports: ['websocket'], reconnection: false });
    const timer = setTimeout(() => reject(new Error('Timeout beim Verbinden mit dem Server')), 5000);
    socket.once('connect', () => { clearTimeout(timer); resolve(socket); });
    socket.once('connect_error', (err) => { clearTimeout(timer); reject(err); });
  });
}

function emitAsync(socket, event, payload) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout bei Event "${event}"`)), 5000);
    socket.emit(event, payload, (res) => { clearTimeout(timer); resolve(res); });
  });
}

function waitForState(socket, predicate, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off('gameState', handler);
      reject(new Error('Timeout beim Warten auf einen bestimmten Spielzustand'));
    }, timeoutMs);
    function handler(state) {
      if (predicate(state)) {
        clearTimeout(timer);
        socket.off('gameState', handler);
        resolve(state);
      }
    }
    socket.on('gameState', handler);
  });
}

// Hängt einen simplen "Autopilot" an einen Test-Client: sobald er am Zug ist,
// eröffnet er (falls nötig) mit seiner häufigsten Kartensorte oder legt eine
// beliebige Karte auf den bestehenden Stapel - nie ruft er "Bluff!", damit
// der Testablauf deterministisch bleibt (die echten Bots im Raum tun das
// bereits selbstständig).
function attachAutopilot(socket, getMyId) {
  let myHand = [];
  let lastState = null;

  function maybeAct() {
    const state = lastState;
    const myId = getMyId();
    if (!state || !myId) return;
    if (state.phase !== 'playing' || state.currentTurnId !== myId) return;
    if (!myHand.length) return;

    if (state.isPileEmpty) {
      const rank = state.claimableRanks[Math.floor(Math.random() * state.claimableRanks.length)];
      const cardIds = [myHand[0].id];
      socket.emit('startPile', { rank, cardIds });
    } else {
      const cardIds = [myHand[0].id];
      socket.emit('playCards', { cardIds });
    }
  }

  socket.on('yourHand', (h) => {
    myHand = h.hand || [];
    maybeAct();
  });

  socket.on('gameState', (state) => {
    lastState = state;
    maybeAct();
  });
}

function assert(condition, message) {
  if (!condition) throw new Error(`Assertion fehlgeschlagen: ${message}`);
}

module.exports = { startServer, stopServer, connectClient, emitAsync, waitForState, attachAutopilot, assert };
