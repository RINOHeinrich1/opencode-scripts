#!/usr/bin/env node
// opencode-auth-sync.mjs — Synchronise les identifiants fournisseurs LLM
// (auth.json) de l'instance de RÉFÉRENCE vers TOUTES les instances opencode
// dédiées par utilisateur.
//
// Contexte : le data dir opencode est isolé par utilisateur (XDG_DATA_HOME), donc
// auth.json n'est PAS dans la config partagée. Le provisionnement en fait une
// copie initiale ; ce script maintient la copie à jour après tout ajout/rotation
// de clé (déclenché par l'unité systemd `opencode-auth-sync.path`).
//
// Usage : node opencode-auth-sync.mjs
// Env (surcharge) : OPENCODE_SHARED_AUTH, OPENCODE_USERS_DIR

import { readFileSync, writeFileSync, chmodSync, mkdirSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

const SRC = process.env.OPENCODE_SHARED_AUTH || "/root/.local/share/opencode/auth.json";
const USERS_DIR = process.env.OPENCODE_USERS_DIR || "/root/.config/opencode/users";

function log(msg) { console.log(`[auth-sync] ${new Date().toISOString()} ${msg}`); }

if (!existsSync(SRC)) {
  console.error(`[auth-sync] fichier de référence introuvable : ${SRC}`);
  process.exit(1);
}

const srcBuf = readFileSync(SRC);
const srcHash = createHash("sha256").update(srcBuf).digest("hex");

let synced = 0, skipped = 0, errors = 0;
for (const entry of readdirSync(USERS_DIR, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const ocDir = join(USERS_DIR, entry.name, "data", "opencode");
  const dst = join(ocDir, "auth.json");
  try {
    if (existsSync(dst)) {
      const dstHash = createHash("sha256").update(readFileSync(dst)).digest("hex");
      if (dstHash === srcHash) { skipped++; continue; }
    }
    mkdirSync(ocDir, { recursive: true });
    writeFileSync(dst, srcBuf, { mode: 0o600 });
    chmodSync(dst, 0o600);
    synced++;
    log(`synchronisé -> ${entry.name}`);
  } catch (e) {
    errors++;
    log(`ERREUR ${entry.name} : ${(e && e.message) || String(e)}`);
  }
}

log(`terminé : ${synced} synchronisé(s), ${skipped} déjà à jour, ${errors} erreur(s)`);
process.exit(errors ? 1 : 0);
