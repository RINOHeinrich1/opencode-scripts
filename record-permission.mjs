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
import { findTaskBySessionChain, findCarrierBySession, requestDecision, findDecisionByPermissionId } from "/root/.config/opencode/mcp/task-orchestrator/db.mjs";

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
  // ADR-007 volet 1 : une permission est tracée pour TOUTE session (tâche ou
  // non). On résout d'abord la tâche (chaîne parent incluse), sinon l'ENTITÉ
  // PORTEUSE de la session non-task (recette/cadrage/test/migration/sprint/
  // batch). `decisions.task_id` est désormais nullable.
  const task = await findTaskBySessionChain(sessionID);
  const carrier = task ? null : await findCarrierBySession(sessionID);
  // Dédoublonnage : une même permission → une seule décision.
  const existing = id ? await findDecisionByPermissionId(id) : null;
  if (existing) {
    console.log(`déjà enregistrée (décision ${existing.decisionId}, statut ${existing.status}) — pas de nouvelle décision`);
  } else {
    const d = await requestDecision({
      taskId: task?.id,                       // null si session non-task
      kind: "permission",
      ttlMinutes: 60,
      detail,
      permissionId: id || undefined,
      requestedBy: "permission-hook",
      sessionId: sessionID || undefined,
      carrierType: carrier?.type,
      carrierId: carrier?.id,
    });
    const scope = task ? `tâche ${task.id}` : carrier ? `entité ${carrier.type}:${carrier.id}` : "session libre (hors tâche)";
    console.log(`décision enregistrée : ${d.decisionId} (statut ${d.status}) — ${scope}`);
  }
} catch (e) {
  console.error(`enregistrement décision échoué : ${e.message}`);
}
