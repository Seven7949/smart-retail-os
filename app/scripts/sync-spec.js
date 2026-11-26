// Copies the shared spec files (catalog, ledger vectors, udhaar model) from
// ../spec into src/spec so Metro can bundle them. `npm test` checks they are
// identical, so the app can never drift from the Rust/Python implementations.
const fs = require('fs');
const path = require('path');

const FILES = ['catalog.json', 'ledger-vectors.json', 'udhaar_model.json'];
const from = path.resolve(__dirname, '..', '..', 'spec');
const to = path.resolve(__dirname, '..', 'src', 'spec');
fs.mkdirSync(to, { recursive: true });
for (const f of FILES) fs.copyFileSync(path.join(from, f), path.join(to, f));
console.log(`synced ${FILES.length} spec files`);
