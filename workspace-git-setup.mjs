#!/usr/bin/env node
// workspace-git-setup.mjs — Masque le token git d'un dépôt DANS un workspace Coder
// tout en continuant à l'exploiter (credential helper).
//
// Problème : le token est souvent embarqué dans l'URL du remote
// (https://user:TOKEN@github.com/org/repo.git) → lisible dans `git remote -v` et
// `.git/config`.
//
// Solution : on retire le token de l'URL (remote "propre") et on le fournit au
// fetch/push via un CREDENTIAL HELPER qui lit le token dans un fichier 0600
// ($HOME/.config/git-token), propriété de l'utilisateur du workspace.
//
// Usage :
//   node workspace-git-setup.mjs --container <coder-...> --repo /home/coder/oniria \
//        [--remote https://github.com/org/repo.git] [--token <PAT>] [--user coder]
//   (si --token absent, il est extrait du remote actuel puis retiré de l'URL)
//
// Sortie JSON : { ok, container, repo, remote, tokenPresent, remoteClean, fetch }

import { execFileSync } from "node:child_process";

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : def;
}

const container = arg("container");
const repo = arg("repo");
const user = arg("user", "coder");
let remote = arg("remote");
let token = arg("token", process.env.GIT_TOKEN || "");
if (!container || !repo) {
  console.error("Usage: node workspace-git-setup.mjs --container <coder-...> --repo <path> [--remote <url>] [--token <PAT>] [--user coder]");
  process.exit(2);
}

function dsh(script) {
  return execFileSync("docker", ["exec", "-u", user, container, "sh", "-c", script], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
}

try {
  // 1. Remote actuel (peut contenir le token).
  const current = dsh(`cd ${JSON.stringify(repo)} && git remote get-url origin 2>/dev/null || true`).trim();
  if (!remote) {
    // Dérive l'URL propre en retirant les identifiants.
    remote = current.replace(/^(https?:\/\/)[^@/]+@/, "$1");
  }
  // 2. Extrait le token du remote actuel si non fourni.
  if (!token) {
    const m = current.match(/^https?:\/\/[^@/]+:([^@]+)@/);
    if (m) token = m[1];
  }
  if (!remote) throw new Error("URL remote introuvable — passer --remote");

  // 3. Écrit le token (0600) + le helper, configure git, nettoie l'URL.
  const helper = `$HOME/.config/git-credential-token.sh`;
  const tokenFile = `$HOME/.config/git-token`;
  if (token) {
    // Le token est écrit via stdin pour ne pas l'exposer dans l'historique/ps.
    const writeScript = `mkdir -p "$HOME/.config" && umask 077 && cat > "$HOME/.config/git-token" && chmod 600 "$HOME/.config/git-token"`;
    execFileSync("docker", ["exec", "-i", "-u", user, container, "sh", "-c", writeScript], { input: token + "\n" });
  }
  const setup = [
    `printf '%s\\n' '#!/bin/sh' 'echo "username=x-access-token"' 'echo "password=$(cat "$HOME/.config/git-token")"' > ${helper}`,
    `chmod 700 ${helper}`,
    `git config --global credential.helper ${helper}`,
    `cd ${JSON.stringify(repo)}`,
    `git remote set-url origin ${JSON.stringify(remote)}`,
    `echo REMOTE: $(git remote get-url origin)`,
    `git fetch --dry-run 2>&1 | head -5 && echo FETCH_OK`,
  ].join(" && ");
  const out = dsh(setup);

  const remoteAfter = dsh(`cd ${JSON.stringify(repo)} && git remote get-url origin`).trim();
  console.log(JSON.stringify({
    ok: true,
    container, repo, remote: remoteAfter,
    tokenPresent: !!token,
    remoteClean: !/:\/\/[^@/]+:[^@]+@/.test(remoteAfter),
    output: out.trim(),
  }, null, 2));
} catch (e) {
  console.error(`ERREUR : ${(e.stderr || e.message || String(e)).toString().slice(0, 800)}`);
  process.exit(1);
}
