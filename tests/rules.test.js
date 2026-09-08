// Unit-Tests für die reinen Spiellogik-Funktionen aus server.js (kein echter
// Server/Socket nötig - schnelle, isolierte Prüfung der Kernregeln).

const {
  buildDeck, dealCards, wasTruthful, extractFourOfAKind,
  nextActiveIndex, activeCount, claimableRanksFor, clampSettings, maxJackCount,
} = require('../server');

function assert(condition, message) {
  if (!condition) throw new Error(`Assertion fehlgeschlagen: ${message}`);
}

function main() {
  // --- Deck-Aufbau ---
  const deck52 = buildDeck({ deckRange: '52', deckCount: 1, jackCount: 4 });
  assert(deck52.length === 52, `52er-Deck sollte 52 Karten haben, hat aber ${deck52.length}`);
  assert(deck52.filter((c) => c.rank === 'J').length === 4, 'Sollte 4 Buben enthalten');
  assert(new Set(deck52.map((c) => c.id)).size === 52, 'Alle Karten-IDs müssen eindeutig sein');

  const deck32 = buildDeck({ deckRange: '32', deckCount: 1, jackCount: 4 });
  assert(deck32.length === 32, `32er-Deck sollte 32 Karten haben, hat aber ${deck32.length}`);
  assert(deck32.every((c) => c.rank !== '2' && c.rank !== '6'), '32er-Deck darf keine 2en/6en enthalten');

  const deckFewJacks = buildDeck({ deckRange: '52', deckCount: 1, jackCount: 1 });
  assert(deckFewJacks.length === 49, `Deck mit 1 Buben sollte 49 Karten haben, hat aber ${deckFewJacks.length}`);
  assert(deckFewJacks.filter((c) => c.rank === 'J').length === 1, 'Sollte genau 1 Buben enthalten');

  const deck2x = buildDeck({ deckRange: '52', deckCount: 2, jackCount: 8 });
  assert(deck2x.length === 104, `2 kombinierte 52er-Decks sollten 104 Karten ergeben, waren aber ${deck2x.length}`);
  assert(new Set(deck2x.map((c) => c.id)).size === 104, 'Auch bei 2 Decks müssen alle IDs eindeutig sein');

  assert(!claimableRanksFor('52').includes('J'), 'Bube darf nie als ansagbare Kartensorte auftauchen (Regel 2.9)');
  assert(claimableRanksFor('52').length === 12, 'Bei 52 Karten sollten 12 ansagbare Sorten übrig bleiben (ohne Buben)');

  const clamped = clampSettings({ deckRange: '52', deckCount: 1, jackCount: 99 });
  assert(clamped.jackCount === 4, `jackCount sollte auf maxJackCount(1)=4 begrenzt werden, war aber ${clamped.jackCount}`);
  assert(maxJackCount(2) === 8, 'maxJackCount(2) sollte 8 sein');

  // --- Austeilen ---
  const players = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  const hands = dealCards(players, deck52);
  const total = Object.values(hands).reduce((sum, h) => sum + h.length, 0);
  assert(total === 52, `Alle 52 Karten sollten verteilt sein, waren aber ${total}`);
  const sizes = players.map((p) => hands[p.id].length).sort((x, y) => x - y);
  assert(sizes[2] - sizes[0] <= 1, `Karten sollten möglichst gleichmäßig verteilt sein, Größen: ${sizes}`);

  // --- Wahrheit vs. Lüge (Regel 2.4 / 2.9) ---
  const K = (suit) => ({ id: `k-${suit}`, suit, rank: 'K' });
  const J = (suit) => ({ id: `j-${suit}`, suit, rank: 'J' });
  const Q = (suit) => ({ id: `q-${suit}`, suit, rank: 'Q' });
  assert(wasTruthful([K('pik'), K('herz')], 'K') === true, '2 echte Könige bei Ansage "König" ist Wahrheit');
  assert(wasTruthful([K('pik'), J('herz')], 'K') === true, 'König + Bube (Joker) bei Ansage "König" ist Wahrheit');
  assert(wasTruthful([K('pik'), Q('herz')], 'K') === false, 'König + Dame bei Ansage "König" ist eine Lüge');
  assert(wasTruthful([J('pik'), J('herz')], 'K') === true, 'Nur Buben zählen immer als die angesagte Sorte');

  // --- 4-gleiche müssen automatisch abgelegt werden (Regel 2.8) ---
  const handWithFour = [K('pik'), K('herz'), K('karo'), K('kreuz'), Q('pik')];
  const { hand: afterDiscard, discarded } = extractFourOfAKind(handWithFour);
  assert(afterDiscard.length === 1 && afterDiscard[0].rank === 'Q', 'Nach Ablage sollte nur die Dame übrig bleiben');
  assert(discarded.length === 4 && discarded.every((c) => c.rank === 'K'), 'Es sollten genau 4 Könige abgelegt werden');

  const handWithEight = [K('pik'), K('herz'), K('karo'), K('kreuz'), K('pik'), K('herz'), K('karo'), K('kreuz')];
  handWithEight.forEach((c, i) => { c.id = `k${i}`; });
  const { hand: afterDiscard2, discarded: discarded2 } = extractFourOfAKind(handWithEight);
  assert(afterDiscard2.length === 0, 'Bei 8 gleichen Karten (2 Decks) sollten am Ende 0 übrig bleiben');
  assert(discarded2.length === 8, 'Es sollten insgesamt 8 Karten abgelegt werden (2x4er-Gruppe)');

  const handWithThree = [K('pik'), K('herz'), K('karo')];
  const { hand: afterDiscard3 } = extractFourOfAKind(handWithThree);
  assert(afterDiscard3.length === 3, 'Bei nur 3 gleichen Karten darf nichts abgelegt werden');

  // --- Zugreihenfolge überspringt fertige Spieler ---
  const seatPlayers = [{ id: 'p1' }, { id: 'p2' }, { id: 'p3' }, { id: 'p4' }];
  const seatHands = { p1: [K('pik')], p2: [], p3: [K('herz')], p4: [] };
  assert(nextActiveIndex(seatPlayers, seatHands, 0) === 2, 'Von p1 aus sollte p2 (leer) übersprungen werden, weiter zu p3 (Index 2)');
  assert(nextActiveIndex(seatPlayers, seatHands, 2) === 0, 'Von p3 aus sollte über p4 (leer) zurück zu p1 (Index 0) gehen');
  assert(activeCount(seatPlayers, seatHands) === 2, 'Es sollten genau 2 Spieler noch aktiv (mit Karten) sein');

  const allEmpty = { p1: [], p2: [], p3: [], p4: [] };
  assert(nextActiveIndex(seatPlayers, allEmpty, 0) === -1, 'Ohne aktive Spieler sollte -1 zurückkommen');

  console.log('OK: rules.test.js');
}

try {
  main();
} catch (err) {
  console.error('FEHLER in rules.test.js:', err);
  process.exitCode = 1;
}
