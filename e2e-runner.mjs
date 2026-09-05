#!/usr/bin/env node
// e2e-runner.mjs — Exécuteur E2E Playwright « instance éphémère » (cadrage 07).
//
// À lancer DANS le dépôt applicatif (build de la branche disponible) par le CI :
//   node e2e-runner.mjs --runId <runId> --project <projet> [--taskId T-...]
//        [--attempts N] [--out <dossier-inbox-parent>] [-- --playwright-args...]
//
// 1) Lance `npx playwright test --reporter=json` (+ args éventuels : --project,
//    --grep, fichiers spec…) ;
// 2) Parse le rapport JSON (statuts, durées, vidéos via attachments) ;
// 3) Écrit storage/e2e/inbox/<runId>/manifest.json + copie les vidéos — le
//    collecteur (panel `POST /api/e2e/collect` ou MCP `e2e_collect`) importe.
// Le verdict est porté par le RAPPORT TEXTE ; la vidéo est une preuve humaine.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, rmSync } from "node:fs";
import { join, resolve, relative, basename } from "node:path";

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : def;
}

const runId = arg("runId");
if (!runId) { console.error("runId requis (--runId)"); process.exit(1); }
const project = arg("project");
const taskId = arg("taskId");
const attempts = Number(arg("attempts", "1")) || 1;
const outBase = resolve(arg("out", "/root/orchestrator-panel/storage/e2e/inbox"));
const runDir = join(outBase, runId);
mkdirSync(runDir, { recursive: true });

// Arguments Playwright après le séparateur "--".
const dd = process.argv.indexOf("--");
const pwArgs = dd >= 0 ? process.argv.slice(dd + 1) : [];
const cmd = ["playwright", "test", "--reporter=json", ...pwArgs];

let raw = "";
let failedLaunch = false;
try {
  raw = execFileSync("npx", cmd, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 30 * 60 * 1000 });
} catch (e) {
  failedLaunch = true;
  raw = (e.stdout || "").toString();
  console.error("playwright sortie non nulle :", (e.stderr || "").toString().slice(0, 500));
}

let parsed = null;
try { parsed = JSON.parse(raw); } catch { parsed = null; }

const results = [];
if (parsed && Array.isArray(parsed.suites)) {
  const walk = (suite) => {
    for (const spec of suite.specs || []) {
      for (const test of spec.tests || []) {
        for (const res of test.results || []) {
          const statusMap = { passed: "PASSED", failed: "FAILED", timedOut: "FAILED", skipped: "SKIPPED", interrupted: "ERROR" };
          const status = statusMap[res.status] || (failedLaunch ? "ERROR" : "ERROR");
          let videoFile = null;
          let i = 0;
          for (const att of res.attachments || []) {
            if ((att.name === "video" || /video/.test(att.contentType || "")) && att.path) {
              const vname = `video-${runId}-${results.length}-${++i}${basename(att.path)}`;
              try { copyFileSync(att.path, join(runDir, vname)); videoFile = vname; } catch {}
            }
          }
          const entry = {
            specFile: relative(process.cwd(), spec.file || "").replace(/\\/g, "/") || spec.file,
            scenario: test.title || spec.title || "scénario",
            title: test.title || null,
            status,
            durationMs: res.duration || 0,
            videoFile,
            error: (res.error && res.error.message) ? res.error.message.slice(0, 400) : null,
            summary: res.status === "passed"
              ? `PASS ${test.title}`
              : ((res.error && res.error.message) ? `Échec : ${res.error.message.slice(0, 300)}` : `Statut ${res.status}`),
          };
          results.push(entry);
        }
      }
    }
    for (const child of suite.suites || []) walk(child);
  };
  for (const suite of parsed.suites) walk(suite);
}

if (!results.length) {
  results.push({ specFile: "—", scenario: "(aucun test exécuté)", title: null, status: failedLaunch ? "ERROR" : "SKIPPED", durationMs: 0, error: raw.slice(0, 400) || "aucun résultat", summary: "aucun test exécuté (erreur de lancement ou filtre vide)" });
}

const manifest = {
  runId,
  project,
  taskId: taskId || null,
  attempts,
  executedAt: new Date().toISOString(),
  // Traçabilité : args Playwright réellement transmis (config dédiée, project
  // Playwright, filtres de spec…) + vars d'environnement cible utilisées.
  pwArgs,
  e2eBaseUrl: process.env.ONIRIA_E2E_BASE_URL || process.env.E2E_BASE_URL || null,
  results,
};
const manifestPath = join(runDir, "manifest.json");
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
console.log(`E2E manifest écrit : ${manifestPath}`);
console.log(`Playwright args : ${pwArgs.length ? pwArgs.join(" ") : "(config par défaut du dépôt)"}`);
console.log(`Tests : ${results.length} (${results.filter((r) => r.status === "PASSED").length} PASS, ${results.filter((r) => r.status === "FAILED").length} FAIL, ${results.filter((r) => r.status === "SKIPPED").length} SKIPPED)`);
