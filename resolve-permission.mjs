#!/usr/bin/env node
/**
 * resolve-permission.mjs — Résout la décision d'une permission opencode
 * (approved/rejected) via son permission_id. Appelé sur `permission.replied`.
 *
 * NOTE : `resolveDecisionByPermissionId` est asynchrone (PostgreSQL) → `await`.
 */
import { resolveDecisionByPermissionId } from "/root/.config/opencode/mcp/task-orchestrator/db.mjs";

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : "";
}

const permissionId = arg("permissionId");
const status = arg("status"); // approved | rejected
const resolution = arg("resolution");

try {
  const d = await resolveDecisionByPermissionId(permissionId, status, resolution);
  if (d) {
    console.log(`décision résolue : ${d.decisionId} → ${d.status}`);
  } else {
    console.log(`aucune décision trouvée pour permission ${permissionId}`);
  }
} catch (e) {
  console.error(`erreur résolution : ${e.message}`);
}
