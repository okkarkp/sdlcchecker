const db = require('better-sqlite3')('data/alchemist.db');
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
console.log('Tables:', tables.map(t=>t.name).join(', '));
tables.forEach(t => {
  try {
    const count = db.prepare('SELECT COUNT(*) as n FROM "' + t.name + '"').get();
    console.log(' ', t.name, ':', count.n, 'rows');
  } catch(e) { console.log(' ', t.name, ': error', e.message); }
});

// Check app_flow in detail
const flows = db.prepare('SELECT * FROM app_flow').all();
console.log('\nAll app_flow entries:');
flows.forEach((f,i) => console.log(i+1, JSON.stringify(f).slice(0,200)));

db.close();
