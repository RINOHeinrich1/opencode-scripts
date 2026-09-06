#!/usr/bin/env node
// e2e-run-ci.mjs — Pont CI/CD ↔ registre E2E (ADR 10, étape post-déploiement).
//
// Résout les tests E2E ACTIVE du registre (e2e_tests) pour les projets couverts
// cibles (mada-talk front + oniria console), déclenche e2e_run (origin=ci,
// baseUrl préprod) pour chacun d'eux en séquence STRICTE (Supabase préprod
// partagée : « un seul run à la fois »), puis émet la preuve JSON : la liste
// des exécutions importées.
//
// Usage (depuis un checkout applicatif hôte — compat process.cwd()) :
//   node e2e-run-ci.mjs [--project <id> | --projects a,b] [--repoDir <dir>]
//                       [--baseUrl <url>] [--taskId T-...] [--origin ci]
//                       [--dryRun]
//
//   --project / --projects : projets cibles (défaut : mada-talk,oniria).
//   --repoDir / --baseUrl  : surcharges appliquées à TOUS les projets (sinon
//                            résolus depuis project_list : e2eRepoDir/e2eBaseUrl).
//   --taskId               : tâche origine associée aux exécutions (tracée).
//   --origin               : origine du run (défaut : ci).
//   --dryRun               : résolution seule (tests ACTIVE groupés), aucun run.
//
// Codes de sortie :
//   0 = OK — mécanisme de run réalisé (y compris échecs E2E : NON bloquant).
//   1 = config/données (projet inconnu, repoDir/baseUrl non résolus, aucun test
//       ACTIVE, origin invalide).
//   2 = erreur registre/MCP (project_list / e2e_list / e2e_run échoué).
//
// Sortie : JSON proof sur stdout ({ ok, origin, startedAt, finishedAt, projects[],
// executions[], failures[], summary }) — rien d'autre sur stdout.

import { resolve } from "node:path";
// Pont MCP stdio existant (épaulé par e2e-run-worker.mjs du panel) — réutilisé
// par import absolu (convention du repo : record-permission.mjs / resolve-permission.mjs).
import { taskOrchestrator } from "/root/orchestrator-panel/mcp-client.mjs";

// --- Constantes de configuration (A004) -------------------------------------
const DEFAULT_PROJECTS = ["mada-talk", "oniria"]; // front SPA + console admin
const DEFAULT_ORIGIN = "ci";
const ACTIVE_STATUS = "ACTIVE";
const LIST_LIMIT = 500;
const VALID_ORIGINS = ["task", "recette", "ci", "manual", "session"];

// --- Helpers -----------------------------------------------------------------

// Lecture d'argument CLI `--name value` (même signature qu'e2e-runner.mjs).
function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : def;
}

// Erreur de config/données (→ exit 1). Distincte des erreurs registre/MCP (→ exit 2).
class UsageError extends Error {}

function parseConfig() {
  const origin = arg("origin", DEFAULT_ORIGIN);
  if (!VALID_ORIGINS.includes(origin)) {
    throw new UsageError(`origin invalide : "${origin}" (attendu : ${VALID_ORIGINS.join(", ")})`);
  }
  const single = arg("project");
  const multi = arg("projects");
  if (single && multi) throw new UsageError("fournir --project OU --projects, pas les deux");
  let projects;
  if (single) projects = [single];
  else if (multi) projects = multi.split(",").map((s) => s.trim()).filter(Boolean);
  else projects = [...DEFAULT_PROJECTS];
  return {
    projects,
    repoDir: arg("repoDir"),
    baseUrl: arg("baseUrl"),
    taskId: arg("taskId"),
    origin,
    dryRun: process.argv.includes("--dryRun"),
  };
}

// Résout la méta par projet (checkout hôte + URL préprod) depuis le registre.
async function resolveProjectMeta(config) {
  const res = await taskOrchestrator("project_list", {}); // échec → infra (exit 2)
  const list = (res && Array.isArray(res.projects)) ? res.projects : [];
  const byId = new Map(list.map((p) => [p.id, p]));
  const metas = [];
  for (const id of config.projects) {
    const p = byId.get(id);
    if (!p) throw new UsageError(`projet inconnu dans le registre : "${id}" (vérifier project_list)`);
    const repoDirRaw = config.repoDir || p.e2eRepoDir || "";
    const repoDir = repoDirRaw ? resolve(repoDirRaw) : "";
    const baseUrl = config.baseUrl || p.e2eBaseUrl || "";
    if (!repoDir) throw new UsageError(`repoDir non résolu pour "${id}" (e2eRepoDir registre vide et pas de --repoDir)`);
    if (!baseUrl) throw new UsageError(`baseUrl non résolue pour "${id}" (e2eBaseUrl registre vide et pas de --baseUrl)`);
    metas.push({ id, name: p.name || id, repoDir, baseUrl });
  }
  return metas;
}

// Résout les tests ACTIVE du registre pour un projet couvert (dédupliqués).
async function resolveActiveTests(projectId) {
  const res = await taskOrchestrator("e2e_list", { status: ACTIVE_STATUS, project: projectId, limit: LIST_LIMIT });
  const tests = (res && Array.isArray(res.tests)) ? res.tests : [];
  const seen = new Set();
  const out = [];
  for (const t of tests) {
    if (!t || !t.e2eTestId || seen.has(t.e2eTestId)) continue;
    seen.add(t.e2eTestId);
    out.push(t);
  }
  return out;
}

// Groupement par specFile : un spec = plusieurs scénarios (entités) ; un seul
// e2e_run par spec via le test représentatif (évite les doublons d'entités).
function groupBySpec(tests) {
  const bySpec = new Map();
  for (const t of tests) {
    const key = t.specFile || "(spec inconnu)";
    if (!bySpec.has(key)) bySpec.set(key, []);
    bySpec.get(key).push(t);
  }
  return [...bySpec.entries()].map(([specFile, group]) => ({
    specFile,
    representative: group[0].e2eTestId,
    count: group.length,
  }));
}

// Déclenche e2e_run (origin=ci, cible préprod) pour un groupe de spec.
async function runSpecGroup(meta, group, config) {
  const payload = {
    project: meta.id,
    repoDir: meta.repoDir,
    baseUrl: meta.baseUrl,
    e2eTestId: group.representative, // résout specPattern = specFile canonique
    origin: config.origin,
  };
  if (config.taskId) payload.taskId = config.taskId;
  const res = await taskOrchestrator("e2e_run", payload); // échec MCP → throw → infra
  if (!res || res.ok !== true) {
    const msg = (res && (res.error || res.message)) ? String(res.error || res.message) : "e2e_run a répondu ok=false";
    throw new Error(msg);
  }
  return { runId: res.runId, results: Array.isArray(res.results) ? res.results : [] };
}

async function main() {
  const startedAt = new Date().toISOString();
  let config;
  try {
    config = parseConfig();
  } catch (e) {
    if (e instanceof UsageError) { console.error(`ERREUR (usage) : ${e.message}`); process.exit(1); }
    throw e;
  }

  const out = {
    ok: false,
    origin: config.origin,
    dryRun: config.dryRun,
    startedAt,
    projects: [],
    executions: [],
    failures: [],
    summary: {},
  };
  let infraErrors = 0;
  let dataErrors = 0;
  let runsTriggered = 0;
  let passed = 0;
  let failed = 0;

  const recordInfra = (project, step, err) => {
    infraErrors++;
    out.failures.push({ kind: "infra", project, step, error: err && err.message ? err.message : String(err) });
    console.error(`ERREUR MCP (${project}, ${step}) : ${err && err.message ? err.message : err}`);
  };
  const recordData = (project, reason) => {
    dataErrors++;
    out.failures.push({ kind: "config", project, error: reason });
    console.error(`DONNÉES (${project}) : ${reason}`);
  };

  // --- Résolution des métadonnées projets (project_list) ---------------------
  let metas;
  try {
    metas = await resolveProjectMeta(config);
  } catch (e) {
    if (e instanceof UsageError) { console.error(`ERREUR (config) : ${e.message}`); process.exit(1); }
    recordInfra("(tous)", "project_list", e);
    out.finishedAt = new Date().toISOString();
    out.summary = { projects: 0, specGroups: 0, runsTriggered: 0, executions: 0, passed: 0, failed: 0, infraErrors, dataErrors };
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
    process.exit(2);
  }

  // --- Séquence stricte : un projet puis un spec à la fois (jamais Promise.all)
  for (const meta of metas) {
    const proj = { id: meta.id, name: meta.name, repoDir: meta.repoDir, baseUrl: meta.baseUrl, testsCount: 0, specGroups: [] };
    out.projects.push(proj);

    // Résolution des tests ACTIVE (e2e_list) — échec = infra, on continue.
    let tests;
    try {
      tests = await resolveActiveTests(meta.id);
    } catch (e) {
      recordInfra(meta.id, "e2e_list", e);
      continue;
    }
    if (!tests.length) {
      recordData(meta.id, "aucun test E2E ACTIVE dans le registre — run impossible");
      continue;
    }
    proj.testsCount = tests.length;
    const groups = groupBySpec(tests);
    proj.specGroups = groups;

    if (config.dryRun) continue; // résolution seule

    for (const group of groups) {
      let run;
      try {
        run = await runSpecGroup(meta, group, config); // e2e_run (origin=ci)
      } catch (e) {
        recordInfra(meta.id, `e2e_run ${group.specFile}`, e);
        continue;
      }
      runsTriggered++;
      for (const r of run.results) {
        const exec = {
          project: meta.id,
          runId: run.runId,
          specFile: group.specFile,
          e2eTestId: r.e2eTestId,
          executionId: r.executionId,
          status: r.status,
          scenario: r.scenario,
          summary: r.summary || null,
        };
        out.executions.push(exec);
        if (r.status === "FAILED" || r.status === "ERROR") {
          failed++;
          out.failures.push({ kind: "e2e", ...exec }); // échec E2E : NON bloquant
        } else {
          passed++;
        }
      }
    }
  }

  out.finishedAt = new Date().toISOString();
  const totalGroups = out.projects.reduce((n, p) => n + p.specGroups.length, 0);
  out.summary = {
    projects: out.projects.length,
    specGroups: totalGroups,
    runsTriggered,
    executions: out.executions.length,
    passed,
    failed,
    infraErrors,
    dataErrors,
  };
  out.ok = infraErrors === 0 && dataErrors === 0;

  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
  process.exit(infraErrors > 0 ? 2 : (dataErrors > 0 ? 1 : 0));
}

main();
