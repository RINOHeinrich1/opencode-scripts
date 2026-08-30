#!/usr/bin/env node
/**
 * record-permission.mjs — Enregistre une demande de permission opencode comme
 * décision humaine (dédoublonnée par permission_id).
 * Appelé par le plugin `permission-hook` sur l'événement `permission.asked`.
 *
 * v0.1.0 : AUCUN email envoyé ici. La décision `permission` est simplement
 * persistée dans le registre ; le daemon `opencode-notifier` observe la table
 * `decisions` (kind=permission, status=awaiting) et notifie l'utilisateur.
 *
 * NOTE : les fonctions du registre sont ASYNCHRONES (PostgreSQL) — il faut les
 * `await`, sinon `existing`/`task` restent des Promises (toujours truthy) et la
 * décision n'est jamais enregistrée.
 */
import { findTaskBySessionChain, requestDecision, findDecisionByPermissionId } from "/root/.config/opencode/mcp/task-orchestrator/db.mjs";

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : "";
}

const sessionID = arg("sessionID");
const type = arg("type");
const pattern = arg("pattern");
const title = arg("title");
const id = arg("id"); // permission id opencode (per_...)

const detail = `${type}${pattern ? " : " + pattern : ""}`;

try {
  const task = await findTaskBySessionChain(sessionID);
  if (task) {
    // Dédoublonnage : une même permission → une seule décision.
    const existing = id ? await findDecisionByPermissionId(id) : null;
    if (existing) {
      console.log(`déjà enregistrée (décision ${existing.decisionId}, statut ${existing.status}) — pas de nouvelle décision`);
    } else {
      const d = await requestDecision({
        taskId: task.id,
        kind: "permission",
        ttlMinutes: 60,
        detail,
        permissionId: id || undefined,
        requestedBy: "permission-hook",
        sessionId: sessionID || undefined,
      });
      console.log(`décision enregistrée : ${d.decisionId} (statut ${d.status})`);
    }
  } else {
    console.log(`(aucune tâche liée à la session ${sessionID || "inconnue"})`);
  }
} catch (e) {
  console.error(`enregistrement décision échoué : ${e.message}`);
}
