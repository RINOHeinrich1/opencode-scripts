#!/usr/bin/env node
// e2e-run-ci.mjs — Pont CI/CD ↔ registre E2E (ADR 10, étape post-déploiement ;
// modèle E2E ADR 11 : un test = 1 projet/produit + 1..N repos traversés).
//
// Résout les tests E2E ACTIVE du registre (e2e_list status=ACTIVE, filtre
// project = PROJET/produit) pour les projets cibles (mada-talk front + oniria
// console), déclenche e2e_run (origin=ci, cible préprod) pour chaque spec en
// séquence STRICTE (Supabase préprod partagée : « un seul run à la fois »), puis
// émet la preuve JSON : la liste des exécutions importées.
//
// ADR 11 (PENDANT exécution) : project_list n'expose plus e2eRepoDir/e2eBaseUrl
// au niveau projet ; la réponse d'un test porte project (produit) + repos[]
// (repos traversés). e2e_run, appelé avec e2eTestId (+ project) SANS repoDir,
// résout lui-même le repo d'exécution (celui du spec) et la baseUrl. Ce script
// n'appelle donc PLUS project_list : --repoDir/--baseUrl ne sont que des
// surcharges optionnelles (appliquées à tous les runs).
//
// Usage (depuis un checkout applicatif hôte — compat process.cwd()) :
//   node e2e-run-ci.mjs [--project <id> | --projects a,b] [--repoDir <dir>]
//                       [--baseUrl <url>] [--taskId T-...] [--origin ci]
//                       [--dryRun]
//
//   --project / --projects : projets cibles = PRODUITS (défaut : mada-talk,oniria).
//   --repoDir / --baseUrl  : surcharges OPTIONNELLES appliquées à TOUS les runs
//                            (sinon e2e_run résout repoDir/baseUrl du test, ADR 11).
//   --taskId               : tâche origine associée aux exécutions (tracée).
//   --origin               : origine du run (défaut : ci).
//   --dryRun               : résolution seule (tests ACTIVE groupés), aucun run.
//
// Codes de sortie :
//   0 = OK — mécanisme de run réalisé (y compris échecs E2E : NON bloquant).
//   1 = config/données (origin invalide, projet sans test ACTIVE, aucun test).
//   2 = erreur registre/MCP (e2e_list / e2e_run échoué).
//
// Sortie : JSON proof sur stdout ({ ok, origin, startedAt, finishedAt, projects[],
// executions[], failures[], summary }) — rien d'autre sur stdout.

import { resolve } from "node:path";
// Pont MCP stdio existant (épaulé par e2e-run-worker.mjs du panel) — réutilisé
// par import absolu (convention du repo : record-permission.mjs / resolve-permission.mjs).
import { taskOrchestrator } from "/root/orchestrator-panel/mcp-client.mjs";

// --- Constantes de configuration (A004) -------------------------------------
const DEFAULT_PROJECTS = ["mada-talk", "oniria"]; // produits : front SPA + console admin
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

// Résout les tests ACTIVE du registre pour un projet/produit couvert (dédupliqués).
// ADR 11 : le filtre project porte sur le PROJET (produit) ; chaque test expose
// repos[] (ids des repos traversés) — utilisé pour enrichir la preuve.
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

// Ids des repos traversés (dédupliqués) des tests d'un projet — enrichissement
// de la preuve (ADR 11). Tolerant : si e2e_list ne porte pas repos[], retourne [].
function reposTraversedBy(tests) {
  const ids = new Set();
  for (const t of tests) {
    for (const rid of Array.isArray(t.repos) ? t.repos : []) {
      if (rid) ids.add(String(rid));
    }
  }
  return [...ids].sort();
}

// Déclenche e2e_run (origin=ci, cible préprod) pour un groupe de spec.
// ADR 11 : payload minimal { project, e2eTestId, origin } (+ taskId) — le serveur
// résout repoDir/baseUrl depuis le test. repoDir/baseUrl ne sont passés que si
// l'utilisateur les fournit explicitement (surcharges CLI optionnelles).
async function runSpecGroup(projectId, group, config) {
  const payload = {
    project: projectId,
    e2eTestId: group.representative, // résout specPattern = specFile canonique + repo d'exécution
    origin: config.origin,
  };
  if (config.taskId) payload.taskId = config.taskId;
  if (config.repoDir) payload.repoDir = resolve(config.repoDir);
  if (config.baseUrl) payload.baseUrl = config.baseUrl;
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

  // --- Séquence stricte : un projet puis un spec à la fois (jamais Promise.all)
  // Pas de project_list : la sélection = e2e_list(status=ACTIVE, project) par
  // PROJET/produit ; repoDir/baseUrl résolus par e2e_run (ADR 11).
  for (const id of config.projects) {
    const proj = { id, name: id, testsCount: 0, specGroups: [], reposTraversed: [] };
    if (config.repoDir) proj.repoDir = resolve(config.repoDir);
    if (config.baseUrl) proj.baseUrl = config.baseUrl;
    out.projects.push(proj);

    // Résolution des tests ACTIVE (e2e_list) — échec = infra, on continue.
    let tests;
    try {
      tests = await resolveActiveTests(id);
    } catch (e) {
      recordInfra(id, "e2e_list", e);
      continue;
    }
    if (!tests.length) {
      recordData(id, "aucun test E2E ACTIVE dans le registre pour ce projet (produit) — run impossible");
      continue;
    }
    proj.testsCount = tests.length;
    proj.reposTraversed = reposTraversedBy(tests);
    const groups = groupBySpec(tests);
    proj.specGroups = groups;

    if (config.dryRun) continue; // résolution seule

    for (const group of groups) {
      let run;
      try {
        run = await runSpecGroup(id, group, config); // e2e_run (origin=ci)
      } catch (e) {
        recordInfra(id, `e2e_run ${group.specFile}`, e);
        continue;
      }
      runsTriggered++;
      for (const r of run.results) {
        const exec = {
          project: id,
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
