#!/usr/bin/env node
/**
 * migrate-old-sprints.mjs — MIGRATION DES ANCIENS SPRINTS d'un projet (ou de
 * tous) : rattache les éléments hérités (pièces client, fonctionnalités, règles
 * métier, anciennes tâches, recettes) à l'ANCIEN SPRINT du projet (sprint par
 * défaut : ex. myxmax 14/09/2026, madatalk 07/09/2026) et ouvre la session de
 * migration (`migrations`, type dédié) qui porte l'agent-migration.
 *
 * GARANTIES :
 *   - IDEMPOTENT : `migration_start` (une seule migration par projet) et
 *     `sprint_migrate_elements` (INSERT ... ON CONFLICT DO NOTHING) — relancer
 *     ne duplique rien ;
 *   - AUCUN FAUX ÉMERGENT : les rattachements sont des INSERT DIRECTS ; le
 *     script n'appelle JAMAIS `attachPiecesToSprint` et n'écrit AUCUN marqueur
 *     `emergent`/`emergent_origin` (l'émergence n'est pas rétroactive,
 *     ADR-001 §5) ;
 *   - SANS PERTE : la conversion des ADR monolithiques en ADR atomiques n'est
 *     PAS automatique ici (gouvernance : proposition par l'agent-migration +
 *     validation utilisateur). Le script ouvre/ancre la session et rattache
 *     l'existant.
 *
 * Usage :
 *   node migrate-old-sprints.mjs --project <projectId>
 *   node migrate-old-sprints.mjs --all
 *   node migrate-old-sprints.mjs --project <id> --finish      # clôture (done)
 *   node migrate-old-sprints.mjs --project <id> --report      # lecture seule
 *
 * Options :
 *   --project <id>   migre (ou relance) ce projet.
 *   --all            migre TOUS les projets du registre.
 *   --start-date <iso>  début du sprint par défaut (à la CRÉATION seulement).
 *   --end-date <iso>    échéance du sprint par défaut (à la CRÉATION seulement).
 *   --finish         clôture la migration (`migration_finish`, status=done).
 *   --abort          clôture la migration (status=aborted).
 *   --report         n'écrit rien : affiche l'état des migrations (lecture seule).
 *
 * Env :
 *   MIGRATION_DB_PATH  chemin du `db.mjs` du MCP (défaut :
 *                      ../mcp/task-orchestrator/db.mjs) — cible un checkout précis.
 *
 * Sortie : JSON `{ ok, scope, results }`.
 * Code de sortie : 0 = succès, 1 = erreur.
 */
import { pathToFileURL } from "node:url";

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : undefined;
}
const has = (name) => process.argv.includes(`--${name}`);

const projectId = arg("project") || null;
const all = has("all");
const report = has("report");
const finish = has("finish");
const abort = has("abort");
const startDate = arg("start-date") || undefined;
const endDate = arg("end-date") || undefined;

if (!projectId && !all) {
  process.stdout.write(JSON.stringify({ ok: false, error: "précisez --project <projectId> ou --all." }, null, 2) + "\n");
  process.exit(1);
}
if (projectId && all) {
  process.stdout.write(JSON.stringify({ ok: false, error: "--project et --all sont exclusifs." }, null, 2) + "\n");
  process.exit(1);
}
if (finish && abort) {
  process.stdout.write(JSON.stringify({ ok: false, error: "--finish et --abort sont exclusifs." }, null, 2) + "\n");
  process.exit(1);
}

const dbUrl = process.env.MIGRATION_DB_PATH
  ? pathToFileURL(process.env.MIGRATION_DB_PATH).href
  : new URL("../mcp/task-orchestrator/db.mjs", import.meta.url).href;

const out = { ok: false, scope: projectId || "(tous)", mode: report ? "report" : (finish ? "finish" : abort ? "abort" : "migrate"), results: [] };

try {
  const db = await import(dbUrl);

  // Cibles : un projet, ou tous les projets du registre.
  let targets;
  if (projectId) {
    targets = [projectId];
  } else {
    const pr = await db.listProjects();
    targets = ((pr && pr.projects) || pr || []).map((p) => p.id).filter(Boolean);
  }

  for (const pid of targets) {
    const row = { project: pid };
    try {
      if (report) {
        const migs = await db.listMigrations({ project: pid });
        row.migrations = migs;
        row.ok = true;
      } else if (finish || abort) {
        // Clôture de la migration existante (sinon : erreur explicite).
        const migs = await db.listMigrations({ project: pid });
        if (!migs.length) { row.ok = false; row.error = "aucune migration pour ce projet (lancez d'abord la migration)"; }
        else {
          const m = await db.finishMigration({ migrationId: migs[0].migrationId, status: finish ? "done" : "aborted" });
          row.migration = m; row.ok = true;
        }
      } else {
        // 1) Session de migration (idempotente) ancrée sur le sprint par défaut.
        const started = await db.startMigration({ projectId: pid, startDate, endDate, createdBy: "migrate-old-sprints" });
        // 2) Rattachement des éléments hérités à l'ancien sprint (anti-émergent).
        const migrated = await db.migrateProjectElementsToDefaultSprint({ projectId: pid, createdBy: "migrate-old-sprints" });
        row.migration = started.migration;
        row.sprint = { id: started.sprint.id, title: started.sprint.title, startDate: started.sprint.startDate, endDate: started.sprint.endDate, isDefault: started.sprint.isDefault, status: started.sprint.status };
        row.attached = {
          fonctionnalites: migrated.fonctionnalites,
          regles: migrated.regles,
          pieces: migrated.pieces,
          tasks: migrated.tasks,
          cadrages: migrated.cadrages,
        };
        row.ok = true;
      }
    } catch (e) {
      row.ok = false;
      row.error = String((e && e.message) || e);
    }
    out.results.push(row);
  }

  out.ok = out.results.every((r) => r.ok);
} catch (e) {
  out.error = String((e && e.message) || e);
}

process.stdout.write(JSON.stringify(out, null, 2) + "\n");
process.exit(out.ok ? 0 : 1);
