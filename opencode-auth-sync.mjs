#!/usr/bin/env node
// opencode-auth-sync.mjs — Synchronise les identifiants fournisseurs LLM
// (auth.json) vers TOUTES les instances opencode dédiées par utilisateur.
//
// Source de vérité : la table `provider_keys` du panneau (clé ACTIVE par
// fournisseur, chiffrée AES-256-GCM). Le module `provider-auth.mjs` régénère le
// fichier de RÉFÉRENCE puis propage à chaque `<usersDir>/<user>/data/opencode/
// auth.json` (idempotent : skip si identique → ne re-déclenche pas l'unité
// systemd `opencode-auth-sync.path` qui surveille le fichier de référence).
// REPLI : si le module/la base est indisponible, on retombe sur la recopie
// fichier → fichiers (comportement historique).
//
// Usage : node opencode-auth-sync.mjs
// Env (surcharge) : OPENCODE_SHARED_AUTH, OPENCODE_USERS_DIR, OPENCODE_PROVIDER_AUTH

import { readFileSync, writeFileSync, chmodSync, mkdirSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

const SRC = process.env.OPENCODE_SHARED_AUTH || "/root/.local/share/opencode/auth.json";
const USERS_DIR = process.env.OPENCODE_USERS_DIR || "/root/.config/opencode/users";
const PROVIDER_AUTH_MODULE = process.env.OPENCODE_PROVIDER_AUTH || "/root/orchestrator-panel/provider-auth.mjs";

function log(msg) { console.log(`[auth-sync] ${new Date().toISOString()} ${msg}`); }

// Repli : recopie fichier de référence → fichiers des instances (comportement
// historique, utilisé si le module de génération est indisponible).
function legacySync() {
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
  log(`terminé (repli recopie) : ${synced} synchronisé(s), ${skipped} déjà à jour, ${errors} erreur(s)`);
  process.exit(errors ? 1 : 0);
}

async function main() {
  try {
    const mod = await import(PROVIDER_AUTH_MODULE);
    const r = await mod.regenerateAndPropagate({ writeShared: true });
    if (r.providers > 0) {
      log(`terminé : ${r.providers} fournisseur(s) — ${r.synced} synchronisé(s), ${r.skipped} déjà à jour, ${r.errors} erreur(s)`);
      process.exit(r.errors ? 1 : 0);
    }
    log("aucune clé active en base — repli sur la recopie du fichier de référence");
  } catch (e) {
    log(`module provider-auth indisponible (${(e && e.message) || e}) — repli recopie`);
  }
  legacySync();
}

main();
