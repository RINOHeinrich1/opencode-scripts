#!/usr/bin/env node
/**
 * requalify-pieces-client.mjs — Requalification SANS PERTE des documents ADR-12
 * en PIÈCES CLIENT d'un projet (ADR-001, item 4).
 *
 * Une pièce client est la matière première d'un sprint. Les documents ADR-12
 * existants (adr / specs / gherkin / project_doc) sont CONSERVÉS et requalifiés :
 * la fonction `requalifyDocsAsPieces` (MCP task-orchestrator) n'écrit QUE le
 * marqueur `meta` (`piece_client`, `piece_nature`, `requalified_at`,
 * `requalified_from_doc_type`) — jamais `doc_type` / `content_id` / `path` ni les
 * liens `artifact_projects` / `artifact_repos`. Opération IDEMPOTENTE.
 *
 * Usage :
 *   node requalify-pieces-client.mjs --project <projectId>
 *   node requalify-pieces-client.mjs --all            # tous les docs ADR-12
 *
 * Options :
 *   --project <id>   ne requalifie que les docs du projet.
 *   --all            requalifie TOUS les docs ADR-12 du registre.
 *   --dry-run        (informatif) n'écrit rien — non supporté par le MCP : refusé.
 *
 * Env :
 *   PIECES_DB_PATH   chemin du `db.mjs` du MCP (défaut : ../mcp/task-orchestrator/db.mjs).
 *                    Permet de cibler un checkout/worktree précis (tests).
 *
 * Sortie : JSON `{ ok, projectId, count, total, alreadyRequalified, requalified }`.
 * Code de sortie : 0 = succès, 1 = erreur.
 */
import { pathToFileURL } from "node:url";

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : undefined;
}

const has = (name) => process.argv.includes(`--${name}`);

const projectId = arg("project") || null;
if (has("dry-run")) {
  process.stdout.write(JSON.stringify({ ok: false, error: "--dry-run non supporté : la requalification est idempotente et sans perte (relancer sans risque)." }, null, 2) + "\n");
  process.exit(1);
}

const dbUrl = process.env.PIECES_DB_PATH
  ? pathToFileURL(process.env.PIECES_DB_PATH).href
  : new URL("../mcp/task-orchestrator/db.mjs", import.meta.url).href;

try {
  const { requalifyDocsAsPieces } = await import(dbUrl);
  const report = await requalifyDocsAsPieces({ projectId: projectId || undefined });
  process.stdout.write(JSON.stringify({ ok: true, projectId: projectId || "(tous)", ...report }, null, 2) + "\n");
  process.exit(0);
} catch (e) {
  process.stdout.write(JSON.stringify({ ok: false, projectId: projectId || "(tous)", error: String((e && e.message) || e) }, null, 2) + "\n");
  process.exit(1);
}
