#!/usr/bin/env node
// workspace-create.mjs — Crée un workspace Coder pour une organisation, puis
// (optionnellement) clone le remote git du projet DANS le workspace et masque
// le token (credential helper).
//
// Usage :
//   node workspace-create.mjs --org onirtech --name <workspace> \
//        [--owner <owner>] [--template <t>] [--param name=value ...] \
//        [--clone <remote>] [--repo <path-in-container>] [--no-wait]
//
// La config Coder (URL, template, token) et le token git sont lus depuis le
// secret d'organisation (chiffré). Aucun token n'est affiché.

import { execFileSync } from "node:child_process";
import { getOrganizationCoderConfig, getOrgGitToken } from "/root/.config/opencode/mcp/task-orchestrator/db.mjs";

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : def;
}
function allArgs(name) {
  const out = [];
  for (let i = 0; i < process.argv.length; i++) {
    if (process.argv[i] === `--${name}` && process.argv[i + 1] && !process.argv[i + 1].startsWith("--")) out.push(process.argv[i + 1]);
  }
  return out;
}

const org = arg("org", "onirtech");
const name = arg("name");
const owner = arg("owner");
const template = arg("template");
const cloneRemote = arg("clone");
const repoPath = arg("repo");
const gitTokenId = arg("git-token-id");
const noWait = process.argv.includes("--no-wait");
const params = allArgs("param");

if (!name) { console.error("Usage: node workspace-create.mjs --org <org> --name <workspace> [--owner <o>] [--template <t>] [--param name=value] [--clone <remote>] [--repo <path>] [--git-token-id <id>]"); process.exit(2); }

const cfg = await getOrganizationCoderConfig(org);
if (!cfg || !cfg.url || !cfg.token) { console.error(`Config Coder incomplète pour l'organisation ${org} (URL + token requis).`); process.exit(3); }
const tpl = template || cfg.template;
if (!tpl) { console.error(`Template Coder non défini pour l'organisation ${org}.`); process.exit(3); }

// Token git effectif : --git-token-id (choisi au niveau repo↔projet) > token par défaut de l'org.
let effectiveGitToken = cfg.gitToken;
if (gitTokenId) {
  const chosen = await getOrgGitToken(org, gitTokenId);
  if (chosen && chosen.token) effectiveGitToken = chosen.token;
}

const env = { ...process.env, CODER_URL: cfg.url, CODER_SESSION_TOKEN: cfg.token };
const wsRef = owner ? `${owner}/${name}` : name;

function coder(args) {
  return execFileSync("coder", args, { encoding: "utf8", env, maxBuffer: 32 * 1024 * 1024 });
}

const result = { ok: false, org, workspace: wsRef, template: tpl };
try {
  const createArgs = ["create", wsRef, "--template", tpl, "--preset", "none", "--yes", "--use-parameter-defaults"];
  if (noWait) createArgs.push("--no-wait");
  for (const p of params) createArgs.push("--parameter", p);
  coder(createArgs);
  result.created = true;

  // Découverte du conteneur (docker) + volume.
  const container = `coder-${(owner || "").replace(/[^A-Za-z0-9]/g, "") || ""}`;
  // Le nom de conteneur Coder = coder-<owner>-<workspace> ; owner inconnu → on cherche.
  let cont = null;
  try {
    const names = execFileSync("docker", ["ps", "-a", "--format", "{{.Names}}"], { encoding: "utf8" }).split("\n");
    cont = names.find((n) => n.toLowerCase().endsWith(`-${name}`.toLowerCase())) || null;
  } catch {}
  result.container = cont;

  // Clone + masquage du token (si demandé).
  if (cloneRemote && cont) {
    const dest = repoPath || `/home/coder/${name}`;
    // Retire TOUT userinfo existant (ex. https://user:token@...) puis injecte le
    // token de l'org, URL-encodé — sinon double userinfo → URL invalide (port).
    const cleanRemote = cloneRemote.replace(/^(https?:\/\/)[^@/]+@/, "$1");
    const remoteWithAuth = effectiveGitToken
      ? cleanRemote.replace(/^(https?:\/\/)/, `$1x-access-token:${encodeURIComponent(effectiveGitToken)}@`)
      : cleanRemote;
    const cloneScript = `[ -d ${JSON.stringify(dest)}/.git ] || git clone ${JSON.stringify(remoteWithAuth)} ${JSON.stringify(dest)}`;
    execFileSync("docker", ["exec", "-u", "coder", cont, "sh", "-c", cloneScript], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
    result.cloned = dest;
    // Masque le token (URL propre + credential helper).
    const setupOut = execFileSync("node", ["/root/.config/opencode/scripts/workspace-git-setup.mjs", "--container", cont, "--repo", dest], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
    result.gitSetup = JSON.parse(setupOut);
  }
  result.ok = true;
  console.log(JSON.stringify(result, null, 2));
} catch (e) {
  result.error = String((e.stderr || e.message || e)).slice(0, 600);
  console.log(JSON.stringify(result, null, 2));
  process.exit(1);
}
