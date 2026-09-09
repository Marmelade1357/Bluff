# Bluff (Lügen) – Online

Eine browserbasierte Online-Version des Kartenspiels **"Lügen"** (auch bekannt als "Bluff", "Mogeln" oder "Cheat") zum Spielen mit Freunden – jede:r auf dem eigenen Handy/Tablet/PC, ein gemeinsamer Server übernimmt Kartenverteilung, Zugreihenfolge und die Aufdeckung beim "Bluff!"-Ruf.

Basiert auf den hausinternen Regeln (siehe `Bluff.docx`): reihum wird verdeckt eine angesagte Kartensorte gelegt – ehrlich oder gelogen –, und jede:r nach dir kann entweder weiterlegen oder "Bluff!" rufen. Wer sich irrt, nimmt den ganzen Stapel auf die Hand.

## Funktionen

- **Runder Tisch in der Mitte** – alle Mitspieler:innen sitzen sichtbar um einen virtuellen Tisch, in der Reihenfolge, in der sie am Zug sind. Diese Sitzordnung wird bei Spielstart **zufällig** ausgelost (unabhängig von der Beitrittsreihenfolge) und bleibt für die ganze Partie stabil. Auf dem eigenen Gerät sitzt man selbst immer unten, die anderen ordnen sich im Uhrzeigersinn passend zur echten Zugreihenfolge darum an.
- **Würfelwurf für die erste Runde** – wie am echten Tisch entscheidet ein virtueller Würfelwurf, wer die allererste Runde eröffnet. Danach eröffnet immer, wer die vorige Runde als letzte:r noch Karten auf der Hand hatte.
- **Verdecktes Legen + "Bluff!"-Ruf** – Karten werden verdeckt abgelegt, nur Spieler:in und Anzahl sind für alle sichtbar. Wird "Bluff!" gerufen, deckt der Server nur den zuletzt gelegten Zug auf und wertet ihn sofort aus.
- **Automatische 4er-Ablage** – hat jemand 4 Karten derselben Sorte auf der Hand (auch 4 Buben), werden diese automatisch abgelegt, direkt nach dem Austeilen oder nachdem der Stapel aufgenommen wurde.
- **Einstellbares Deck** – der Host wählt in der Lobby zwischen 32 Karten (7 bis Ass) oder 52 Karten (2 bis Ass), optional 2 kombinierten Decks für große Runden, sowie die Anzahl der Buben (Joker) im Spiel.
- **Test-Bots** – der Raum lässt sich in der Lobby per Klick mit Bots auffüllen. Sie schätzen anhand der eigenen Hand und der schon behaupteten Kartenzahl ab, ob ein Zug plausibel ist, bluffen gelegentlich selbst und rufen ab und zu (auch mal grundlos) "Bluff!".
- Wiederverbindung nach Verbindungsabbruch/Neuladen der Seite (Sitzplatz und Hand bleiben erhalten).
- Läuft komplett im Speicher – keine Datenbank nötig, ideal für einen Raspberry Pi.

## Anpassungen für die Online-Version

Das Regelwerk lässt an ein paar Stellen bewusst Spielraum bzw. beschreibt einen physischen Kartensatz, der online anders gelöst wird:

- **Deckgröße statt aufgedeckter Zusatzstapel** (Regel 1.4/1.4.1/1.4.2): Statt physischer 8er-Stapel, die nach Bedarf dazugenommen werden, stellt der Host in der Lobby direkt die gewünschte Deckgröße (32 oder 52 Karten, optional 2 Decks) und die Anzahl der Buben ein.
- **"Bluff!" rufen ist strikt sequenziell** (Regel 2.5): Nur die Person, die direkt nach einem Zug an der Reihe ist, kann diesen Zug anzweifeln – nicht irgendwer am Tisch zu einem beliebigen Zeitpunkt.
- **4er-Ablage gilt auch für Buben** (Regel 2.8): Der Text schließt Buben nicht ausdrücklich aus, daher werden auch 4 Buben auf der Hand automatisch abgelegt.
- **Kein festes Rundenlimit**: Nach jeder Runde kann der Host beliebig oft "Nächste Runde" starten (der Verlierer eröffnet) oder jederzeit zurück in die Lobby, für eine komplett neue Partie mit neu ausgeloster Sitzordnung.
- **Spielrichtung**: Da online ohnehin jede:r nur den eigenen Bildschirm sieht, ist die Zugreihenfolge einfach die (zufällig ausgeloste) Sitzordnung – "im oder gegen den Uhrzeigersinn" ist rein optisch (immer im Uhrzeigersinn um den Tisch dargestellt).

## Projektstruktur

```
Bluff/
├── server.js            Spiel-Server (Node.js, Express + Socket.IO)
├── package.json
├── Dockerfile           Container-Image für den Server
├── docker-compose.yml   Für den Betrieb auf dem Pi (siehe unten)
├── public/
│   ├── index.html         Oberfläche
│   ├── style.css          Design (Tisch, Karten, Sitzplätze)
│   └── client.js          Spiellogik im Browser
├── tests/               Automatisierte Tests (siehe unten)
├── .github/workflows/   GitHub-Actions-CI, läuft bei jedem Push automatisch
└── README.md            Diese Anleitung
```

## Lokal testen (z. B. auf deinem Windows-PC)

Voraussetzung: [Node.js](https://nodejs.org) (Version 18 oder neuer empfohlen).

```bash
cd Bluff
npm install
npm start
```

Danach im Browser öffnen: `http://localhost:3000`

Zum Testen mit mehreren "Spielern" einfach mehrere Browser-Tabs oder -Fenster öffnen, oder in der Lobby mit Bots auffüllen.

## Automatisierte Tests

Unter `tests/` liegen sowohl reine Unit-Tests der Spiellogik (`rules.test.js` – Deckaufbau, Wahrheit/Lüge-Erkennung, automatische 4er-Ablage, Zugreihenfolge) als auch Integrationstests, die den Server als echten Prozess starten und über `socket.io-client` komplette Abläufe durchspielen (`basic-game-flow.test.js`, `bluff-detection.test.js`).

```bash
npm install
npm test
```

Bei jedem Push nach GitHub läuft das automatisch über eine GitHub Action (`.github/workflows/ci.yml`) mit.

## Mit Freunden im selben WLAN spielen

1. Server wie oben starten (`npm start`).
2. Die lokale IP-Adresse deines Rechners herausfinden (Windows: `ipconfig`, unter "IPv4-Adresse", z. B. `192.168.1.42`).
3. Freunde im selben WLAN öffnen im Browser: `http://192.168.1.42:3000`
4. Eine Person erstellt einen Raum und teilt den 4-stelligen Raum-Code, alle anderen treten mit Namen + Code bei.

## Dauerhaft auf dem Raspberry Pi hosten – analog zu Widerstand/Wizard

Läuft nach dem gleichen Docker-Muster wie deine anderen Projekte: ein Container mit dem Node-Server, per Compose verwaltet, dein bestehender Reverse Proxy übernimmt das Routing der Domain.

Bereits belegte interne Ports auf dem Pi: `8080/8443` (FinanceAgent), `8090/8091` (Monitoring Shop), `8092` (Widerstand), `8093` (Wizard), `8094` (Spielehub). Bluff nutzt deshalb **Port 8095**.

```bash
cd Bluff
docker compose up -d --build
```

Das startet den Server und bindet ihn nur lokal an `127.0.0.1:8095`. Status prüfen:

```bash
docker compose ps
docker compose logs -f
```

Nach Code-Änderungen genügt `./deploy.sh` (holt den neuesten Stand von GitHub und baut neu, wie bei den anderen Projekten).

### Reverse Proxy: bluff.oualid.de → Port 8095

Analog zum bestehenden `/wizard/`- bzw. `/widerstand/`-Block in `Spielehub/nginx.conf` bzw. den eigenständigen nginx-Configs von Widerstand/Wizard – wichtig ist, dass WebSocket-Upgrade-Header (`Upgrade`/`Connection`) durchgereicht werden, sonst bricht Socket.IO ab.

Um Bluff auch als Kachel im "Spielehub" erscheinen zu lassen, in `Spielehub/public/index.html` eine weitere `.game-tile` ergänzen (Link auf `/bluff/`) und in `Spielehub/nginx.conf` einen `location /bluff/ { proxy_pass http://127.0.0.1:8095/; ... }`-Block hinzufügen, wie bei den beiden bestehenden Spielen.

### Sicherheitshinweis

Es gibt aktuell keinen Zugriffsschutz (kein Passwort) – wer die URL und einen Raum-Code kennt, kann beitreten. Für ein privates Spiel im Freundeskreis meist unkritisch, aber gut zu wissen, bevor der Link weiter verbreitet wird.

## Spielablauf in der Web-Version

1. **Raum erstellen** (ein Spieler) → Raum-Code an alle anderen weitergeben.
2. Alle **treten mit Namen bei** (2–8 Spieler). Der Host stellt in der Lobby optional die Deckgröße und Bubenzahl ein.
3. Host klickt **"Spiel starten"** → die Sitzordnung wird zufällig ausgelost, Karten werden verteilt, ein virtueller Würfelwurf bestimmt die erste eröffnende Person.
4. Reihum wird verdeckt eine Karte (oder mehrere) der angesagten Sorte gelegt – ehrlich oder gelogen. Wer an der Reihe ist, legt entweder selbst nach oder ruft "Bluff!" auf den letzten Zug.
5. Sobald nur noch eine Person Karten auf der Hand hat, endet die Runde – diese Person eröffnet die nächste Runde. Der Host kann beliebig viele Runden hintereinander starten oder zurück in die Lobby für eine neue Partie.

Viel Spaß beim Lügen – und Vorsicht, wem ihr vertraut. 🃏
