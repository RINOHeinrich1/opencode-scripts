// load-env.mjs — Chargement centralisé du fichier .env global opencode.
//
// Lit un fichier au format KEY=VALUE (lignes vides et commentaires `#` ignorés,
// guillemets simples/doubles tolérés) et ne SURCHARGE JAMAIS une variable déjà
// présente dans l'environnement (`process.env` prime). Utilisé par
// `task-orchestrator`, `plan-manager` (via `loadGlobalEnv()`) et, sur le même
// principe, par `orchestrator-panel` (son propre `env.mjs`).
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// Chemin du .env global (hôte) : ~/.config/opencode/.env
export const GLOBAL_ENV_PATH = join(homedir(), ".config", "opencode", ".env");

/**
 * Charge un fichier .env : ne définit `process.env[key]` que si la clé n'est
 * pas déjà présente dans l'environnement (aucun écrasement).
 * @param {string} path Chemin du fichier .env.
 * @returns {boolean} true si le fichier existe et a été lu, false sinon.
 */
export function loadEnvFile(path) {
  if (!path || !existsSync(path)) return false;
  for (const rawLine of readFileSync(path, "utf8").split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    if (!key) continue;
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
  return true;
}

/**
 * Charge le .env global (~/.config/opencode/.env).
 * @returns {boolean} true si le fichier existe et a été lu, false sinon.
 */
export function loadGlobalEnv() {
  return loadEnvFile(GLOBAL_ENV_PATH);
}
