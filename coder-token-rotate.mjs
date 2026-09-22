#!/usr/bin/env node
// coder-token-rotate.mjs — Rotation du token Coder d'une organisation.
//
// Le serveur Coder plafonne la durée de vie des tokens (ici 168h = 7 jours).
// Ce script, exécuté périodiquement, recrée un token AVANT expiration (en
// utilisant le token courant pour s'authentifier) et met à jour le secret
// d'organisation. La chaîne ne casse donc jamais.
//
// Usage :
//   node coder-token-rotate.mjs [--org onirtech] [--name oniria-panel]
//        [--lifetime 168h] [--min-remaining-hours 48] [--force]
//
// Idempotent : ne tourne que si le token courant expire dans < min-remaining-hours.

import { execFileSync } from "node:child_process";
import { getOrganizationCoderConfig, registerOrganization } from "/root/.config/opencode/mcp/task-orchestrator/db.mjs";

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : def;
}

const org = arg("org", "onirtech");
const name = arg("name", "oniria-panel");
const lifetime = arg("lifetime", "168h");
const minRemainingHours = Number(arg("min-remaining-hours", "48"));
const force = process.argv.includes("--force");

function log(m) { console.log(`[coder-token-rotate] ${new Date().toISOString()} — ${m}`); }

const cfg = await getOrganizationCoderConfig(org);
if (!cfg || !cfg.url) { log(`organisation ${org} sans URL Coder — rien à faire.`); process.exit(0); }
if (!cfg.token) { log(`organisation ${org} sans token Coder — rien à faire (bootstrap requis).`); process.exit(0); }

const env = { ...process.env, CODER_URL: cfg.url, CODER_SESSION_TOKEN: cfg.token };

function coder(args, input) {
  return execFileSync("coder", args, { encoding: "utf8", env, input, maxBuffer: 16 * 1024 * 1024 });
}

// 1. Expiration du token courant (via la liste des tokens).
let remainingHours = Infinity;
try {
  const raw = coder(["tokens", "ls", "--output", "json"]);
  const list = JSON.parse(raw);
  const arr = Array.isArray(list) ? list : (list.tokens || []);
  const mine = arr.find((t) => (t.token_name || t.name || t.Name) === name);
  if (mine) {
    const exp = mine.expires_at || mine["expires_at"] || mine.expiresAt || mine.ExpiresAt;
    if (exp && !String(exp).startsWith("1970")) {
      remainingHours = (new Date(exp).getTime() - Date.now()) / 3600000;
    }
  }
} catch (e) {
  log(`lecture de l'expiration impossible (${String(e.message).slice(0, 120)}) — rotation forcée.`);
  remainingHours = 0;
}

if (!force && remainingHours > minRemainingHours) {
  log(`token ${name} encore valide ~${Math.round(remainingHours)} h (> ${minRemainingHours} h) — pas de rotation.`);
  process.exit(0);
}

// 2. Crée un nouveau token et remplace le secret d'organisation.
try {
  const newToken = coder(["tokens", "create", "--name", name, "--lifetime", lifetime]).trim();
  if (!newToken) throw new Error("token vide renvoyé");
  await registerOrganization({ id: org, name: org, coderToken: newToken });
  log(`token ${name} renouvelé (lifetime ${lifetime}) et secret d'organisation mis à jour.`);
} catch (e) {
  log(`échec de la rotation : ${String((e.stderr || e.message || e)).slice(0, 300)}`);
  process.exit(1);
}
