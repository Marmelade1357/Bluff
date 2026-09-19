(function () {
  // Ermittelt automatisch, unter welchem Pfad-Präfix diese Seite gerade läuft
  // (z.B. "" bei direktem Zugriff, "/bluff" wenn über einen gemeinsamen
  // Reverse-Proxy/Hub unter einem Unterpfad eingebunden).
  const MOUNT_PREFIX = window.location.pathname.replace(/\/[^/]*$/, '');
  const socket = io({ path: MOUNT_PREFIX + '/socket.io/' });

  if (MOUNT_PREFIX) {
    const backHub = document.getElementById('btn-back-hub-home');
    if (backHub) {
      backHub.href = '/';
      backHub.classList.remove('hidden');
    }
  }

  const SESSION_KEY = 'bluff_session';
  const MAX_CARDS_PER_PLAY = 3; // Man darf pro Zug höchstens 3 Karten legen.
  const RANK_LABELS = { J: 'Bube', Q: 'Dame', K: 'König', A: 'Ass' };
  const SUIT_INFO = {
    pik: { symbol: '♠' },
    kreuz: { symbol: '♣' },
    herz: { symbol: '♥' },
    karo: { symbol: '♦' },
  };

  let session = null; // { code, playerId, token, name }
  let latestState = null;
  let selectedCardIds = new Set();
  let selectedRank = null;
  let lastTurnKey = null;
  let prevPhase = null;
  let diceShownForRound = null;

  // ---------------------------------------------------------------------
  // Sound & Vibration - kurzer Hinweis, sobald man selbst am Zug ist (Karte
  // legen oder "Bluff!" rufen). Rein synthetisch per Web Audio API erzeugt
  // (kein Audio-Asset nötig) und mit navigator.vibrate() kombiniert - beides
  // rein additiv: fehlt die API oder wird sie blockiert (z.B. Autoplay-
  // Policy vor der ersten Nutzerinteraktion), passiert einfach nichts.
  // ---------------------------------------------------------------------

  const MUTE_KEY = 'bluff_muted';
  let soundMuted = false;
  try { soundMuted = localStorage.getItem(MUTE_KEY) === '1'; } catch (e) { soundMuted = false; }

  function updateMuteButton() {
    const btn = $('btn-mute');
    if (!btn) return;
    btn.textContent = soundMuted ? '🔇' : '🔊';
    btn.title = soundMuted ? 'Ton einschalten' : 'Ton stummschalten';
  }

  let audioCtx = null;
  function getAudioCtx() {
    if (audioCtx) return audioCtx;
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (Ctx) audioCtx = new Ctx();
    } catch (e) { audioCtx = null; }
    return audioCtx;
  }

  function playTone(freq, duration, delay, volume) {
    if (soundMuted) return;
    const ctx = getAudioCtx();
    if (!ctx) return;
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    try {
      const t0 = ctx.currentTime + (delay || 0);
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = freq;
      osc.type = 'sine';
      gain.gain.setValueAtTime(0, t0);
      gain.gain.linearRampToValueAtTime(volume || 0.15, t0 + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t0);
      osc.stop(t0 + duration + 0.02);
    } catch (e) { /* Sound ist rein kosmetisch - Fehler einfach ignorieren */ }
  }

  function playTurnAlert() { playTone(660, 0.1, 0, 0.14); playTone(880, 0.12, 0.1, 0.14); }

  function vibrate(pattern) {
    if (navigator.vibrate) {
      try { navigator.vibrate(pattern); } catch (e) { /* Vibration ist optional */ }
    }
  }

  // ---------------------------------------------------------------------
  // Screen Wake Lock - verhindert, dass sich das Handy während des Spiels
  // von selbst abschaltet/sperrt (z.B. während man auf seinen Zug wartet).
  // Rein additiv: fehlt die API, wird die Anfrage abgelehnt (z.B. Tab im
  // Hintergrund) oder ist der Akkusparmodus aktiv, passiert einfach nichts -
  // die Spiellogik hängt nie davon ab.
  // ---------------------------------------------------------------------

  let wakeLock = null;
  async function requestWakeLock() {
    if (!('wakeLock' in navigator)) return;
    try {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    } catch (e) { /* z.B. Tab nicht sichtbar oder nicht unterstützt - ignorieren */ }
  }
  function releaseWakeLock() {
    if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
  }
  document.addEventListener('visibilitychange', () => {
    const homeScreen = document.getElementById('screen-home');
    const onHomeScreen = homeScreen && !homeScreen.classList.contains('hidden');
    if (document.visibilityState === 'visible' && !onHomeScreen) requestWakeLock();
  });

  // ---------------------------------------------------------------------
  // Helfer
  // ---------------------------------------------------------------------

  function $(id) { return document.getElementById(id); }
  function show(elm) { elm.classList.remove('hidden'); }
  function hide(elm) { elm.classList.add('hidden'); }
  function showScreen(id) {
    document.querySelectorAll('.screen').forEach((s) => hide(s));
    show($(id));
    if (id === 'screen-home') releaseWakeLock(); else requestWakeLock();
  }

  // Zwei-Klick-Bestätigung für eine Aktion, die man nicht aus Versehen
  // auslösen sollte (z.B. das Spiel verlassen) - analog zum bestehenden
  // Muster bei "Bot/Spieler entfernen": erster Klick versetzt den Button für
  // ein paar Sekunden in einen "Sicher?"-Zustand, erst der zweite Klick
  // innerhalb dieses Fensters führt die Aktion wirklich aus.
  function attachConfirmClick(btn, onConfirm) {
    if (!btn) return;
    const originalText = btn.textContent;
    let confirmTimer = null;
    const reset = () => { clearTimeout(confirmTimer); confirmTimer = null; btn.classList.remove('danger'); btn.textContent = originalText; };
    btn.addEventListener('click', () => {
      if (confirmTimer) { reset(); onConfirm(); return; }
      btn.classList.add('danger');
      btn.textContent = 'Sicher?';
      confirmTimer = setTimeout(reset, 3000);
    });
  }

  let toastTimer = null;
  function toast(msg) {
    const t = $('toast');
    t.textContent = msg;
    show(t);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => hide(t), 3200);
  }

  function saveSession() { localStorage.setItem(SESSION_KEY, JSON.stringify(session)); }
  function clearSession() { localStorage.removeItem(SESSION_KEY); session = null; }
  function loadSession() {
    try {
      const raw = localStorage.getItem(SESSION_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }

  function myId() { return session ? session.playerId : null; }

  function el(tag, opts, children) {
    const e = document.createElement(tag);
    if (opts) {
      Object.entries(opts).forEach(([k, v]) => {
        if (k === 'class') e.className = v;
        else if (k === 'text') e.textContent = v;
        else if (k === 'html') e.innerHTML = v;
        else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
        else e.setAttribute(k, v);
      });
    }
    (children || []).forEach((c) => e.appendChild(c));
    return e;
  }

  function playerName(state, id) {
    const p = (state.players || []).find((pl) => pl.id === id);
    return p ? p.name : '?';
  }

  function rankLabel(rank) { return RANK_LABELS[rank] || rank; }

  function cardLabel(card) {
    const info = SUIT_INFO[card.suit];
    return `${rankLabel(card.rank)} ${info ? info.symbol : ''}`.trim();
  }

  function renderCardFace(card) {
    const img = el('img', { class: 'pcard-img', src: `cards/${card.suit}-${card.rank}.png`, alt: cardLabel(card), draggable: 'false' });
    const div = el('div', { class: 'pcard' }, [img]);
    div.dataset.cardId = card.id;
    return div;
  }

  function renderCardBack() {
    const img = el('img', { class: 'pcard-img', src: 'cards/card-back.png', alt: 'Verdeckte Karte', draggable: 'false' });
    return el('div', { class: 'pcard-back' }, [img]);
  }

  // ---------------------------------------------------------------------
  // Start-Bildschirm
  // ---------------------------------------------------------------------

  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      document.querySelectorAll('.tab-panel').forEach((p) => hide(p));
      show($('tab-' + btn.dataset.tab));
    });
  });

  $('btn-create').addEventListener('click', () => {
    const name = $('create-name').value.trim();
    if (!name) return toast('Bitte gib deinen Namen ein.');
    socket.emit('createRoom', { name }, (res) => {
      if (!res.ok) return toast(res.error || 'Fehler beim Erstellen.');
      session = { code: res.code, playerId: res.playerId, token: res.token, name };
      saveSession();
    });
  });

  $('btn-join').addEventListener('click', () => {
    const name = $('join-name').value.trim();
    const code = $('join-code').value.trim().toUpperCase();
    if (!name) return toast('Bitte gib deinen Namen ein.');
    if (!code) return toast('Bitte gib den Raum-Code ein.');
    socket.emit('joinRoom', { code, name }, (res) => {
      if (!res.ok) return toast(res.error || 'Beitritt fehlgeschlagen.');
      session = { code: res.code, playerId: res.playerId, token: res.token, name };
      saveSession();
    });
  });

  attachConfirmClick($('btn-leave-lobby'), () => {
    socket.emit('leaveRoom');
    clearSession();
    latestState = null;
    showScreen('screen-home');
  });

  attachConfirmClick($('btn-leave-game'), () => {
    socket.emit('leaveRoom');
    clearSession();
    latestState = null;
    showScreen('screen-home');
  });

  const muteBtn = $('btn-mute');
  if (muteBtn) {
    muteBtn.addEventListener('click', () => {
      soundMuted = !soundMuted;
      try { localStorage.setItem(MUTE_KEY, soundMuted ? '1' : '0'); } catch (e) { /* localStorage optional */ }
      updateMuteButton();
    });
    updateMuteButton();
  }

  $('btn-add-bot').addEventListener('click', () => socket.emit('addBot'));
  $('btn-fill-bots').addEventListener('click', () => socket.emit('fillBots'));
  $('btn-start').addEventListener('click', () => socket.emit('startGame'));

  $('setting-deck-range').addEventListener('change', (e) => socket.emit('updateSettings', { deckRange: e.target.value }));
  $('setting-deck-count').addEventListener('change', (e) => socket.emit('updateSettings', { deckCount: Number(e.target.value) }));
  $('setting-jack-minus').addEventListener('click', () => {
    if (!latestState) return;
    const next = Math.max(0, latestState.settings.jackCount - 1);
    socket.emit('updateSettings', { jackCount: next });
  });
  $('setting-jack-plus').addEventListener('click', () => {
    if (!latestState) return;
    const max = latestState.maxJackCount != null ? latestState.maxJackCount : 4;
    const next = Math.min(max, latestState.settings.jackCount + 1);
    socket.emit('updateSettings', { jackCount: next });
  });

  [['btn-show-rules-lobby', 'rules-modal'], ['btn-show-rules', 'rules-modal'], ['btn-show-history', 'history-modal']].forEach(([btnId, modalId]) => {
    $(btnId).addEventListener('click', () => {
      if (modalId === 'history-modal' && latestState) renderHistoryModal(latestState);
      show($(modalId));
    });
  });
  $('btn-close-rules-modal').addEventListener('click', () => hide($('rules-modal')));
  $('btn-close-history-modal').addEventListener('click', () => hide($('history-modal')));

  // ---------------------------------------------------------------------
  // Socket-Events
  // ---------------------------------------------------------------------

  socket.on('connect', () => {
    const saved = loadSession();
    if (saved && saved.code && saved.token) {
      session = saved;
      socket.emit('joinRoom', { code: saved.code, name: saved.name, token: saved.token }, (res) => {
        if (!res.ok) {
          clearSession();
          showScreen('screen-home');
        } else {
          session.playerId = res.playerId;
          session.token = res.token;
          saveSession();
        }
      });
    }
  });

  let myHand = [];
  let handOrder = []; // Karten-IDs in der Reihenfolge, die der Spieler selbst per Drag&Drop festgelegt hat

  const AUTO_SORT_KEY = 'bluff_autosort';
  let autoSortEnabled = localStorage.getItem(AUTO_SORT_KEY) === '1';
  const RANK_ORDER = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
  const SUIT_ORDER = ['pik', 'herz', 'karo', 'kreuz'];

  function sortHandOrderByRank() {
    const sorted = myHand.slice().sort((a, b) => {
      const ra = RANK_ORDER.indexOf(a.rank), rb = RANK_ORDER.indexOf(b.rank);
      if (ra !== rb) return ra - rb;
      return SUIT_ORDER.indexOf(a.suit) - SUIT_ORDER.indexOf(b.suit);
    });
    handOrder = sorted.map((c) => c.id);
  }

  function syncHandOrder() {
    const ids = myHand.map((c) => c.id);
    const idSet = new Set(ids);
    handOrder = handOrder.filter((id) => idSet.has(id));
    ids.forEach((id) => { if (!handOrder.includes(id)) handOrder.push(id); });
  }

  function orderedHand() {
    const byId = new Map(myHand.map((c) => [c.id, c]));
    return handOrder.map((id) => byId.get(id)).filter(Boolean);
  }

  const autoSortCheckbox = $('auto-sort-toggle');
  autoSortCheckbox.checked = autoSortEnabled;
  autoSortCheckbox.addEventListener('change', () => {
    autoSortEnabled = autoSortCheckbox.checked;
    localStorage.setItem(AUTO_SORT_KEY, autoSortEnabled ? '1' : '0');
    if (autoSortEnabled) sortHandOrderByRank();
    if (latestState) render(latestState);
  });

  socket.on('yourHand', (data) => {
    myHand = data.hand || [];
    const validIds = new Set(myHand.map((c) => c.id));
    selectedCardIds.forEach((id) => { if (!validIds.has(id)) selectedCardIds.delete(id); });
    if (autoSortEnabled) sortHandOrderByRank(); else syncHandOrder();
    if (latestState) render(latestState);
  });

  let notifiedTurnKey = null;
  function maybeNotifyMyTurn(state) {
    if (state.phase !== 'playing' || state.currentTurnId !== myId()) return;
    const key = `${state.currentTurnId}|${state.isPileEmpty}|${state.pile ? state.pile.length : 0}`;
    if (key === notifiedTurnKey) return;
    notifiedTurnKey = key;
    playTurnAlert();
    vibrate(120);
  }

  socket.on('gameState', (state) => {
    latestState = state;
    maybeNotifyMyTurn(state);
    render(state);
  });

  // ---------------------------------------------------------------------
  // Render-Dispatcher
  // ---------------------------------------------------------------------

  function render(state) {
    const turnKey = state.currentTurnId + '|' + state.isPileEmpty;
    if (turnKey !== lastTurnKey) {
      selectedCardIds.clear();
      selectedRank = null;
      lastTurnKey = turnKey;
    }

    if (state.phase === 'lobby') {
      diceShownForRound = null;
      showScreen('screen-lobby');
      renderLobby(state);
      return;
    }
    showScreen('screen-game');
    renderGame(state);
    prevPhase = state.phase;
  }

  // ---------------------------------------------------------------------
  // Lobby
  // ---------------------------------------------------------------------

  function makeRemovePlayerButton(p) {
    const label = p.isBot ? 'Bot' : 'Spieler';
    const btn = el('button', { class: 'remove-bot-btn', text: '✕', title: `${label} entfernen` });
    let confirmTimer = null;
    const reset = () => { clearTimeout(confirmTimer); btn.classList.remove('confirm'); btn.textContent = '✕'; };
    btn.addEventListener('click', () => {
      if (!btn.classList.contains('confirm')) {
        btn.classList.add('confirm');
        btn.textContent = 'Sicher?';
        confirmTimer = setTimeout(reset, 3000);
        return;
      }
      reset();
      if (p.isBot) socket.emit('removeBot', { botId: p.id });
      else socket.emit('kickPlayer', { playerId: p.id });
    });
    return btn;
  }

  function renderLobby(state) {
    $('lobby-code').textContent = state.code;
    $('lobby-count').textContent = state.players.length;

    const list = $('lobby-players');
    list.innerHTML = '';
    state.players.forEach((p) => {
      const tags = [];
      if (p.isHost) tags.push(el('span', { class: 'tag host', text: 'Host' }));
      if (p.isBot) tags.push(el('span', { class: 'tag', text: '🤖 Bot' }));
      if (!p.connected && !p.isBot) tags.push(el('span', { class: 'tag', text: 'getrennt' }));
      const li = el('li', { class: !p.connected && !p.isBot ? 'disconnected' : '' }, [
        el('span', { class: 'player-name' }, [el('span', { text: p.name }), ...tags]),
      ]);
      const isHost = state.hostId === myId();
      if (isHost && p.id !== state.hostId) li.appendChild(makeRemovePlayerButton(p));
      list.appendChild(li);
    });

    const isHost = state.hostId === myId();
    const botControls = $('lobby-bot-controls');
    const fillBtn = $('btn-fill-bots');
    if (isHost) {
      show(botControls);
      if (state.players.length < state.minPlayers) show(fillBtn); else hide(fillBtn);
    } else {
      hide(botControls);
    }

    const deckSettings = $('deck-settings');
    const deckReadonly = $('deck-settings-readonly');
    if (isHost) {
      show(deckSettings);
      hide(deckReadonly);
      $('setting-deck-range').value = state.settings.deckRange;
      $('setting-deck-count').value = String(state.settings.deckCount);
      $('setting-jack-value').textContent = state.settings.jackCount;
      $('setting-jack-minus').disabled = state.settings.jackCount <= 0;
      $('setting-jack-plus').disabled = state.settings.jackCount >= state.maxJackCount;
    } else {
      hide(deckSettings);
      show(deckReadonly);
      deckReadonly.textContent = `🂠 Deck: ${state.settings.deckRange} Karten` +
        (state.settings.deckCount > 1 ? ` × ${state.settings.deckCount} Decks` : '') +
        `, ${state.settings.jackCount} Buben (${state.deckSize} Karten gesamt).`;
    }

    const startBtn = $('btn-start');
    const statusEl = $('lobby-status');
    const enoughCards = state.deckSize >= state.players.length;
    if (isHost) {
      const canStart = state.players.length >= state.minPlayers && state.players.length <= state.maxPlayers && enoughCards;
      if (canStart) {
        show(startBtn);
        statusEl.textContent = '';
      } else {
        hide(startBtn);
        statusEl.textContent = !enoughCards
          ? 'Zu wenige Karten im Deck für so viele Spieler – Deckgröße in den Einstellungen erhöhen.'
          : `Mindestens ${state.minPlayers} Spieler nötig (max. ${state.maxPlayers}).`;
      }
    } else {
      hide(startBtn);
      statusEl.textContent = 'Warte, bis der Host das Spiel startet …';
    }
  }

  // ---------------------------------------------------------------------
  // Spiel: der Tisch
  // ---------------------------------------------------------------------

  function renderGame(state) {
    $('game-code').textContent = state.code;
    $('round-badge').textContent = state.roundNumber ? `Runde ${state.roundNumber}` : '';

    renderSeats(state);
    renderPlayerPanel(state);
    renderPile(state);
    renderDice(state);
    renderReveal(state);
    renderActionBar(state);
    renderHandBar(state);
    renderRoundEnd(state);
  }

  function renderPlayerPanel(state) {
    const list = $('player-panel-list');
    list.innerHTML = '';
    const order = layoutOrder(state);
    order.forEach((p) => {
      const classes = ['player-panel-row'];
      if (p.id === myId()) classes.push('me');
      if (state.currentTurnId === p.id && (state.phase === 'playing' || state.phase === 'reveal')) classes.push('active');
      if (!p.connected && !p.isBot) classes.push('disconnected');
      if (p.finished) classes.push('finished');

      const tags = [];
      if (p.isHost) tags.push(el('span', { class: 'tag host', text: 'Host' }));
      if (p.isBot) tags.push(el('span', { class: 'tag', text: '🤖' }));

      const nameEl = el('span', { class: 'player-panel-name' }, [
        el('span', { text: p.name }),
        ...tags,
      ]);

      let countLabel;
      if (state.phase !== 'lobby' && p.finished) {
        const isRoundLoser = state.phase === 'roundend' && p.id === state.finishedOrder[state.finishedOrder.length - 1] && p.handCount > 0;
        countLabel = isRoundLoser ? '😬' : `🏅 ${p.place}`;
      } else {
        countLabel = `🂠 ${p.handCount}`;
      }
      const countEl = el('span', { class: 'player-panel-count', text: countLabel });

      list.appendChild(el('li', { class: classes.join(' ') }, [nameEl, countEl]));
    });
  }

  function layoutOrder(state) {
    const n = state.players.length;
    const mi = state.players.findIndex((p) => p.id === myId());
    const startIdx = mi >= 0 ? mi : 0;
    const order = [];
    for (let k = 0; k < n; k++) order.push(state.players[(startIdx + k) % n]);
    return order;
  }

  function renderSeats(state) {
    const layer = $('seats-layer');
    layer.innerHTML = '';
    const order = layoutOrder(state);
    const n = order.length;
    const RX = 42, RY = 40; // % vom Oval-Radius

    order.forEach((p, k) => {
      const angleDeg = 90 + (k * 360) / n;
      const rad = (angleDeg * Math.PI) / 180;
      const x = 50 + Math.cos(rad) * RX;
      const y = 50 + Math.sin(rad) * RY;

      const classes = ['seat'];
      if (p.id === myId()) classes.push('me');
      if (state.currentTurnId === p.id && (state.phase === 'playing' || state.phase === 'reveal')) classes.push('active-turn');
      if (!p.connected && !p.isBot) classes.push('disconnected');
      if (p.finished) classes.push('finished');

      const initial = p.isBot ? '🤖' : (p.name || '?').trim().charAt(0).toUpperCase();
      const avatar = el('div', { class: 'seat-avatar', text: initial });

      const tags = [];
      if (p.isHost) tags.push(el('span', { class: 'tag host', text: 'Host' }));
      const tagsRow = el('div', { class: 'seat-tags' }, tags);

      let statusEl;
      if (state.phase !== 'lobby' && p.finished) {
        const isRoundLoser = state.phase === 'roundend' && p.id === state.finishedOrder[state.finishedOrder.length - 1] && p.handCount > 0;
        statusEl = isRoundLoser
          ? el('div', { class: 'seat-place', text: '😬 Verliert' })
          : el('div', { class: 'seat-place', text: `🏅 Platz ${p.place}` });
      } else {
        statusEl = el('div', { class: 'seat-hand-count', text: `🂠 × ${p.handCount}` });
      }

      const seat = el('div', { class: classes.join(' ') }, [
        avatar,
        el('div', { class: 'seat-name', text: p.name }),
        tagsRow,
        statusEl,
      ]);
      seat.style.left = x + '%';
      seat.style.top = y + '%';
      layer.appendChild(seat);
    });
  }

  function renderPile(state) {
    const stack = $('pile-stack');
    const countEl = $('pile-count');
    const claimEl = $('claim-line');
    stack.innerHTML = '';

    if (state.pileTotalCount > 0) {
      const layers = Math.min(6, state.pile.length);
      for (let i = 0; i < layers; i++) {
        const back = renderCardBack();
        back.style.transform = `translate(${i * 2}px, ${-i * 2}px) rotate(${(i % 2 === 0 ? -1 : 1) * (2 + i)}deg)`;
        stack.appendChild(back);
      }
      show(countEl);
      countEl.textContent = String(state.pileTotalCount);
    } else {
      hide(countEl);
    }

    if (state.pile.length > 0 && state.requiredRank) {
      const last = state.pile[state.pile.length - 1];
      claimEl.textContent = `${playerName(state, last.playerId)} behauptet: ${last.claimedCount}× ${rankLabel(state.requiredRank)}`;
    } else if (state.phase === 'playing' && state.currentTurnId) {
      claimEl.textContent = state.currentTurnId === myId()
        ? 'Du eröffnest – wähle eine Sorte und lege Karten ab.'
        : `${playerName(state, state.currentTurnId)} eröffnet den Stapel …`;
    } else {
      claimEl.textContent = '';
    }
  }

  function renderDice(state) {
    const overlay = $('dice-overlay');
    if (state.roundNumber === 1 && state.diceRoll && prevPhase === 'lobby' && diceShownForRound !== 1) {
      diceShownForRound = 1;
      const list = $('dice-list');
      list.innerHTML = '';
      const rolls = state.diceRoll.rolls || {};
      state.players.forEach((p) => {
        const li = el('li', { class: state.diceRoll.starterId === p.id ? 'winner' : '' }, [
          el('span', { text: p.name }),
          el('span', { text: `🎲 ${rolls[p.id] != null ? rolls[p.id] : '–'}` }),
        ]);
        list.appendChild(li);
      });
      $('dice-title').textContent = `${playerName(state, state.diceRoll.starterId)} würfelt am höchsten und fängt an!`;
      show(overlay);
      setTimeout(() => hide(overlay), 3800);
    }
  }

  function renderReveal(state) {
    const overlay = $('reveal-overlay');
    if (state.phase === 'reveal' && state.lastReveal) {
      const r = state.lastReveal;
      const cardsEl = $('reveal-cards');
      cardsEl.innerHTML = '';
      (r.revealedCards || []).forEach((c) => cardsEl.appendChild(c && c.suit ? renderCardFace(c) : renderCardBack()));
      const textEl = $('reveal-text');
      const accuserName = playerName(state, r.accuserId);
      const targetName = playerName(state, r.targetId);
      const hiddenNoteEl = $('reveal-hidden-note');
      if (r.accuserId === myId()) {
        hide(hiddenNoteEl);
      } else {
        hiddenNoteEl.textContent = `🙈 Nur ${accuserName} hat die Karten aufgedeckt gesehen.`;
        show(hiddenNoteEl);
      }
      if (r.wasLie) {
        textEl.className = 'reveal-text lie';
        textEl.textContent = `❌ Gelogen! ${targetName} behauptete ${r.claimedCount}× ${rankLabel(r.claimedRank)}, hatte aber andere Karten. ${targetName} nimmt ${r.pileSize} Karte(n) auf – ${accuserName} hat den Bluff erkannt und eröffnet neu.`;
      } else {
        textEl.className = 'reveal-text truth';
        textEl.textContent = `✅ Das war die Wahrheit! ${targetName} hatte wirklich ${r.claimedCount}× ${rankLabel(r.claimedRank)}. ${accuserName} lag falsch und nimmt ${r.pileSize} Karte(n) auf.`;
      }
      show(overlay);
    } else {
      hide(overlay);
    }
  }

  function renderActionBar(state) {
    const bar = $('action-bar');
    const content = $('action-bar-content');
    content.innerHTML = '';

    const myTurn = state.phase === 'playing' && state.currentTurnId === myId();
    // Die Ansage ("X behauptet: 2× Fünfen") steht als feste Zeile über der
    // Handleiste - auch wenn man nicht am Zug ist.
    const hasClaim = state.phase === 'playing' && !!$('claim-line').textContent;
    if (!myTurn && !hasClaim) { hide(bar); document.body.classList.remove('turn-bar-open'); return; }
    show(bar);
    content.classList.toggle('hidden', !myTurn);
    document.body.classList.toggle('turn-bar-open', myTurn);
    if (!myTurn) return;

    if (state.isPileEmpty) {
      content.appendChild(el('p', { class: 'action-bar-note', text: `Wähle die Sorte, die du ansagst, und dann 1-${MAX_CARDS_PER_PLAY} Karten aus deiner Hand.` }));
      const rankRow = el('div', { class: 'rank-choice' });
      (state.claimableRanks || []).forEach((r) => {
        const b = el('button', { class: 'rank-btn' + (selectedRank === r ? ' selected' : ''), text: rankLabel(r) });
        b.addEventListener('click', () => { selectedRank = r; render(state); });
        rankRow.appendChild(b);
      });
      content.appendChild(rankRow);

      const playBtn = el('button', { class: 'btn primary wide', text: `Verdeckt ablegen (${selectedCardIds.size} Karte${selectedCardIds.size === 1 ? '' : 'n'})` });
      playBtn.disabled = !selectedRank || selectedCardIds.size === 0;
      playBtn.addEventListener('click', () => {
        socket.emit('startPile', { rank: selectedRank, cardIds: Array.from(selectedCardIds) });
        selectedCardIds.clear();
        selectedRank = null;
      });
      content.appendChild(el('div', { class: 'action-buttons' }, [playBtn]));
    } else {
      content.appendChild(el('p', { class: 'action-bar-note', text: `Angesagte Sorte: ${rankLabel(state.requiredRank)}. Lege 1-${MAX_CARDS_PER_PLAY} Karten nach oder rufe "Bluff!" auf den letzten Zug.` }));
      const playBtn = el('button', { class: 'btn primary', text: `Nachlegen (${selectedCardIds.size})` });
      playBtn.disabled = selectedCardIds.size === 0;
      playBtn.addEventListener('click', () => {
        socket.emit('playCards', { cardIds: Array.from(selectedCardIds) });
        selectedCardIds.clear();
      });
      const bluffBtn = el('button', { class: 'btn danger', text: '🚨 Bluff rufen!' });
      bluffBtn.addEventListener('click', () => socket.emit('callBluff'));
      content.appendChild(el('div', { class: 'action-buttons' }, [playBtn, bluffBtn]));
    }
  }

  function renderHandBar(state) {
    const bar = $('hand-bar');
    if (!myHand.length || state.phase === 'roundend') { hide(bar); return; }
    show(bar);
    const myTurn = state.phase === 'playing' && state.currentTurnId === myId();
    $('hand-bar-label').textContent = myTurn ? 'Deine Karten – zum Auswählen antippen' : 'Deine Karten';

    const list = $('hand-list');
    list.innerHTML = '';
    orderedHand().forEach((card) => {
      const cardEl = renderCardFace(card);
      cardEl.setAttribute('draggable', autoSortEnabled ? 'false' : 'true');
      if (autoSortEnabled) cardEl.classList.add('auto-sorted');
      if (!myTurn) cardEl.classList.add('disabled');
      const isSelected = selectedCardIds.has(card.id);
      if (isSelected) cardEl.classList.add('selected');
      if (myTurn && !isSelected && selectedCardIds.size >= MAX_CARDS_PER_PLAY) cardEl.classList.add('limit-reached');
      cardEl.addEventListener('click', () => {
        if (dragMoved) { dragMoved = false; return; } // Klick am Ende eines Drags nicht als Auswahl werten
        if (!myTurn) return;
        if (selectedCardIds.has(card.id)) selectedCardIds.delete(card.id);
        else if (selectedCardIds.size < MAX_CARDS_PER_PLAY) selectedCardIds.add(card.id);
        render(state);
      });
      list.appendChild(cardEl);
    });
    layoutHandFan(list);
  }

  // ---------------------------------------------------------------------
  // Handkarten so überlappen lassen, dass alle auf den Bildschirm passen
  // (aber immer mindestens die Eckzahl der darunterliegenden Karte sichtbar)
  // ---------------------------------------------------------------------

  const HAND_GAP = 14;
  const HAND_MIN_VISIBLE = 42; // px – genug, um Ecke mit Zahl/Symbol noch zu sehen

  function layoutHandFan(listEl) {
    const cards = Array.from(listEl.children);
    if (!cards.length) return;
    const cardWidth = cards[0].getBoundingClientRect().width || 132;
    const paddingLeft = parseFloat(getComputedStyle(listEl).paddingLeft) || 0;
    const paddingRight = parseFloat(getComputedStyle(listEl).paddingRight) || 0;
    const containerWidth = listEl.clientWidth - paddingLeft - paddingRight;

    if (cards.length <= 1) {
      cards.forEach((c) => { c.style.marginLeft = '0'; });
      return;
    }

    const neededFullWidth = cards.length * cardWidth + (cards.length - 1) * HAND_GAP;
    if (neededFullWidth <= containerWidth) {
      cards.forEach((c, i) => { c.style.marginLeft = i === 0 ? '0' : HAND_GAP + 'px'; });
      return;
    }

    let visibleSlice = (containerWidth - cardWidth) / (cards.length - 1);
    if (!isFinite(visibleSlice) || visibleSlice < HAND_MIN_VISIBLE) visibleSlice = HAND_MIN_VISIBLE;
    const overlap = cardWidth - visibleSlice;
    cards.forEach((c, i) => {
      c.style.marginLeft = i === 0 ? '0' : `-${overlap.toFixed(1)}px`;
    });
  }

  let handResizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(handResizeTimer);
    handResizeTimer = setTimeout(() => {
      const list = $('hand-list');
      if (list && list.children.length) layoutHandFan(list);
    }, 120);
  });

  // ---------------------------------------------------------------------
  // Handkarten-Vergrößerung beim Hovern (dezenter Dock-Effekt)
  // ---------------------------------------------------------------------

  function attachHandMagnify(listEl) {
    if (!listEl) return;
    const MAX_SCALE = 1.14;
    const SIGMA = 55; // px – wie schnell der Effekt mit dem Abstand abnimmt
    const MAX_LIFT = 12; // px

    function apply(mouseX, mouseY) {
      const cards = Array.from(listEl.children);
      // Bei überlappenden Karten liegt die sichtbare Ecke einer Karte oft näher
      // an der Mitte der VORHERIGEN Karte als an der eigenen (breiten) Boundingbox-
      // Mitte. Deshalb per echtem Hit-Test bestimmen, welche Karte gerade wirklich
      // unter dem Mauszeiger liegt, und die bekommt garantiert den höchsten z-index –
      // sonst könnte eine falsch "nähere" Nachbarkarte darüberliegen.
      const hitEl = document.elementFromPoint(mouseX, mouseY);
      const hitCard = hitEl ? hitEl.closest('.pcard') : null;

      cards.forEach((c) => {
        if (c.classList.contains('dragging')) return;
        const rect = c.getBoundingClientRect();
        const cx = rect.left + rect.width / 2;
        const dist = mouseX - cx;
        const falloff = Math.exp(-(dist * dist) / (2 * SIGMA * SIGMA));
        const scale = 1 + (MAX_SCALE - 1) * falloff;
        const lift = MAX_LIFT * falloff;
        const extraSelected = c.classList.contains('selected') ? 14 : 0;
        c.style.transform = `translateY(-${(lift + extraSelected).toFixed(1)}px) scale(${scale.toFixed(3)})`;
        let z = 100 + Math.round(falloff * 100);
        if (c === hitCard) z += 1000;
        c.style.zIndex = String(z);
      });
    }

    function reset() {
      Array.from(listEl.children).forEach((c) => {
        if (c.classList.contains('dragging')) return;
        c.style.transform = '';
        c.style.zIndex = '';
      });
    }

    listEl.addEventListener('mousemove', (e) => apply(e.clientX, e.clientY));
    listEl.addEventListener('mouseleave', reset);
  }

  // ---------------------------------------------------------------------
  // Handkarten selbst sortieren (per Drag & Drop)
  // ---------------------------------------------------------------------

  let dragMoved = false;

  function getDragAfterElement(container, x) {
    const els = Array.from(container.querySelectorAll('.pcard:not(.dragging)'));
    let closest = { offset: Number.NEGATIVE_INFINITY, element: null };
    els.forEach((child) => {
      const box = child.getBoundingClientRect();
      const offset = x - (box.left + box.width / 2);
      if (offset < 0 && offset > closest.offset) closest = { offset, element: child };
    });
    return closest.element;
  }

  function attachHandDragSort(listEl) {
    if (!listEl) return;

    listEl.addEventListener('dragstart', (e) => {
      const card = e.target.closest('.pcard');
      if (!card) return;
      dragMoved = false;
      // Während des Drags feuert kein mousemove mehr (native Drag&Drop) – daher
      // hier den Hover-Vergrößerungseffekt auf allen Karten zurücksetzen, sonst
      // könnte eine zuvor vergrößerte Nachbarkarte über der gezogenen Karte liegen.
      Array.from(listEl.children).forEach((c) => {
        c.style.transform = '';
        c.style.zIndex = '';
      });
      card.classList.add('dragging');
      if (e.dataTransfer) {
        e.dataTransfer.effectAllowed = 'move';
        try { e.dataTransfer.setData('text/plain', card.dataset.cardId || ''); } catch (err) { /* Safari braucht keine Daten */ }
      }
    });

    listEl.addEventListener('dragover', (e) => {
      const dragging = listEl.querySelector('.pcard.dragging');
      if (!dragging) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
      dragMoved = true;
      const after = getDragAfterElement(listEl, e.clientX);
      if (after == null) listEl.appendChild(dragging);
      else if (after !== dragging.nextSibling) listEl.insertBefore(dragging, after);
    });

    listEl.addEventListener('drop', (e) => {
      e.preventDefault();
      handOrder = Array.from(listEl.querySelectorAll('.pcard')).map((c) => c.dataset.cardId);
    });

    listEl.addEventListener('dragend', (e) => {
      const card = e.target.closest('.pcard');
      if (card) card.classList.remove('dragging');
      setTimeout(() => { dragMoved = false; }, 0);
    });
  }

  attachHandMagnify($('hand-list'));
  attachHandDragSort($('hand-list'));

  function renderRoundEnd(state) {
    const panel = $('roundend-panel');
    if (state.phase !== 'roundend') { hide(panel); return; }
    show(panel);
    $('roundend-number').textContent = state.roundNumber;

    const order = $('roundend-order');
    order.innerHTML = '';
    state.finishedOrder.forEach((id, i) => {
      const isLast = i === state.finishedOrder.length - 1;
      const label = isLast ? `${playerName(state, id)} – verliert diese Runde` : `${playerName(state, id)} – Platz ${i + 1}`;
      order.appendChild(el('li', { class: isLast ? 'loser' : '', text: label }));
    });

    const actions = $('roundend-actions');
    actions.innerHTML = '';
    if (state.hostId === myId()) {
      const nextBtn = el('button', { class: 'btn primary', text: '▶️ Nächste Runde' });
      nextBtn.addEventListener('click', () => socket.emit('nextRound'));
      const resetBtn = el('button', { class: 'btn ghost', text: '🏠 Zurück zur Lobby' });
      resetBtn.addEventListener('click', () => socket.emit('resetGame'));
      actions.appendChild(nextBtn);
      actions.appendChild(resetBtn);
    } else {
      actions.appendChild(el('p', { class: 'hint', text: `Warte auf ${playerName(state, state.hostId)} für die nächste Runde …` }));
    }
  }

  function renderHistoryModal(state) {
    const content = $('history-content');
    content.innerHTML = '';
    if (!state.history || !state.history.length) {
      content.appendChild(el('p', { class: 'hint', text: 'Noch keine Runde beendet.' }));
      return;
    }
    state.history.slice().reverse().forEach((round) => {
      const wrap = el('div', { class: 'history-round' });
      wrap.appendChild(el('div', { class: 'history-round-title', text: `Runde ${round.round}` }));
      const ol = el('ol');
      round.order.forEach((id, i) => {
        const isLast = i === round.order.length - 1;
        ol.appendChild(el('li', { text: `${playerName(state, id)}${isLast ? ' (verliert)' : ''}` }));
      });
      wrap.appendChild(ol);
      content.appendChild(wrap);
    });
  }

  // ---------------------------------------------------------------------
  // Komfort: gemerkter Name, Enter-Taste, Einladungslink, Warte-Hinweis,
  // Barrierefreiheits-Attribute
  // ---------------------------------------------------------------------
  (function comfort() {
    const NAME_KEY = 'spiele_name';
    const SKIP_AFTER_MS = 20000;
    const q = (id) => document.getElementById(id);
    const lsGet = (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } };
    const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch (e) { /* optional */ } };

    // --- Name merken ---
    const cn = q('create-name'); const jn = q('join-name'); const jc = q('join-code');
    const cached = lsGet(NAME_KEY);
    [cn, jn].forEach((inp) => {
      if (!inp) return;
      if (cached && !inp.value) inp.value = cached;
      inp.addEventListener('input', () => { const v = inp.value.trim(); if (v) { lsSet(NAME_KEY, v); [cn, jn].forEach((o) => { if (o && o !== inp) o.value = inp.value; }); } });
      inp.setAttribute('autocomplete', 'nickname');
      inp.setAttribute('autocapitalize', 'words');
      inp.setAttribute('aria-label', 'Dein Name');
      inp.setAttribute('enterkeyhint', 'go');
    });
    if (jc) {
      jc.setAttribute('autocomplete', 'off'); jc.setAttribute('autocapitalize', 'characters');
      jc.setAttribute('autocorrect', 'off'); jc.setAttribute('spellcheck', 'false');
      jc.setAttribute('aria-label', 'Raum-Code'); jc.setAttribute('enterkeyhint', 'go');
      jc.addEventListener('input', () => { jc.value = jc.value.toUpperCase().replace(/[^A-Z0-9]/g, ''); });
    }

    // --- Enter sendet ab ---
    if (cn) cn.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); q('btn-create').click(); } });
    if (jn) jn.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      if (jc && !jc.value.trim()) jc.focus(); else q('btn-join').click();
    });
    if (jc) jc.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); q('btn-join').click(); } });

    // --- Beitritt per Link (?code=AB12) ---
    try {
      const urlCode = (new URLSearchParams(window.location.search).get('code') || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
      if (urlCode && jc) {
        try {
          const s = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null');
          if (s && s.code !== urlCode) localStorage.removeItem(SESSION_KEY);
        } catch (e) { /* ignore */ }
        jc.value = urlCode;
        const tabBtn = document.querySelector('.tab-btn[data-tab="join"]');
        if (tabBtn) tabBtn.click();
        const target = (jn && !jn.value.trim()) ? jn : q('btn-join');
        if (target) setTimeout(() => target.focus(), 50);
      }
    } catch (e) { /* ignore */ }

    // --- Einladungslink kopieren ---
    async function copyText(text) {
      try { if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(text); return true; } } catch (e) { /* Fallback unten */ }
      try {
        const ta = document.createElement('textarea');
        ta.value = text; ta.setAttribute('readonly', ''); ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
        document.body.appendChild(ta); ta.select(); ta.setSelectionRange(0, text.length);
        const ok = document.execCommand('copy'); document.body.removeChild(ta); return ok;
      } catch (e) { return false; }
    }
    const share = q('btn-share-link');
    if (share) {
      share.addEventListener('click', async () => {
        const code = (q('lobby-code').textContent || '').trim();
        if (!/^[A-Z0-9]{4}$/.test(code)) return;
        const url = window.location.origin + window.location.pathname + '?code=' + code;
        if (await copyText(url)) toast('Link kopiert – jetzt einfach verschicken.');
        else window.prompt('Link zum Kopieren:', url);
      });
    }

    // --- Warte-Hinweis + "Überspringen" ---
    const gameScreen = q('screen-game');
    let banner = null; let bText = null; let bBtn = null;
    let waiting = null; let recvAt = 0; let lastState = null;
    if (gameScreen) {
      banner = document.createElement('div');
      banner.id = 'wait-banner'; banner.className = 'wait-banner hidden';
      banner.setAttribute('role', 'status'); banner.setAttribute('aria-live', 'polite');
      bText = document.createElement('span'); bText.id = 'wait-text';
      bBtn = document.createElement('button'); bBtn.id = 'btn-skip-turn'; bBtn.type = 'button';
      bBtn.className = 'btn secondary small hidden'; bBtn.textContent = '⏭ Überspringen';
      bBtn.addEventListener('click', () => { socket.emit('skipTurn'); bBtn.classList.add('hidden'); });
      banner.appendChild(bText); banner.appendChild(bBtn);
      const header = gameScreen.querySelector('header');
      if (header) header.after(banner); else gameScreen.prepend(banner);
    }
    function paintWait() {
      if (!banner) return;
      if (!waiting || !lastState || !waiting.ids.length || waiting.ids.includes(myId())) { banner.classList.add('hidden'); return; }
      const sec = Math.floor((waiting.elapsedMs + (Date.now() - recvAt)) / 1000);
      if (sec < 8) { banner.classList.add('hidden'); return; }
      const names = waiting.ids.map((id) => { const p = (lastState.players || []).find((pl) => pl.id === id); return p ? p.name : '?'; }).join(', ');
      bText.textContent = `⏳ ${names} – wartet seit ${sec} s`;
      banner.classList.remove('hidden');
      const canSkip = sec * 1000 >= SKIP_AFTER_MS && (lastState.hostId === myId() || waiting.ids.includes(lastState.hostId));
      bBtn.classList.toggle('hidden', !canSkip);
    }
    socket.on('gameState', (state) => {
      lastState = state;
      const w = state.waiting || null;
      if (w) { waiting = w; recvAt = Date.now(); } else { waiting = null; }
      paintWait();
    });
    setInterval(paintWait, 1000);

    // --- Barrierefreiheit ---
    const toastEl = q('toast');
    if (toastEl) { toastEl.setAttribute('role', 'status'); toastEl.setAttribute('aria-live', 'polite'); }
    document.querySelectorAll('.modal').forEach((m) => {
      m.setAttribute('role', 'dialog'); m.setAttribute('aria-modal', 'true');
      const h = m.querySelector('h2'); if (h) m.setAttribute('aria-label', h.textContent.trim());
    });
    document.querySelectorAll('.modal-close').forEach((b) => b.setAttribute('aria-label', 'Schließen'));
    const tabs = document.querySelector('.tabs');
    if (tabs) {
      tabs.setAttribute('role', 'tablist');
      const syncTabs = () => tabs.querySelectorAll('.tab-btn').forEach((b) => b.setAttribute('aria-selected', b.classList.contains('active') ? 'true' : 'false'));
      tabs.querySelectorAll('.tab-btn').forEach((b) => b.setAttribute('role', 'tab'));
      document.querySelectorAll('.tab-panel').forEach((p) => p.setAttribute('role', 'tabpanel'));
      new MutationObserver(syncTabs).observe(tabs, { subtree: true, attributes: true, attributeFilter: ['class'] });
      syncTabs();
    }
    const labelIf = (id, txt) => { const e = q(id); if (e && !e.getAttribute('aria-label')) e.setAttribute('aria-label', txt); };
    labelIf('btn-toggle-sound', 'Ton an oder aus'); labelIf('btn-sound', 'Ton an oder aus'); labelIf('btn-mute', 'Ton an oder aus');
    labelIf('btn-leave-lobby', 'Raum verlassen'); labelIf('btn-leave-game', 'Spiel verlassen');
    const lc = q('lobby-code'); if (lc) lc.setAttribute('aria-label', 'Raum-Code');
  })();

})();
