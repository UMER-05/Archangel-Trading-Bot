# Deploying ArchAngel Bot to InterServer (162.35.181.33)

Assumes a standard Linux VPS (Ubuntu 22.04/24.04 — InterServer's default cloud VPS image). If yours is Windows, say so and this needs different commands for phases 1, 5, and 6.

Server IP used throughout: `162.35.181.33`. Ports: backend `4000`, frontend `3000`, both proxied through Nginx on `80`.

---

## Phase 1 — Server prep

SSH in as root (or your sudo user):

```bash
ssh root@162.35.181.33
```

Update the system and install baseline tools:

```bash
apt update && apt upgrade -y
apt install -y curl git build-essential ufw
```

Install Node.js 20.x (this repo pins `"node": "20.x"` in `frontend/package.json` — don't use a different major version):

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs
node -v   # should print v20.x
```

Install PM2 (process manager — keeps both apps running, restarts them on crash and on reboot):

```bash
npm install -g pm2
```

Install Nginx (reverse proxy — lets both apps share port 80 under one public IP, and handles the WebSocket upgrade Socket.IO needs):

```bash
apt install -y nginx
```

---

## Phase 2 — Get the code onto the server

Create a deploy user is optional but recommended; for simplicity this assumes root. Clone the repo you pushed earlier:

```bash
cd /opt
git clone https://github.com/Victor-droid-ux/Archangel.git archangel
cd archangel
```

---

## Phase 3 — Backend

```bash
cd /opt/archangel/backend
npm install
```

Create `/opt/archangel/backend/.env` — this is the real, sensitive one. It is **not** in git (confirmed gitignored), so you create it fresh on the server:

```bash
nano .env
```

Populate it with your real values. At minimum:

```bash
NODE_ENV=production
PORT=4000

# Must match how the frontend will actually be reached, or every
# HTTP-triggered socket broadcast (trades, config updates) silently no-ops
# due to CORS — this is the exact bug fixed earlier this session.
FRONTEND_URL=http://162.35.181.33

# Database — reuse your existing MongoDB Atlas (or wherever it lives) rather
# than standing up Mongo fresh on this box, unless you specifically want to
# self-host it here.
MONGO_URI=<your real MongoDB connection string>
MONGO_DB_NAME=archangel

# Wallet that actually signs trades — treat this file as the single most
# sensitive thing on this server. chmod it after saving (see below).
WALLET_SECRET_KEY=<your real base58 secret key>
WALLET_PUBLIC_KEY=<matching public key>
ADMIN_WALLET_SECRET=<same secret key, base58>
ADMIN_WALLET_PUBKEY=<matching public key>

# RPC / discovery / execution
SOLANA_RPC_URL=<your Helius or other paid RPC URL>
HELIUS_RPC_URL=<same or your Helius URL>
JUPITER_API_URL=https://api.jup.ag
JUPITER_API_KEY=<your Jupiter API key>

# Trading behavior — copy the rest of your working local backend/.env values
# (SL_PCT, MAX_OPEN_POSITIONS, MIN_JUPITER_LIQUIDITY_SOL, JUPITER_AUTO_BUY,
# JUPITER_AUTO_BUY_SOL, STORED_TOKEN_CHECKER_ENABLED, etc.) — these are your
# actual tuned trading parameters, not deployment-specific, so just bring
# them over as-is rather than retyping from scratch.
```

Lock down the file — it holds a real private key:

```bash
chmod 600 .env
```

Build and start it under PM2:

```bash
npm run build
pm2 start ecosystem.config.js
pm2 logs archangel-backend --lines 50   # confirm "MongoDB connected" and "Backend online"
```

---

## Phase 4 — Frontend

```bash
cd /opt/archangel/frontend
npm install
```

Create `/opt/archangel/frontend/.env`:

```bash
NEXT_PUBLIC_BACKEND_URL=http://162.35.181.33:4000
NEXT_PUBLIC_SOCKET_URL=http://162.35.181.33:4000
NEXT_PUBLIC_API_BASE_URL=http://162.35.181.33:4000/api

NEXT_PUBLIC_SOLANA_ENDPOINT=<your Helius RPC URL>
NEXT_PUBLIC_SOLANA_RPC_URL=<your Helius RPC URL>
NEXT_PUBLIC_SOLANA_FALLBACK_1=<your QuickNode or other fallback RPC>
NEXT_PUBLIC_SOLANA_FALLBACK_2=https://solana-mainnet.g.alchemy.com/v2/demo
```

(If you're putting Nginx in front per Phase 5 and want everything under plain port 80 with no `:4000` in the URL, use `http://162.35.181.33/api` etc. instead, once the proxy rules below are in place — either works, just be consistent between this file and the Nginx config.)

Build and start it under PM2:

```bash
npm run build
pm2 start ecosystem.config.js
pm2 logs archangel-frontend --lines 50   # confirm "Ready" and it's listening on 3000
```

Save the PM2 process list and enable it on boot:

```bash
pm2 save
pm2 startup   # run the command it prints, then `pm2 save` again
```

---

## Phase 5 — Nginx reverse proxy

This lets visitors hit plain `http://162.35.181.33` (port 80) and routes them to the right app, while also correctly upgrading WebSocket connections for Socket.IO (a plain proxy without the `Upgrade`/`Connection` headers below will silently break the live dashboard — trades, positions, live feed all depend on this).

```bash
nano /etc/nginx/sites-available/archangel
```

```nginx
server {
    listen 80;
    server_name 162.35.181.33;

    # Socket.IO — must come before the general /api block, and needs the
    # Upgrade headers or the frontend falls back to failed long-polling.
    location /socket.io/ {
        proxy_pass http://127.0.0.1:4000/socket.io/;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }

    # Backend REST API
    location /api/ {
        proxy_pass http://127.0.0.1:4000/api/;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }

    # Everything else — the Next.js frontend
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

Enable it and reload:

```bash
ln -s /etc/nginx/sites-available/archangel /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default
nginx -t   # should say "syntax is ok" / "test is successful"
systemctl reload nginx
```

If you go this route, update both `.env` files to drop the explicit `:4000`/`:3000` ports (`FRONTEND_URL=http://162.35.181.33`, `NEXT_PUBLIC_BACKEND_URL=http://162.35.181.33`, `NEXT_PUBLIC_SOCKET_URL=http://162.35.181.33`, `NEXT_PUBLIC_API_BASE_URL=http://162.35.181.33/api`), then `pm2 restart archangel-backend archangel-frontend`.

---

## Phase 6 — Firewall

Only expose what's needed. If you're using the Nginx proxy from Phase 5, 3000/4000 don't need to be reachable from outside at all:

```bash
ufw allow OpenSSH
ufw allow 80/tcp
ufw enable
ufw status
```

---

## Phase 7 — HTTPS (optional, needs a domain)

Let's Encrypt issues certificates for domain names, not bare IP addresses — `https://162.35.181.33` isn't something Certbot can give you a trusted cert for. If you point a domain at this IP later:

```bash
apt install -y certbot python3-certbot-nginx
certbot --nginx -d yourdomain.com
```

It'll edit the Nginx config for you and set up auto-renewal. Until then, running over plain HTTP is fine for a personal dashboard, but be aware wallet connect popups (Phantom etc.) and some browsers increasingly nag or restrict features on non-HTTPS origins.

---

## Phase 8 — Verify

- `curl http://162.35.181.33/health` (or `:4000/health` if not proxied) → `{"status":"healthy",...}`
- Open `http://162.35.181.33` in a browser → dashboard loads, navbar shows "Live" (Socket.IO connected)
- `pm2 status` → both `archangel-backend` and `archangel-frontend` show `online`
- `pm2 logs` → no repeating errors, backend shows "MongoDB connected" and Jupiter discovery starting

---

## Ongoing operations

**Deploy an update:**
```bash
cd /opt/archangel
git pull
cd backend && npm install && npm run build && pm2 restart archangel-backend
cd ../frontend && npm install && npm run build && pm2 restart archangel-frontend
```

**Logs:** `pm2 logs archangel-backend` / `pm2 logs archangel-frontend` (or read the files directly under each app's `logs/` folder).

**Restart everything:** `pm2 restart all`

**Stop everything:** `pm2 stop all`
