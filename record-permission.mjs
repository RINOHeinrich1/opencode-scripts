#!/usr/bin/env node
/**
 * record-permission.mjs — Enregistre une demande de permission opencode comme
 * décision humaine (dédoublonnée par permission_id) + envoie un email.
 * Appelé par le plugin `permission-hook` sur l'événement `permission.asked`.
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

const task = findTaskBySessionChain(sessionID);
const detail = `${type}${pattern ? " : " + pattern : ""}`;

let body = `Demande de permission détectée :\n` +
  `- type : ${type || "—"}\n` +
  `- pattern : ${pattern || "—"}\n` +
  `- titre : ${title || "—"}\n` +
  `- session : ${sessionID || "—"}\n` +
  `- permissionId : ${id || "—"}\n`;

let shouldEmail = true;

if (task) {
  // Dédoublonnage : une même permission → une seule décision + un seul email.
  const existing = id ? findDecisionByPermissionId(id) : null;
  if (existing) {
    body += `- déjà enregistrée (décision ${existing.decisionId}, statut ${existing.status})`;
    shouldEmail = false;
  } else {
    try {
      const d = requestDecision({ taskId: task.id, kind: "permission", ttlMinutes: 60, detail, permissionId: id || undefined });
      body += `- tâche : ${task.id}\n- décision : ${d.decisionId} (statut ${d.status})`;
    } catch (e) {
      body += `- tâche : ${task.id}\n- (enregistrement décision échoué : ${e.message})`;
    }
  }
} else {
  body += `- (aucune tâche liée à la session ${sessionID || "inconnue"})`;
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
