# Deploying Test Alchemist

Two supported models. **Prefer local** — it's simplest and keeps each person's data
and credentials isolated. Use **central** only when local install isn't possible.

| | Local (per-user) | Central (shared) |
|---|---|---|
| Runs on | each person's machine | one host everyone connects to |
| Needs on device | Node.js **or** Docker | just a browser |
| Data isolation | per person (own SQLite DB) | shared DB, shared credentials |
| Setup effort | minutes | one-time host setup + guardrails |
| Best for | individuals, most teams | teams who can't install Node locally |

---

## Option A — Local (per-user)

**Recommended.** Each person runs their own copy.

### A1. Node (no Docker)
```bash
npm install
npm run init          # writes project.config.json + .env
npm start             # → http://localhost:3000
```
Double-click launchers also exist: macOS `start.command`, Windows `start.bat`.
See [SETUP.md](SETUP.md) for prerequisites (Node 18+, and the `better-sqlite3` /
Playwright-browser notes).

### A2. Local Docker (no Node on the device)
If Node can't be installed but Docker can:
```bash
npm run init          # or: copy .env.example→.env and project.config.example.json→project.config.json
docker compose up -d  # build + run
# → http://localhost:3000
```
`./data` on your machine holds the SQLite DB, so state survives restarts.

---

## Option B — Central (shared instance)

One container serves the whole team. Same image as local Docker, run on a host.

```bash
# on the host
npm run init                 # or hand-create .env + project.config.json
docker compose up -d --build
```

### ⚠ Read before exposing it

Test Alchemist has **no user login** — the only access control is an IP allowlist,
and it defaults to *open*. A shared instance therefore needs guardrails, or anyone who
can reach the URL can spend your AI tokens and use the configured Jira/GitLab
credentials. Do **not** put it on the public internet as-is.

1. **Restrict access.** Set `ALLOWED_IPS` in `.env` to your office/VPN egress IPs, or
   place the host behind a VPN / internal load balancer / SSO proxy. Never bind it to a
   public address without one of these.
2. **Persist the database.** The `./data` volume in
   [docker-compose.yml](docker-compose.yml) keeps SQLite across restarts. On ephemeral
   platforms (Elastic Beanstalk, ECS/Fargate) attach durable storage (EFS) — otherwise
   the DB is wiped on redeploy. Run a **single instance**; SQLite is one writer.
3. **Reachability.** The browser-automation features drive the *app under test*. The
   central host must be able to reach that app's URL. If the app lives on an internal
   network the cloud host can't see, browser automation won't work from there — confirm
   this first.
4. **Secrets at runtime.** Credentials come from `.env` (via `env_file`) — never baked
   into the image. On AWS, prefer Secrets Manager / EB environment properties.

### AWS specifics
The container fronts cleanly with CloudFront → Elastic Beanstalk (backend) and S3
(static). See [aws/cloudfront-setup.md](aws/cloudfront-setup.md) and the helper scripts
(`npm run build:s3`, `upload:s3`, `package:eb`, `check:deploy`). All four guardrails
above still apply.

---

## Handoff without deploying

To share the tool for someone else to deploy, build a clean zip (no secrets/data):
```bash
npm run package       # → test-alchemist-handoff.zip
```
Recipient: unzip → `npm install` → `npm run init` → `npm start` (or `docker compose up`).
