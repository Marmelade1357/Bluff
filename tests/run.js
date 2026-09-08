// Führt alle Integrationstests unter tests/ nacheinander aus, jeden in einem
// eigenen Kindprozess (vollständig isoliert - kein geteilter Zustand, kein
// Port-Konflikt). Bricht mit Exit-Code 1 ab, sobald ein Test fehlschlägt, und
// gibt am Ende eine kurze Zusammenfassung aus.

const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const testFiles = fs.readdirSync(__dirname)
  .filter((f) => f.endsWith('.test.js'))
  .sort();

if (testFiles.length === 0) {
  console.log('Keine Testdateien (*.test.js) gefunden.');
  process.exit(0);
}

let failed = 0;
for (const file of testFiles) {
  console.log(`\n=== ${file} ===`);
  const result = spawnSync(process.execPath, [path.join(__dirname, file)], { stdio: 'inherit' });
  if (result.status !== 0) {
    failed++;
    console.error(`FEHLGESCHLAGEN: ${file}`);
  }
}

console.log(`\n${testFiles.length - failed}/${testFiles.length} Tests erfolgreich.`);
process.exit(failed > 0 ? 1 : 0);
