#!/usr/bin/env node
/**
 * collect-git-commits.mjs — Collecte la trace des commits (fichiers touchés +
 * diff) d'une sous-tâche, au format attendu par `plan_commit_add` (MCP
 * task-orchestrator).
 *
 * Usage :
 *   node collect-git-commits.mjs --dir <gitRoot> --range <base..HEAD>
 *   node collect-git-commits.mjs --dir <gitRoot> --shas <sha1> <sha2> ...
 *   node collect-git-commits.mjs --dir <gitRoot> --range <base..HEAD> --max-diff 40000
 *
 * Sortie (stdout) : JSON `{ "commits": [ { sha, message, author, committedAt,
 * files: [ { path, status, additions, deletions, diff } ] } ] }`.
 */
import { execFileSync } from "node:child_process";

function run(dir, args) {
  try {
    return execFileSync("git", ["-C", dir, ...args], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch {
    return "";
  }
}

function parseArgs() {
  const a = process.argv.slice(2);
  const out = { dir: null, range: null, shas: [], maxDiff: 40000 };
  for (let i = 0; i < a.length; i++) {
    if (a[i] === "--dir") out.dir = a[++i];
    else if (a[i] === "--range") out.range = a[++i];
    else if (a[i] === "--max-diff") out.maxDiff = Number(a[++i]) || 40000;
    else if (a[i] === "--shas") {
      i++;
      while (i < a.length && !a[i].startsWith("--")) out.shas.push(a[i++]);
      i--;
    }
  }
  return out;
}

function cap(s, n) {
  if (!s) return "";
  return s.length > n ? s.slice(0, n) + "\n…(diff tronqué)" : s;
}

const STATUS = { A: "added", M: "modified", D: "deleted", R: "renamed", C: "modified", T: "modified" };

function collectOne(dir, sha, maxDiff) {
  const meta = run(dir, ["log", "-1", `--format=%an%x1f%aI%x1f%s`, sha]).trim();
  const [author = "", committedAt = "", message = ""] = meta.split("\x1f");

  const nameStatus = run(dir, ["show", sha, "--format=", "--name-status", "--no-renames"]).trim();
  const numstat = run(dir, ["show", sha, "--format=", "--numstat", "--no-renames"]).trim();

  const numMap = {};
  numstat.split("\n").filter(Boolean).forEach((line) => {
    const parts = line.split("\t");
    if (parts.length >= 3) {
      const path = parts.slice(2).join("\t");
      numMap[path] = {
        additions: parts[0] === "-" ? 0 : Number(parts[0]) || 0,
        deletions: parts[1] === "-" ? 0 : Number(parts[1]) || 0,
      };
    }
  });

  const files = [];
  nameStatus.split("\n").filter(Boolean).forEach((line) => {
    const parts = line.split("\t");
    const status = (parts[0] || "").trim();
    const path = parts.slice(1).join("\t");
    if (!path) return;
    const { additions = 0, deletions = 0 } = numMap[path] || {};
    const diff = cap(
      run(dir, ["show", sha, "--format=", "--no-renames", "--", path]).trimEnd(),
      maxDiff,
    );
    files.push({ path, status: STATUS[status] || "modified", additions, deletions, diff });
  });

  return { sha, message, author, committedAt, files };
}

const args = parseArgs();
if (!args.dir) {
  console.error("--dir requis");
  process.exit(1);
}
let shas = args.shas;
if (!shas.length && args.range) {
  shas = run(args.dir, ["log", "--format=%H", args.range]).trim().split("\n").filter(Boolean);
}
if (!shas.length) {
  console.error("aucun commit (fournir --range <base..HEAD> ou --shas <sha...>)");
  process.exit(1);
}
const commits = shas.map((sha) => collectOne(args.dir, sha, args.maxDiff));
process.stdout.write(JSON.stringify({ commits }, null, 2) + "\n");
