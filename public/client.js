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
  const RANK_LABELS = { J: 'Bube', Q: 'Dame', K: 'König', A: 'As' };
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
  // Helfer
  // ---------------------------------------------------------------------

  function $(id) { return document.getElementById(id); }
  function show(elm) { elm.classList.remove('hidden'); }
  function hide(elm) { elm.classList.add('hidden'); }
  function showScreen(id) {
    document.querySelectorAll('.screen').forEach((s) => hide(s));
    show($(id));
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

  $('btn-leave-lobby').addEventListener('click', () => {
    socket.emit('leaveRoom');
    clearSession();
    latestState = null;
    showScreen('screen-home');
  });

  $('btn-leave-game').addEventListener('click', () => {
    socket.emit('leaveRoom');
    clearSession();
    latestState = null;
    showScreen('screen-home');
  });

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
  socket.on('yourHand', (data) => {
    myHand = data.hand || [];
    const validIds = new Set(myHand.map((c) => c.id));
    selectedCardIds.forEach((id) => { if (!validIds.has(id)) selectedCardIds.delete(id); });
    if (latestState) render(latestState);
  });

  socket.on('gameState', (state) => {
    latestState = state;
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
    renderPile(state);
    renderDice(state);
    renderReveal(state);
    renderActionBar(state);
    renderHandBar(state);
    renderRoundEnd(state);
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
    const claimEl = $('pile-claim');
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
      (r.revealedCards || []).forEach((c) => cardsEl.appendChild(renderCardFace(c)));
      const textEl = $('reveal-text');
      const accuserName = playerName(state, r.accuserId);
      const targetName = playerName(state, r.targetId);
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
    if (!myTurn) { hide(bar); return; }
    show(bar);

    if (state.isPileEmpty) {
      content.appendChild(el('p', { class: 'action-bar-note', text: 'Wähle die Sorte, die du ansagst, und dann 1+ Karten aus deiner Hand.' }));
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
      content.appendChild(el('p', { class: 'action-bar-note', text: `Angesagte Sorte: ${rankLabel(state.requiredRank)}. Lege 1+ Karten nach oder rufe "Bluff!" auf den letzten Zug.` }));
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
    myHand.forEach((card) => {
      const cardEl = renderCardFace(card);
      if (!myTurn) cardEl.classList.add('disabled');
      if (selectedCardIds.has(card.id)) cardEl.classList.add('selected');
      if (myTurn) {
        cardEl.addEventListener('click', () => {
          if (selectedCardIds.has(card.id)) selectedCardIds.delete(card.id);
          else selectedCardIds.add(card.id);
          render(state);
        });
      }
      list.appendChild(cardEl);
    });
  }

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
})();
