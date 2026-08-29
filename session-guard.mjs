#!/usr/bin/env node
/**
 * session-guard.mjs — Isolie une session opencode qui va traiter un projet git.
 *
 * But : permettre à un agent (build-notify) de vérifier AVANT de modifier un
 * dépôt que d'autres sessions opencode ne travaillent pas en parallèle sur le
 * même projet. Si c'est le cas, l'agent travaille dans SON propre worktree
 * (créé si absent) sur une branche dédiée et différente.
 *
 * Mécanismes :
 *   1. Registre de verrous par dépôt (fichier JSON keyé par l'identité git du
 *      dépôt — common git dir, partagé par le checkout principal ET ses
 *      worktrees). Le registre contient la liste des sessions actives
 *      (heartbeat + TTL). Une session s'inscrit quand elle commence, se
 *      refresh pendant le traitement et se retire à la fin.
 *   2. Détection complémentaire via la base SQLite d'opencode : sessions
 *      actives (non archivées, mises à jour récemment) dont le répertoire de
 *      session pointe vers le même dépôt (ou un sous-dossier).
 *
 * Usage :
 *   node session-guard.mjs check    --dir <gitRoot> [--title <t>]
 *   node session-guard.mjs acquire  --dir <gitRoot> [--title <t>]
 *   node session-guard.mjs worktree --dir <gitRoot> [--branch <b>]
 *   node session-guard.mjs heartbeat --dir <gitRoot>
 *   node session-guard.mjs release  --dir <gitRoot>
 *   node session-guard.mjs remove   --dir <gitRoot>  (supprime worktree + branche + verrou)
 *
 * Sortie : JSON sur stdout. Codes de sortie :
 *   0 = OK, 2 = une autre session travaille en parallèle (recommander worktree).
 *
 * Variables d'environnement lues :
 *   OPENCODE_SESSION_ID        id de la session courante (injecté par le plugin
 *                              session-env). Si absent, "unknown".
 *   OPENCODE_DB                chemin de la base opencode (défaut :
 *                              ~/.local/share/opencode/opencode.db)
 *   SESSION_GUARD_TTL_MIN      TTL du verrou en minutes (défaut 30)
 *   SESSION_GUARD_LOCKDIR      répertoire des verrous (défaut :
 *                              ~/.config/opencode/session-locks)
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { homedir } from "node:os";
import { execFileSync } from "node:child_process";

const HOME = homedir();
const TTL_MIN = Number(process.env.SESSION_GUARD_TTL_MIN || 30);
const LOCKDIR = process.env.SESSION_GUARD_LOCKDIR || join(HOME, ".config", "opencode", "session-locks");
const DB_PATH = process.env.OPENCODE_DB || join(HOME, ".local", "share", "opencode", "opencode.db");
const SESSION_ID = process.env.OPENCODE_SESSION_ID || "unknown";

function log(msg) {
  process.stderr.write(`[session-guard] ${msg}\n`);
}

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : undefined;
}

function fail(code, obj) {
  process.stdout.write(JSON.stringify(obj, null, 2) + "\n");
  process.exit(code);
}

// --- utilitaires git -------------------------------------------------------
function git(root, ...args) {
  try {
    return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).trim();
  } catch (e) {
    log(`git ${args.join(" ")} a échoué dans ${root} : ${(e.stderr || e.message || "").trim()}`);
    return null;
  }
}

function gitRoot(dir) {
  const r = git(dir, "rev-parse", "--show-toplevel");
  if (!r) return null;
  try {
    return realpathSync(r);
  } catch {
    return r;
  }
}

// Identité du dépôt git partagée par le checkout principal ET ses worktrees :
// le common git dir (ex. /path/.git). Deux sessions sur le même dépôt (même
// en worktree) se verront comme travaillant sur le MÊME projet.
function repoIdentity(checkoutRoot) {
  const r = git(checkoutRoot, "rev-parse", "--git-common-dir");
  if (!r) return checkoutRoot;
  const abs = r.startsWith("/") ? r : join(checkoutRoot, r);
  try {
    return realpathSync(abs);
  } catch {
    return abs;
  }
}

function currentBranch(root) {
  const r = git(root, "rev-parse", "--abbrev-ref", "HEAD");
  if (r === null || r === "HEAD") return null;
  return r;
}

function hasCommits(root) {
  return git(root, "rev-parse", "--verify", "--quiet", "HEAD") !== null;
}

function worktreeList(root) {
  const out = git(root, "worktree", "list", "--porcelain");
  if (!out) return [];
  const wt = [];
  let cur = {};
  for (const line of out.split("\n")) {
    if (line.startsWith("worktree ")) {
      if (cur.path) wt.push(cur);
      cur = { path: line.slice("worktree ".length).trim() };
    } else if (line.startsWith("branch ")) {
      cur.branch = line.slice("branch ".length).replace("refs/heads/", "").trim();
    } else if (line === "") {
      if (cur.path) wt.push(cur);
      cur = {};
    }
  }
  if (cur.path) wt.push(cur);
  return wt;
}

// --- registre de verrous (liste de sessions actives par dépôt) ---------------
function lockFileFor(root) {
  const ident = repoIdentity(root);
  const h = createHash("sha256").update(ident).digest("hex").slice(0, 24);
  return join(LOCKDIR, `${h}.json`);
}

function readLock(root) {
  const f = lockFileFor(root);
  if (!existsSync(f)) return { entries: [] };
  try {
    const d = JSON.parse(readFileSync(f, "utf8"));
    return { entries: Array.isArray(d.entries) ? d.entries : [] };
  } catch {
    return { entries: [] };
  }
}

function writeLock(root, lock) {
  mkdirSync(LOCKDIR, { recursive: true });
  if (!lock.entries || lock.entries.length === 0) {
    removeLockFile(root);
    return;
  }
  writeFileSync(lockFileFor(root), JSON.stringify(lock, null, 2));
}

function removeLockFile(root) {
  const f = lockFileFor(root);
  if (existsSync(f)) {
    try {
      rmSync(f);
    } catch (e) {
      log(`suppression du verrou impossible : ${e.message}`);
    }
  }
}

function isLive(entry) {
  return entry?.heartbeatAt && Date.now() - entry.heartbeatAt <= TTL_MIN * 60 * 1000;
}

function pruneLock(lock) {
  return { entries: (lock.entries || []).filter(isLive) };
}

function otherLiveEntries(lock) {
  return (lock.entries || []).filter((e) => e.sessionId !== SESSION_ID && isLive(e));
}

function myEntry(lock) {
  return (lock.entries || []).find((e) => e.sessionId === SESSION_ID) || null;
}

// --- détection sessions parallèles via la DB opencode -----------------------
function activeSessionsOnDir(root) {
  try {
    const py = `
import json, os, sqlite3, sys, time
db = os.environ.get("OPENCODE_DB", "")
if not db or not os.path.exists(db):
    sys.exit(3)
con = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
cur = con.cursor()
rows = cur.execute(
    "SELECT id, title, agent, directory, time_updated "
    "FROM session WHERE time_archived IS NULL AND directory IS NOT NULL"
).fetchall()
now = int(time.time() * 1000)
limit = int(os.environ.get("ACTIVE_MS", "3600000"))
out = []
for sid, title, agent, directory, updated in rows:
    if not directory or sid == os.environ.get("CURRENT_SESSION", "unknown"):
        continue
    if updated and now - updated > limit:
        continue
    out.append({"id": sid, "title": title, "agent": agent, "directory": directory, "updated": updated})
print(json.dumps(out))
`;
    const res = execFileSync("python3", ["-c", py], {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      env: {
        ...process.env,
        OPENCODE_DB: DB_PATH,
        CURRENT_SESSION: SESSION_ID,
        ACTIVE_MS: String(TTL_MIN * 60 * 1000),
      },
    });
    return JSON.parse(res.trim());
  } catch (e) {
    log(`lecture DB opencode impossible (ignoré) : ${e.message}`);
    return [];
  }
}

// Une session "parallèle" est une session dont le répertoire de session pointe
// vers le même dépôt git (ou un sous-dossier de celui-ci), mise à jour
// récemment.
function sessionsParallelTo(root) {
  return activeSessionsOnDir(root).filter((s) => {
    const d = s.directory.replace(/\/+$/, "");
    const r = root.replace(/\/+$/, "");
    return d === r || d.startsWith(r + "/") || r.startsWith(d + "/");
  });
}

// --- commandes --------------------------------------------------------------
function cmdCheck(root) {
  if (!existsSync(root)) fail(1, { ok: false, error: `Répertoire introuvable : ${root}` });
  const groot = gitRoot(root);
  if (!groot) fail(1, { ok: false, error: `Pas de dépôt git : ${root}` });

  const lock = pruneLock(readLock(groot));
  writeLock(groot, lock);
  const others = otherLiveEntries(lock);
  const dbParallel = sessionsParallelTo(groot);

  const parallel = others.length > 0 || dbParallel.length > 0;
  process.stdout.write(
    JSON.stringify(
      {
        ok: true,
        parallel,
        gitRoot: groot,
        currentSession: SESSION_ID,
        branch: currentBranch(groot),
        activeSessions: lock.entries,
        otherSessions: dbParallel.map((s) => ({ id: s.id, title: s.title, agent: s.agent })),
        recommendation: parallel ? "worktree" : "in-place",
      },
      null,
      2,
    ) + "\n",
  );
  process.exit(parallel ? 2 : 0);
}

function cmdAcquire(root) {
  if (!existsSync(root)) fail(1, { ok: false, error: `Répertoire introuvable : ${root}` });
  const groot = gitRoot(root);
  if (!groot) fail(1, { ok: false, error: `Pas de dépôt git : ${root}` });

  const lock = pruneLock(readLock(groot));
  const others = otherLiveEntries(lock);
  if (others.length > 0) {
    writeLock(groot, lock);
    fail(2, {
      ok: false,
      parallel: true,
      gitRoot: groot,
      holder: others.map((o) => ({ sessionId: o.sessionId, title: o.title })),
      message: `Une autre session opencode travaille déjà sur ce projet. Travailler dans un worktree dédié.`,
    });
  }

  const dbParallel = sessionsParallelTo(groot);
  if (dbParallel.length > 0) {
    fail(2, {
      ok: false,
      parallel: true,
      gitRoot: groot,
      otherSessions: dbParallel.map((s) => ({ id: s.id, title: s.title, agent: s.agent })),
      message: `Une autre session opencode travaille déjà sur ce projet (base). Travailler dans un worktree dédié.`,
    });
  }

  const now = Date.now();
  const branch = arg("branch") || currentBranch(groot) || "main";

  // Reprise de session : on est déjà inscrit (worktree créé précédemment).
  const existing = myEntry(lock);
  if (existing?.worktree) {
    existing.heartbeatAt = now;
    writeLock(groot, lock);
    process.stdout.write(
      JSON.stringify(
        { ok: true, gitRoot: groot, sessionId: SESSION_ID, branch: existing.branch, mode: "worktree", worktree: existing.worktree },
        null,
        2,
      ) + "\n",
    );
    process.exit(0);
  }

  const me = { sessionId: SESSION_ID, title: arg("title") || null, branch, acquiredAt: now, heartbeatAt: now };
  const entries = (lock.entries || []).filter((e) => e.sessionId !== SESSION_ID).concat(me);
  writeLock(groot, { entries });
  process.stdout.write(
    JSON.stringify({ ok: true, gitRoot: groot, sessionId: SESSION_ID, branch, acquiredAt: now, mode: "in-place" }, null, 2) +
      "\n",
  );
  process.exit(0);
}

function cmdHeartbeat(root) {
  const groot = gitRoot(root);
  if (!groot) fail(1, { ok: false, error: "Pas de dépôt git." });
  const lock = readLock(groot);
  const me = myEntry(lock);
  if (!me) fail(1, { ok: false, error: "Verrou non détenu par cette session." });
  me.heartbeatAt = Date.now();
  writeLock(groot, lock);
  process.stdout.write(JSON.stringify({ ok: true, gitRoot: groot, heartbeatAt: me.heartbeatAt }, null, 2) + "\n");
  process.exit(0);
}

function cmdRelease(root) {
  const groot = gitRoot(root);
  if (!groot) fail(1, { ok: false, error: "Pas de dépôt git." });
  const lock = readLock(groot);
  const entries = (lock.entries || []).filter((e) => e.sessionId !== SESSION_ID);
  if (entries.length === 0) {
    removeLockFile(groot);
  } else {
    writeLock(groot, { entries });
  }
  log(`session ${SESSION_ID} retirée du registre pour ${groot}`);
  process.stdout.write(JSON.stringify({ ok: true, gitRoot: groot, released: true }, null, 2) + "\n");
  process.exit(0);
}

function cmdRemove(root) {
  if (!existsSync(root)) fail(1, { ok: false, error: `Répertoire introuvable : ${root}` });
  const groot = gitRoot(root);
  if (!groot) fail(1, { ok: false, error: `Pas de dépôt git : ${root}` });

  const lock = readLock(groot);
  const me = myEntry(lock);
  if (!me) {
    process.stdout.write(JSON.stringify({ ok: true, gitRoot: groot, removed: false, reason: "aucun verrou détenu" }, null, 2) + "\n");
    process.exit(0);
  }

  // Supprimer le worktree physique + la branche dédiée.
  let removed = false;
  if (me.worktree) {
    removed = git(groot, "worktree", "remove", "--force", me.worktree) !== null;
    if (me.branch) git(groot, "branch", "-D", me.branch);
  }

  // Libérer le verrou.
  const entries = (lock.entries || []).filter((e) => e.sessionId !== SESSION_ID);
  if (entries.length === 0) removeLockFile(groot);
  else writeLock(groot, { entries });

  log(`session ${SESSION_ID} : worktree supprimé et verrou libéré pour ${groot}`);
  process.stdout.write(
    JSON.stringify({ ok: true, gitRoot: groot, removed, worktree: me.worktree || null, branch: me.branch || null }, null, 2) + "\n",
  );
  process.exit(0);
}

function cmdWorktree(root) {
  if (!existsSync(root)) fail(1, { ok: false, error: `Répertoire introuvable : ${root}` });
  const groot = gitRoot(root);
  if (!groot) fail(1, { ok: false, error: `Pas de dépôt git : ${root}` });
  if (!hasCommits(groot)) {
    fail(1, {
      ok: false,
      error: `Dépôt sans commit (HEAD vide) : impossible de créer un worktree. Travailler en place ou faire un premier commit.`,
      gitRoot: groot,
    });
  }

  // Branche dédiée à la session courante.
  const base = arg("branch") || `build-notify/${SESSION_ID.replace(/^ses_/, "").slice(0, 10)}`;
  const safeBase = base.replace(/[^A-Za-z0-9._/-]/g, "-").replace(/-+/g, "-").replace(/[._-]+$/, "");
  const branch = safeBase;

  const parent = dirname(groot);
  const repoName = basename(groot);
  const wtDir = join(parent, `${repoName}-wt-${safeBase.split("/").pop()}`);

  // Déjà en worktree pour cette branche ?
  for (const w of worktreeList(groot)) {
    if (w.branch === branch) {
      process.stdout.write(
        JSON.stringify({ ok: true, worktree: w.path, branch, created: false, gitRoot: groot }, null, 2) + "\n",
      );
      process.exit(0);
    }
  }

  if (existsSync(wtDir)) {
    fail(1, {
      ok: false,
      error: `Un répertoire existe déjà : ${wtDir}. Le supprimer ou choisir une autre branche.`,
      worktree: wtDir,
    });
  }

  const out = git(groot, "worktree", "add", wtDir, "-b", branch);
  if (out === null) {
    fail(1, { ok: false, error: `Échec de création du worktree ${wtDir} (branche ${branch}).` });
  }

  // Inscrire la session dans le registre du dépôt (mode worktree).
  const lock = pruneLock(readLock(groot));
  const now = Date.now();
  const entries = (lock.entries || [])
    .filter((e) => e.sessionId !== SESSION_ID)
    .concat({ sessionId: SESSION_ID, title: arg("title") || null, branch, worktree: wtDir, acquiredAt: now, heartbeatAt: now });
  writeLock(groot, { entries });

  process.stdout.write(
    JSON.stringify({ ok: true, worktree: wtDir, branch, created: true, gitRoot: groot }, null, 2) + "\n",
  );
  process.exit(0);
}

// --- main -------------------------------------------------------------------
const cmd = process.argv[2];
const dir = arg("dir");

if (!cmd || !dir) {
  process.stdout.write(
    JSON.stringify(
      { ok: false, error: "Usage: node session-guard.mjs <check|acquire|release|heartbeat|worktree> --dir <gitRoot>" },
      null,
      2,
    ) + "\n",
  );
  process.exit(1);
}

switch (cmd) {
  case "check":
    cmdCheck(dir);
    break;
  case "acquire":
    cmdAcquire(dir);
    break;
  case "release":
    cmdRelease(dir);
    break;
  case "heartbeat":
    cmdHeartbeat(dir);
    break;
  case "worktree":
    cmdWorktree(dir);
    break;
  case "remove":
    cmdRemove(dir);
    break;
  default:
    fail(1, { ok: false, error: `Commande inconnue : ${cmd}` });
}
