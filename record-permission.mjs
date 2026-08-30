#!/usr/bin/env node
/**
 * record-permission.mjs — Enregistre une demande de permission opencode comme
 * décision humaine (dédoublonnée par permission_id) + envoie un email.
 * Appelé par le plugin `permission-hook` sur l'événement `permission.asked`.
 *
 * NOTE : les fonctions du registre sont ASYNCHRONES (PostgreSQL) — il faut les
 * `await`, sinon `existing`/`task` restent des Promises (toujours truthy) et la
 * décision n'est jamais enregistrée.
 */
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { findTaskBySessionChain, requestDecision, findDecisionByPermissionId } from "/root/.config/opencode/mcp/task-orchestrator/db.mjs";

const MAIL = `${homedir()}/.config/opencode/scripts/send-mail.mjs`;

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

let body = `Demande de permission détectée :\n` +
  `- type : ${type || "—"}\n` +
  `- pattern : ${pattern || "—"}\n` +
  `- titre : ${title || "—"}\n` +
  `- session : ${sessionID || "—"}\n` +
  `- permissionId : ${id || "—"}\n`;

let shouldEmail = true;

try {
  const task = await findTaskBySessionChain(sessionID);
  if (task) {
    // Dédoublonnage : une même permission → une seule décision + un seul email.
    const existing = id ? await findDecisionByPermissionId(id) : null;
    if (existing) {
      body += `- déjà enregistrée (décision ${existing.decisionId}, statut ${existing.status})`;
      shouldEmail = false;
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
      body += `- tâche : ${task.id}\n- décision : ${d.decisionId} (statut ${d.status})`;
    }
  } else {
    body += `- (aucune tâche liée à la session ${sessionID || "inconnue"})`;
  }
} catch (e) {
  body += `- (enregistrement décision échoué : ${e.message})`;
}

if (shouldEmail) {
  try {
    execFileSync("node", [MAIL, "--subject", "[NOTIFY] Permission requise", "--body", body], { stdio: "pipe" });
    console.log("email envoyé");
  } catch (e) {
    console.error("email échoué :", e.message);
  }
} else {
  console.log("dédupliqué — pas de nouvel email");
}
