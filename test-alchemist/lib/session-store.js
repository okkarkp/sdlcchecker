const fs   = require('fs');
const path = require('path');

const SESSION_DIR = path.join(__dirname, '../data/sessions');

function ensureDir() {
  if (!fs.existsSync(SESSION_DIR)) fs.mkdirSync(SESSION_DIR, { recursive: true });
}

function sanitize(clientId) {
  return String(clientId || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64) || 'anon';
}

function sessionPath(clientId) {
  return path.join(SESSION_DIR, `${sanitize(clientId)}.json`);
}

function getSession(clientId) {
  ensureDir();
  try {
    const fp = sessionPath(clientId);
    if (!fs.existsSync(fp)) return null;
    return JSON.parse(fs.readFileSync(fp, 'utf8'));
  } catch { return null; }
}

function saveSession(clientId, updates) {
  ensureDir();
  const existing = getSession(clientId) || {};
  const data = {
    ...existing,
    ...updates,
    clientId: sanitize(clientId),
    lastActivity: new Date().toISOString(),
  };
  // Playwright files are ephemeral — never persist them so they don't
  // auto-reload on the next session start.
  delete data.playwrightFiles;
  fs.writeFileSync(sessionPath(clientId), JSON.stringify(data, null, 2));
  return data;
}

function deleteSession(clientId) {
  const fp = sessionPath(clientId);
  try { if (fs.existsSync(fp)) fs.unlinkSync(fp); } catch {}
}

function pruneOldSessions(daysOld = 7) {
  ensureDir();
  const cutoff = Date.now() - daysOld * 86_400_000;
  try {
    for (const f of fs.readdirSync(SESSION_DIR)) {
      if (!f.endsWith('.json')) continue;
      const fp = path.join(SESSION_DIR, f);
      try {
        const s = JSON.parse(fs.readFileSync(fp, 'utf8'));
        if (!s.lastActivity || new Date(s.lastActivity).getTime() < cutoff) fs.unlinkSync(fp);
      } catch {}
    }
  } catch {}
}

module.exports = { getSession, saveSession, deleteSession, pruneOldSessions };
