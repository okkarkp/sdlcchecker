require('dotenv').config({ path: require('path').join(__dirname, '.env') });

// Apply the declarative project profile (project.config.json) as env fallbacks,
// so this deployment can target any project without editing scattered files.
// .env still wins; secrets are never read from here. See lib/project-config.js.
require('./lib/project-config').loadProjectConfig();

// Allow self-signed / corporate-proxy certificates for all outbound HTTPS
// (this Node process is a local dev tool — not a public server)
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const express = require('express');
const cors    = require('cors');
const path    = require('path');
const http    = require('http');
const WebSocket = require('ws');

const aiRoutes         = require('./routes/ai');
const gitlabRoutes     = require('./routes/gitlab');
const jiraRoutes       = require('./routes/jira');
const playwrightRoutes = require('./routes/playwright-gen');
const agentRoutes      = require('./routes/agents');
const schedulerRoutes  = require('./routes/scheduler');
const sessionRoutes    = require('./routes/session');
const configRoutes     = require('./routes/config');
const historyRoutes    = require('./routes/history');
const chatRoutes       = require('./routes/chat');
const knowledgeRoutes  = require('./routes/knowledge');
const browserAgentRoutes = require('./routes/browser-agent');
const pwScriptsRoutes    = require('./routes/pw-scripts');
const repoScriptsRoutes  = require('./routes/repo-scripts');
const flowRoutes         = require('./routes/flows');
const confluenceRoutes   = require('./routes/confluence');
const codebaseRoutes     = require('./routes/codebase');
const appMapRoutes       = require('./routes/app-map');
const perfforgeRoutes    = require('./routes/perfforge');
const twinRoutes         = require('./routes/twin');
const autoRef          = require('./lib/auto-reference');
const sessionStore     = require('./lib/session-store');
const authRoutes       = require('./routes/auth');
const auth             = require('./lib/auth');
// Initialise SQLite DB (runs CREATE TABLE IF NOT EXISTS on first require)
require('./lib/db');

// Seed an admin from AUTH_ADMIN_* env (idempotent) and report auth status.
auth.seedAdmin();
console.log(auth.isAuthEnabled()
  ? '🔐 Authentication: ENABLED (local accounts)'
  : '🔓 Authentication: OPEN (set AUTH_ADMIN_USER/PASSWORD or AUTH_ENABLED=true to require login)');

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });

// ── IP Whitelist ──────────────────────────────────────────────────────────────
// Read allowed IPs from ALLOWED_IPS env var (comma-separated) or ip-whitelist.txt
// If neither is set, all IPs are allowed (open mode — for local dev).
// Always allows: 127.0.0.1 and ::1 (localhost)
function loadAllowedIps() {
  const fs       = require('fs');
  const listFile = path.join(__dirname, 'ip-whitelist.txt');
  const ips      = new Set();

  // From env var: ALLOWED_IPS=1.2.3.4,5.6.7.8
  (process.env.ALLOWED_IPS || '').split(/[\s,;]+/).forEach(s => { if (s.trim()) ips.add(s.trim()); });

  // From file: one IP per line, # lines are comments
  try {
    fs.readFileSync(listFile, 'utf8').split('\n').forEach(line => {
      const clean = line.replace(/#.*$/, '').trim();  // strip comments
      if (clean) ips.add(clean);
    });
  } catch {}

  return [...ips];
}

const WHITELIST = loadAllowedIps();
const IP_GUARD_ENABLED = WHITELIST.length > 0;

if (IP_GUARD_ENABLED) {
  console.log(`🔒 IP whitelist active — ${WHITELIST.length} IP(s) allowed:`, WHITELIST.join(', '));
} else {
  console.log('🌐 IP whitelist: OPEN (set ALLOWED_IPS or create ip-whitelist.txt to restrict)');
}

function ipGuard(req, res, next) {
  if (!IP_GUARD_ENABLED) return next();
  // Normalise: strip ::ffff: prefix from IPv4-mapped IPv6 addresses
  const raw = req.ip || req.connection.remoteAddress || '';
  const ip  = raw.replace(/^::ffff:/, '');
  if (ip === '127.0.0.1' || ip === '::1' || WHITELIST.includes(ip)) return next();
  console.warn(`[IP Guard] Blocked request from ${ip}`);
  res.status(403).send('Access denied — your IP is not on the allowed list.');
}

app.set('trust proxy', true);   // respect X-Forwarded-For from corporate proxy
app.use(ipGuard);

// ── CORS ──────────────────────────────────────────────────────────────────────
const corsOrigin = process.env.ALLOWED_ORIGIN || '*';
app.use(cors({
  origin:         corsOrigin,
  methods:        ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── WebSocket: per-client real-time broadcast ──────────────────────────────────
// clients is a Map<clientId, Set<WebSocket>> so multiple tabs share the same clientId
const clients = new Map();

wss.on('connection', (ws, req) => {
  // When auth is enabled, require a valid session cookie on the upgrade request.
  if (auth.isAuthEnabled() && !auth.currentUser(req)) {
    try { ws.close(4401, 'Authentication required'); } catch {}
    return;
  }
  // clientId arrives as a query-string param: ws://host?clientId=xxx
  // When auth is enabled, force it to the caller's workspace so broadcasts stay
  // within the tenant and match the (also tenant-scoped) HTTP route broadcasts.
  let clientId = 'anon';
  try {
    const tenant = auth.tenantOf(req);
    if (tenant) {
      clientId = tenant;
    } else {
      const url = new URL(req.url, 'ws://localhost');
      const raw = url.searchParams.get('clientId') || '';
      clientId  = raw.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64) || 'anon';
    }
  } catch {}

  ws.clientId = clientId;
  if (!clients.has(clientId)) clients.set(clientId, new Set());
  clients.get(clientId).add(ws);

  ws.send(JSON.stringify({ type: 'connected', message: 'Test Alchemist connected' }));

  const cleanup = () => {
    const set = clients.get(clientId);
    if (set) { set.delete(ws); if (!set.size) clients.delete(clientId); }
  };
  ws.on('close', cleanup);
  ws.on('error', cleanup);
});

// Broadcast to all connected clients (used for shared events)
global.broadcast = (data) => {
  const payload = JSON.stringify(data);
  clients.forEach(sockets => {
    sockets.forEach(ws => { if (ws.readyState === WebSocket.OPEN) ws.send(payload); });
  });
};

// Broadcast only to a specific client; falls back to broadcast-all if clientId is missing
global.broadcastTo = (clientId, data) => {
  if (!clientId || clientId === 'anon') { global.broadcast(data); return; }
  const sockets = clients.get(clientId);
  if (!sockets) return;
  const payload = JSON.stringify(data);
  sockets.forEach(ws => { if (ws.readyState === WebSocket.OPEN) ws.send(payload); });
};

// ── Auth: public endpoints, then gate everything else under /api ────────────────
app.use('/api/auth', authRoutes);        // login / logout / me — never gated
app.use('/api', auth.requireAuth);       // all other /api/* require a session (when auth enabled)

// ── Multi-tenancy: force the data-scoping key to the caller's workspace ─────────
// When auth is enabled, every request's clientId is overridden (server-side, from
// the verified session) with the user's workspace/tenant. All client_id-scoped
// tables therefore isolate by workspace, and a client can't reach another
// workspace's data by sending a different clientId. When auth is off, this is a
// no-op and the browser-supplied clientId is used (single-tenant local mode).
app.use('/api', (req, res, next) => {
  const tenant = auth.tenantOf(req);
  if (tenant) {
    req.tenantId = tenant;
    if (req.body && typeof req.body === 'object') req.body.clientId = tenant;
    if (req.query) req.query.clientId = tenant;
  }
  next();
});

// ── API Routes ─────────────────────────────────────────────────────────────────
app.use('/api/ai',         aiRoutes);
app.use('/api/gitlab',     gitlabRoutes);
app.use('/api/jira',       jiraRoutes);
app.use('/api/playwright', playwrightRoutes);
app.use('/api/agents',     agentRoutes);
app.use('/api/scheduler',  schedulerRoutes);
app.use('/api/session',    sessionRoutes);
app.use('/api/config',     configRoutes);
app.use('/api/history',      historyRoutes);
app.use('/api/chat',         chatRoutes);
app.use('/api/knowledge',    knowledgeRoutes);
app.use('/api/browser-agent', browserAgentRoutes);
app.use('/api/pw-scripts',   pwScriptsRoutes);
app.use('/api/repo-scripts', repoScriptsRoutes);
app.use('/api/flows',        flowRoutes);
app.use('/api/confluence',   confluenceRoutes);
app.use('/api/codebase',     codebaseRoutes);
app.use('/api/app-map',      appMapRoutes);
app.use('/api/perfforge',    perfforgeRoutes);
app.use('/api/twin',         twinRoutes);

// ── Health check ───────────────────────────────────────────────────────────────
app.get('/api/health', (req, res) =>
  res.json({ status: 'ok', version: '1.0.0', timestamp: new Date().toISOString() })
);

// ── Serve SPA for every non-API route ─────────────────────────────────────────
app.get('*', (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'index.html'))
);

wss.on('error', (err) => { if (err.code !== 'EADDRINUSE') throw err; });

function startServer(port) {
  // When PORT is explicitly set (e.g. by the preview framework or CI),
  // bind to that port strictly — never fall back, so the caller knows
  // the exact address. Only auto-increment in manual dev mode (no PORT env).
  const strictPort = !!process.env.PORT;

  server.once('error', (err) => {
    if (err.code === 'EADDRINUSE' && !strictPort) {
      console.warn(`⚠  Port ${port} in use — trying ${port + 1}…`);
      startServer(port + 1);
    } else {
      console.error(`✗  Cannot bind to port ${port}: ${err.message}`);
      process.exit(1);
    }
  });

  server.listen(port, () => {
    console.log(`\n⚗️   Test Alchemist  →  http://localhost:${port}\n`);
    setImmediate(() => {
      autoRef.autoLoad().catch(e => console.warn('[AutoRef]', e.message));
      sessionStore.pruneOldSessions(7);
    });
  });

  // Graceful shutdown — flush DB WAL before exit
  const shutdown = () => {
    console.log('\n[Server] Shutting down gracefully…');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000); // force exit after 2s
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

startServer(Number(process.env.PORT) || 3000);
