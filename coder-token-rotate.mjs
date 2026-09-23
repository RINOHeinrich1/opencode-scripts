#!/usr/bin/env node
// coder-token-rotate.mjs — Rotation du token Coder d'une organisation.
//
// Le serveur Coder plafonne la durée de vie des tokens (ici 168h = 7 jours).
// Ce script, exécuté périodiquement (timer systemd), recrée un token AVANT
// expiration (en utilisant le token courant pour s'authentifier) et met à jour
// le secret d'organisation. La chaîne ne casse donc jamais.
//
// Fiabilité (voir docs/runbook-rotation-token-coder.md) :
//   - heartbeat      : /var/lib/coder-token-rotate/state.json écrit à CHAQUE exécution ;
//   - observation    : un token absent/expiré déclenche la rotation (jamais de skip silencieux) ;
//   - échec bruyant  : alerte email (send-mail.mjs, throttlée 1×/jour) + code de sortie non nul ;
//   - auto-guérison  : bootstrapToken() via CODER_BOOTSTRAP_TOKEN ou la session CLI ~/.config/coderv2 ;
//   - supervision    : mode --health (LECTURE SEULE) avec codes 0/2/3/4.
//
// Usage :
//   node coder-token-rotate.mjs [--org onirtech] [--name oniria-panel]
//        [--lifetime 168h] [--min-remaining-hours 48] [--stale-hours 13]
//        [--force] [--bootstrap]
//   node coder-token-rotate.mjs --health
//
// Codes de sortie :
//   0  succès (rotation faite, ou token encore valide) ;
//   1  échec de la rotation (token NON renouvelé) ;
//   2  (--health) token expire bientôt (< min-remaining-hours) ;
//   3  (--health / rotation) token expiré ou introuvable — bootstrap requis ;
//   4  (--health) heartbeat périmé — la rotation ne tourne pas.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getOrganizationCoderConfig, registerOrganization } from "/root/.config/opencode/mcp/task-orchestrator/db.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : def;
}

const org = arg("org", "onirtech");
const name = arg("name", "oniria-panel");
const lifetime = arg("lifetime", "168h");
const force = process.argv.includes("--force");
const bootstrap = process.argv.includes("--bootstrap");
const healthOnly = process.argv.includes("--health");

// ─── A001 — constantes d'état / seuils / alerte ─────────────────────────────
// Centralise les chemins d'état et les seuils (heartbeat, alerte, rotation).
const STATE_DIR = process.env.CODER_ROTATE_STATE_DIR || "/var/lib/coder-token-rotate";
const STATE_FILE = join(STATE_DIR, "state.json");
const EMAIL_SCRIPT = process.env.CODER_ROTATE_EMAIL_SCRIPT || join(HERE, "send-mail.mjs");
// Heartbeat périmé : la rotation tourne toutes les 6 h ; > STALE_HOURS ⇒ 2 passages ratés.
const STALE_HOURS = Number(arg("stale-hours", process.env.CODER_ROTATE_STALE_HOURS || "13"));
const MIN_REMAINING_HOURS = Number(arg("min-remaining-hours", process.env.CODER_ROTATE_MIN_REMAINING_HOURS || "48"));

function log(m) { console.log(`[coder-token-rotate] ${new Date().toISOString()} — ${m}`); }
function nowIso() { return new Date().toISOString(); }

// ─── A002 — heartbeat d'état (observabilité) ────────────────────────────────
function readState() {
  try { return JSON.parse(readFileSync(STATE_FILE, "utf8")); } catch { return {}; }
}
// Écrit (fusion) l'état d'exécution. Ne contient JAMAIS de token en clair.
function writeState(patch) {
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    const next = { ...readState(), ...patch };
    writeFileSync(STATE_FILE, JSON.stringify(next, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
    return next;
  } catch (e) {
    log(`écriture de ${STATE_FILE} impossible : ${String(e.message).slice(0, 160)}`);
    return null;
  }
}

// ─── A003 — alerte email bruyante (throttlée 1×/jour via state.json) ────────
function notify(subject, body) {
  const today = nowIso().slice(0, 10);
  if (readState().lastAlertDate === today) {
    log(`alerte déjà envoyée aujourd'hui (${today}) — pas de nouvel email : ${subject}`);
    return false;
  }
  if (!existsSync(EMAIL_SCRIPT)) {
    log(`WARN : script email introuvable (${EMAIL_SCRIPT}) — alerte non envoyée : ${subject}`);
    return false;
  }
  // Réclame le créneau AVANT l'envoi (anti-concurrence : deux exécutions
  // simultanées ne peuvent pas envoyer deux alertes le même jour).
  writeState({ lastAlertDate: today });
  try {
    execFileSync(process.execPath, [EMAIL_SCRIPT, "--subject", subject, "--body", body], { stdio: "pipe", timeout: 30000 });
    log(`ALERTE email envoyée : ${subject}`);
    return true;
  } catch (e) {
    log(`échec de l'envoi de l'alerte email : ${String(e.stderr || e.message || e).slice(0, 200)}`);
    return false;
  }
}

const cfg = await getOrganizationCoderConfig(org);

// ─── A005 — config absente : statut explicite (rien à faire) ────────────────
if (!cfg || !cfg.url) {
  writeState({ lastRunAt: nowIso(), status: "no_config", org, tokenName: name, exitCode: 0 });
  log(`organisation ${org} sans URL Coder — rien à faire (no_config).`);
  process.exit(0);
}

function coderEnv(token) {
  const env = { ...process.env, CODER_URL: cfg.url };
  if (token) env.CODER_SESSION_TOKEN = token; else delete env.CODER_SESSION_TOKEN;
  return env;
}
function coder(args, token = cfg.token) {
  return execFileSync("coder", args, { encoding: "utf8", env: coderEnv(token), maxBuffer: 16 * 1024 * 1024 });
}

// ─── A004/A005 — expiration du token courant (token EXPIRÉ inclus) ──────────
// `--include-expired` est indispensable : sinon un token expiré disparaît de la
// liste et l'ancien code concluait à tort `remainingHours = Infinity` (skip).
let remainingHours = null;
let expiresAt = null;
let tokenFound = false;
let authRefused = false;

if (cfg.token) {
  try {
    const raw = coder(["tokens", "ls", "--include-expired", "--output", "json"]);
    const list = JSON.parse(raw);
    const arr = Array.isArray(list) ? list : (list.tokens || []);
    const mine = arr.find((t) => (t.token_name || t.name || t.Name) === name);
    if (mine) {
      tokenFound = true;
      const exp = mine.expires_at || mine.expiresAt || mine.ExpiresAt;
      if (exp && !String(exp).startsWith("1970")) {
        expiresAt = new Date(exp).toISOString();
        remainingHours = (new Date(exp).getTime() - Date.now()) / 3600000;
      }
    } else {
      log(`token ${name} absent de 'coder tokens ls --include-expired' — rotation forcée (token_missing).`);
    }
  } catch (e) {
    // Authentification refusée / session expirée : le token stocké n'est plus utilisable.
    authRefused = true;
    log(`authentification Coder refusée (${String(e.stderr || e.message).slice(0, 160)}) — token expiré/session invalide (token_expired).`);
  }
}

// ─── A009 — mode LECTURE SEULE --health (0/2/3/4, ne crée jamais de token) ──
if (healthOnly) {
  const st = readState();
  const now = Date.now();
  let code = 0;
  let reason = `token ${name} valide${remainingHours !== null ? ` (~${Math.round(remainingHours)} h)` : ""}, heartbeat à jour`;

  if (!cfg.token || authRefused || !tokenFound || (remainingHours !== null && remainingHours <= 0)) {
    code = 3;
    reason = !cfg.token
      ? `aucun token ${name} stocké pour l'organisation ${org} — bootstrap requis`
      : authRefused
        ? `authentification Coder refusée — token ${name} expiré/invalide — bootstrap requis`
        : !tokenFound
          ? `token ${name} introuvable dans 'coder tokens ls --include-expired' — rotation/bootstrapping requis`
          : `token ${name} EXPIRÉ${expiresAt ? ` (expires ${expiresAt})` : ""} — bootstrap requis`;
  } else if (remainingHours !== null && remainingHours < MIN_REMAINING_HOURS) {
    code = 2;
    reason = `token ${name} expire bientôt (~${Math.round(remainingHours)} h < ${MIN_REMAINING_HOURS} h)`;
  } else {
    const last = st.lastSuccessAt ? Date.parse(st.lastSuccessAt) : NaN;
    if (!last || Number.isNaN(last) || (now - last) > STALE_HOURS * 3600000) {
      code = 4;
      reason = st.lastSuccessAt
        ? `heartbeat périmé (dernier succès ${st.lastSuccessAt}, > ${STALE_HOURS} h) — la rotation ne tourne pas`
        : `aucun heartbeat (${STATE_FILE} absent ou illisible) — la rotation ne tourne pas`;
    }
  }

  log(`[health] ${reason} → exit ${code}`);
  if (code !== 0) {
    const label = code === 4
      ? "la rotation ne tourne pas"
      : code === 3
        ? "token expiré : bootstrap requis"
        : "token expire bientôt";
    notify(
      `[ALERT] Rotation token Coder : ${label} (org ${org})`,
      `coder-token-rotate --health a détecté un problème (org=${org}, name=${name}) :\n\n${reason}\n\n` +
      `État : ${STATE_FILE}\nSeuils : STALE_HOURS=${STALE_HOURS} h, MIN_REMAINING_HOURS=${MIN_REMAINING_HOURS} h\n` +
      `Code de sortie : ${code}\n\nProcédure de remise en service : docs/runbook-rotation-token-coder.md`,
    );
  }
  process.exit(code);
}

// ─── A006 — auto-guérison : credential de secours ───────────────────────────
// Renvoie un token utilisable pour s'authentifier auprès de Coder (afin de
// créer le nouveau token), ou null si aucun credential de secours n'existe.
function bootstrapToken() {
  const envTok = (process.env.CODER_BOOTSTRAP_TOKEN || "").trim();
  if (envTok) {
    log("bootstrap : credential de secours CODER_BOOTSTRAP_TOKEN utilisé.");
    return envTok;
  }
  const dir = process.env.CODER_CONFIG_DIR || join(homedir(), ".config", "coderv2");
  const sessionFile = join(dir, "session");
  try {
    if (existsSync(sessionFile)) {
      const sess = readFileSync(sessionFile, "utf8").trim();
      if (sess) {
        log(`bootstrap : session CLI ${sessionFile} utilisée.`);
        return sess;
      }
    }
  } catch (e) {
    log(`bootstrap : lecture de la session CLI impossible (${String(e.message).slice(0, 120)}).`);
  }
  log(`bootstrap : aucun credential de secours (ni CODER_BOOTSTRAP_TOKEN ni ${sessionFile}).`);
  return null;
}

// ─── A007 — décision de rotation ────────────────────────────────────────────
// Un token absent/expiré/illisible ne doit JAMAIS produire un skip silencieux.
const needRotation = force || bootstrap || !tokenFound || remainingHours === null || remainingHours <= MIN_REMAINING_HOURS;

if (!needRotation) {
  writeState({
    lastRunAt: nowIso(), lastSuccessAt: nowIso(), status: "valid",
    org, tokenName: name, remainingHours: Math.round(remainingHours), expiresAt, exitCode: 0,
  });
  log(`token ${name} encore valide ~${Math.round(remainingHours)} h (> ${MIN_REMAINING_HOURS} h) — pas de rotation.`);
  process.exit(0);
}

let credential = null;
let credentialSource = null;
const storedUsable = !!cfg.token && !authRefused && !(remainingHours !== null && remainingHours <= 0);
if (!bootstrap && storedUsable) {
  credential = cfg.token;
  credentialSource = "token stocké";
} else {
  credential = bootstrapToken();
  credentialSource = credential
    ? (process.env.CODER_BOOTSTRAP_TOKEN ? "CODER_BOOTSTRAP_TOKEN" : "session CLI ~/.config/coderv2")
    : null;
}

if (!credential) {
  const status = cfg.token ? "token_expired" : "token_missing";
  const detail =
    `Impossible de rotationner le token ${name} (org ${org}) : ` +
    (cfg.token ? "le token stocké est expiré/invalide" : "aucun token n'est stocké") +
    ` et aucun credential de secours valide n'est disponible ` +
    `(CODER_BOOTSTRAP_TOKEN absent, session CLI ~/.config/coderv2 absente).\n\n` +
    `Action requise : bootstrap admin Coder (coder login ${cfg.url}) — voir docs/runbook-rotation-token-coder.md.`;
  notify(`[ALERT] Rotation token Coder IMPOSSIBLE — ${status} (org ${org})`, detail);
  writeState({
    lastRunAt: nowIso(), status, org, tokenName: name,
    remainingHours: remainingHours === null ? null : Math.round(remainingHours), expiresAt, exitCode: 3,
  });
  log(`échec : ${status} — aucun credential utilisable.`);
  process.exit(3);
}

// ─── A007/A008 — création + persistance ; échec BRUYANT (A008) ──────────────
try {
  const newToken = coder(["tokens", "create", "--name", name, "--lifetime", lifetime], credential).trim();
  if (!newToken) throw new Error("token vide renvoyé");
  await registerOrganization({ id: org, name: org, coderToken: newToken });
  writeState({
    lastRunAt: nowIso(), lastSuccessAt: nowIso(), status: "rotated",
    org, tokenName: name, remainingHours: null, expiresAt: null, exitCode: 0,
  });
  log(`token ${name} renouvelé (lifetime ${lifetime}, credential=${credentialSource}) et secret d'organisation mis à jour.`);
  process.exit(0);
} catch (e) {
  const detail = String(e.stderr || e.message || e).slice(0, 300);
  notify(
    `[ALERT] Rotation token Coder ÉCHOUÉE (org ${org})`,
    `Échec de la rotation du token ${name} (org ${org}, credential=${credentialSource}) :\n\n${detail}\n\n` +
    `Voir docs/runbook-rotation-token-coder.md.`,
  );
  writeState({ lastRunAt: nowIso(), status: "failed", org, tokenName: name, exitCode: 1 });
  log(`échec de la rotation : ${detail}`);
  process.exit(1);
}
