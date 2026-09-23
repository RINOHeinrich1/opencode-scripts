#!/usr/bin/env node
// opencode-user-provision.mjs — Provisionne une instance opencode DÉDIÉE par
// utilisateur (identité garantie) : template systemd + fichier d'env + données
// de sessions isolées + config partagée.
//
// Usage (root) :
//   node opencode-user-provision.mjs --user <username> --port <port> --password <pw>
//   node opencode-user-provision.mjs --user <username> --deprovision
//
// Chaque instance : `opencode web --port <port> --hostname 127.0.0.1`, avec
//   XDG_DATA_HOME=<usersDir>/<user>/data   (sessions ISOLÉES par utilisateur)
//   XDG_CONFIG_HOME=/root/.config          (config PARTAGÉE : agents/MCP/skills)
//   OPENCODE_USER=<username>               (identité propagée aux agents)

import { execFileSync } from "node:child_process";
import { writeFileSync, mkdirSync, rmSync, existsSync, copyFileSync, chmodSync } from "node:fs";
import { join, dirname } from "node:path";

const OPENCODE_BIN = "/root/.opencode/bin/opencode";
const USERS_DIR = "/root/.config/opencode/users";
const UNIT = "/etc/systemd/system/opencode@.service";

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : def;
}
const user = arg("user");
const port = arg("port");
const password = arg("password");
const deprovision = process.argv.includes("--deprovision");
if (!user) { console.error("Usage: node opencode-user-provision.mjs --user <u> [--port <p> --password <pw>] [--deprovision]"); process.exit(2); }

function sysctl(args) { return execFileSync("systemctl", args, { encoding: "utf8" }); }
function daemonReload() { try { sysctl(["daemon-reload"]); } catch {} }

// Template systemd (idempotent).
const unitContent = `[Unit]
Description=OpenCode Web — instance utilisateur %i (identité dédiée)
After=network.target

[Service]
Type=simple
User=root
Environment=XDG_CONFIG_HOME=/root/.config
EnvironmentFile=${USERS_DIR}/%i.env
ExecStart=${OPENCODE_BIN} web --port \${OPENCODE_PORT} --hostname 127.0.0.1
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
`;
mkdirSync(USERS_DIR, { recursive: true });
writeFileSync(UNIT, unitContent, { mode: 0o644 });
daemonReload();

if (deprovision) {
  try { sysctl(["disable", "--now", `opencode@${user}.service`]); } catch {}
  const envFile = join(USERS_DIR, `${user}.env`);
  if (existsSync(envFile)) rmSync(envFile);
  console.log(JSON.stringify({ ok: true, user, deprovisioned: true }));
  process.exit(0);
}

if (!port || !password) { console.error("--port et --password requis pour provisionner"); process.exit(2); }

// Données de sessions ISOLÉES par utilisateur.
const dataDir = join(USERS_DIR, user, "data");
mkdirSync(dataDir, { recursive: true });

// Identifiants fournisseurs LLM (auth.json) : le data dir étant isolé, l'auth
// n'est PAS dans la config partagée. On la GÉNÈRE depuis la clé ACTIVE de chaque
// fournisseur (table `provider_keys` du panneau, chiffrée AES-256-GCM) ; repli
// sur la copie de l'instance de référence si le module/la base est indisponible
// (le provisioning n'est JAMAIS bloqué par l'auth).
const SHARED_AUTH = process.env.OPENCODE_SHARED_AUTH || "/root/.local/share/opencode/auth.json";
const PROVIDER_AUTH_MODULE = process.env.OPENCODE_PROVIDER_AUTH || "/root/orchestrator-panel/provider-auth.mjs";
const ocDir = join(dataDir, "opencode");
mkdirSync(ocDir, { recursive: true });
const authDest = join(ocDir, "auth.json");
let authMode = "copie (repli)";
try {
  // Écriture CIBLÉE de l'auth.json de la SEULE nouvelle instance (les autres
  // instances sont maintenues par `opencode-auth-sync.mjs`).
  const mod = await import(PROVIDER_AUTH_MODULE);
  const db = await import(join(dirname(PROVIDER_AUTH_MODULE), "panel-db.mjs"));
  const active = await db.getActiveProviderKeys();
  if (!active.length) throw new Error("aucune clé active");
  mod.writeAuthJson(authDest, mod.renderAuthJson(active));
  chmodSync(authDest, 0o600);
  authMode = `généré (${active.length} fournisseur(s))`;
} catch (e) {
  console.error("auth génération indisponible, repli copie:", (e && e.message) || String(e));
  try {
    if (existsSync(SHARED_AUTH)) {
      copyFileSync(SHARED_AUTH, authDest);
      chmodSync(authDest, 0o600);
    }
  } catch (e2) { console.error("auth copy:", (e2 && e2.message) || String(e2)); }
}

const env = [
  `OPENCODE_PORT=${port}`,
  `OPENCODE_SERVER_PASSWORD=${password}`,
  `OPENCODE_USER=${user}`,
  `XDG_DATA_HOME=${dataDir}`,
  "",
].join("\n");
writeFileSync(join(USERS_DIR, `${user}.env`), env, { mode: 0o600 });

daemonReload();
try { sysctl(["enable", "--now", `opencode@${user}.service`]); }
catch (e) { console.error(JSON.stringify({ ok: false, error: String(e.stderr || e.message).slice(0, 400) })); process.exit(1); }

// Certificat TLS + vhost nginx pour <user>.dev.madatalk.fr (HTTP-01, aucune
// config DNS par utilisateur — le wildcard *.dev.madatalk.fr pointe déjà ici).
const HOST = `${user}.dev.madatalk.fr`.toLowerCase();
const BASE_DOMAIN = process.env.OPENCODE_OC_BASE_DOMAIN || "dev.madatalk.fr";
let certOk = false;
try {
  execFileSync("certbot", ["certonly", "--nginx", "-d", HOST, "--non-interactive", "--agree-tos", "--keep-until-expiring"], { encoding: "utf8", timeout: 180000 });
  certOk = true;
} catch (e) { console.error("certbot:", String((e && e.stderr) || (e && e.message) || e).slice(0, 300)); }

const conf = `# ${HOST} — instance opencode DÉDIÉE de ${user} (identité par utilisateur)
server {
    server_name ${HOST};
    location / {
        proxy_pass http://127.0.0.1:${port};
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_buffering off;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }
    listen [::]:443 ssl;
    listen 443 ssl;
    ssl_certificate /etc/letsencrypt/live/${HOST}/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/${HOST}/privkey.pem;
    include /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;
}
server {
    listen 80;
    listen [::]:80;
    server_name ${HOST};
    return 301 https://$host$request_uri;
}
`;
writeFileSync(`/etc/nginx/sites-available/oc-${user}.conf`, conf, { mode: 0o644 });
try { execFileSync("ln", ["-sf", `/etc/nginx/sites-available/oc-${user}.conf`, `/etc/nginx/sites-enabled/oc-${user}.conf`]); } catch {}
try { execFileSync("nginx", ["-t"], { stdio: "pipe" }); execFileSync("systemctl", ["reload", "nginx"]); }
catch (e) { console.error("nginx reload:", String((e && e.stderr) || (e && e.message) || e).slice(0, 300)); }

console.log(JSON.stringify({ ok: true, user, port, service: `opencode@${user}.service`, dataDir, url: `https://${HOST}`, certOk, auth: authMode }));
