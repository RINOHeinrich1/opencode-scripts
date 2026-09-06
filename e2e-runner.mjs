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
  const statusMap = { passed: "PASSED", failed: "FAILED", timedOut: "FAILED", skipped: "SKIPPED", interrupted: "ERROR" };
  const statusLabel = { PASSED: "PASSED", FAILED: "FAILED", SKIPPED: "SKIPPED", ERROR: "ERROR" };
  // Rapport texte d'une exécution : [STARTED]/[STEP]/[INFO]/[PASS]/[FAIL]/[GAP]/[RESULT].
  const specRel = (f) => (f ? relative(process.cwd(), f).replace(/\\/g, "/") : null) || f || "spec";
  const attachBody = (res) => {
    // Playwright (reporter JSON) embarque l'attachment texte du StepReporter
    // encodé en base64 (champ body) quand il n'a pas de chemin fichier.
    const att = (res.attachments || []).find((a) => a && a.name === "rapport-e2e-texte" && a.body);
    if (!att || !att.body) return null;
    try { return Buffer.from(String(att.body), "base64").toString("utf8"); } catch { return null; }
  };
  const skipReasonOf = (test) => {
    const a = (test.annotations || []).find((x) => x && x.type === "skip");
    return (a && a.description) ? String(a.description) : null;
  };
  const errMsgOf = (res) => {
    if (res.error && res.error.message) return String(res.error.message);
    if (Array.isArray(res.errors) && res.errors[0] && res.errors[0].message) return String(res.errors[0].message);
    return null;
  };
  const compactSummary = (reportText, status, skipReason, errMsg) => {
    if (status === "SKIPPED") return skipReason ? `SKIPPED : ${skipReason}` : "SKIPPED (raison non renseignée par le test)";
    if (status === "FAILED" || status === "ERROR") return `${status} : ${(errMsg || "échec non détaillé").slice(0, 400)}`;
    if (reportText) {
      const lines = reportText.split("\n");
      for (let i = lines.length - 1; i >= 0; i--) {
        const m = /^\[RESULT\]\s*(.*)$/.exec(lines[i]);
        if (m) return `PASSED : ${m[1]}`;
      }
      for (let i = lines.length - 1; i >= 0; i--) {
        const m = /^\[PASS\]\s*(.*)$/.exec(lines[i]);
        if (m) return `PASSED : ${m[1].slice(0, 300)}`;
      }
    }
    return "PASSED";
  };
  const walk = (suite) => {
    for (const spec of suite.specs || []) {
      for (const test of spec.tests || []) {
        for (const res of test.results || []) {
          const status = statusMap[res.status] || (failedLaunch ? "ERROR" : "ERROR");
          const reportText = attachBody(res);
          const skipReason = skipReasonOf(test);
          const errMsg = errMsgOf(res);
          // Rapport texte riche : en-tête run + transcript des étapes (si
          // l'attachment a été posé par le spec) + pied de page statut/raison.
          const reportLines = [];
          reportLines.push(`[REPORT-TEXTE] ${runId}`);
          reportLines.push(`[SCENARIO] ${test.title || spec.title || "scénario"}`);
          reportLines.push(`[SPEC] ${specRel(spec.file)}`);
          reportLines.push(`[STATUS] ${statusLabel[status] || status}`);
          if (reportText) reportLines.push(reportText);
          else reportLines.push("[INFO] Aucun rapport d'étapes (le spec n'a pas posé d'attachment « rapport-e2e-texte » — vérifier le helper StepReporter / le bloc try-finally du test).");
          if (status === "SKIPPED") {
            reportLines.push(skipReason ? `[SKIPPED] ${skipReason}` : "[SKIPPED] Le test a été ignoré sans raison explicite (test.skip sans description).");
          }
          if ((status === "FAILED" || status === "ERROR") && errMsg) {
            reportLines.push(`[FAILED] ${errMsg}`);
          }
          reportLines.push(`[DURATION] ${res.duration || 0}ms`);
          const fullReport = reportLines.join("\n");
          // Écrit le rapport texte (permet l'import d'un vrai transcript IA).
          let reportFile = null;
          try {
            const rf = `report-${runId}-${results.length + 1}.txt`;
            writeFileSync(join(runDir, rf), fullReport);
            reportFile = rf;
          } catch {}
          let videoFile = null;
          let i = 0;
          for (const att of res.attachments || []) {
            if ((att.name === "video" || /video/.test(att.contentType || "")) && att.path) {
              const vname = `video-${runId}-${results.length}-${++i}${basename(att.path)}`;
              try { copyFileSync(att.path, join(runDir, vname)); videoFile = vname; } catch {}
            }
          }
          const entry = {
            specFile: specRel(spec.file),
            scenario: test.title || spec.title || "scénario",
            title: test.title || null,
            status,
            durationMs: res.duration || 0,
            videoFile,
            reportFile,
            error: errMsg ? errMsg.slice(0, 400) : null,
            skipReason,
            summary: compactSummary(reportText, status, skipReason, errMsg),
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
  // PLUS AUCUNE entrée fantôme : un run sans test (filtre vide ou échec de
  // lancement) est porté par manifest.failedLaunch / manifest.emptyFilter.
  console.warn("Aucun test exécuté (filtre vide ou erreur de lancement) — reporté au manifest.");
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
  // Une erreur de lancement (playwright n'a pas produit de rapport) ou un filtre
  // qui ne matche AUCUN test N'EST PAS une entrée de test : c'est un signal de
  // niveau run, porté par launchError (jamais une entrée « (aucun test exécuté) »).
  failedLaunch,
  launchError: failedLaunch ? (raw.slice(0, 400) || "échec de lancement playwright") : null,
  emptyFilter: !failedLaunch && results.length === 0,
  results,
};
const manifestPath = join(runDir, "manifest.json");
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
console.log(`E2E manifest écrit : ${manifestPath}`);
console.log(`Playwright args : ${pwArgs.length ? pwArgs.join(" ") : "(config par défaut du dépôt)"}`);
console.log(`Tests : ${results.length} (${results.filter((r) => r.status === "PASSED").length} PASS, ${results.filter((r) => r.status === "FAILED").length} FAIL, ${results.filter((r) => r.status === "SKIPPED").length} SKIPPED)`);
