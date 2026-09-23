# Runbook — Rotation et supervision du token Coder d'organisation

> Référence : `ADR — Cycle de vie et rotation du token Coder d'organisation`
> (statut **Accepté**, `doc-mue6dscf-bk3a`). Ce runbook documente la
> **planification**, l'**échec bruyant** et le **bootstrap / auto-guérison**.

## 1. Objet

Le serveur Coder (`https://ide.madatalk.fr`) plafonne la durée de vie des
tokens d'organisation (168 h = 7 jours). Le script
`/root/.config/opencode/scripts/coder-token-rotate.mjs` recrée un token
**avant** expiration et met à jour le secret d'organisation (chiffré AES-256-GCM
en base via `registerOrganization`). Une rotation non planifiée ou silencieuse
casse les workspaces admin (« Config Coder incomplète » / `signed out`).

## 2. Planification (systemd)

| Unit | Rôle | Cadence |
|------|------|---------|
| `coder-token-rotate.service` / `.timer` | Rotation du token | `OnBootSec=2min`, puis toutes les **6 h** (`Persistent=true`) |
| `coder-token-rotate-health.service` / `.timer` | Supervision `--health` (lecture seule) | `OnBootSec=5min`, puis toutes les **1 h** |

Units versionnées dans `infra/systemd/` et installées dans `/etc/systemd/system/`.

```bash
# Installer / mettre à jour
sudo cp /root/.config/opencode/scripts/infra/systemd/coder-token-rotate*.{service,timer} /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now coder-token-rotate.timer coder-token-rotate-health.timer

# Vérifier la planification (preuve)
systemctl list-timers 'coder-token-rotate*'

# Vérifier une exécution ponctuelle
sudo systemctl start coder-token-rotate.service
journalctl -u coder-token-rotate.service -n 50 --no-pager
```

> ⚠️ Ne **jamais** réactiver l'ancien planificateur **pm2** `coder-token-rotate`
> (one-shot sous `cron_restart` : état `stopped` ambigu et non supervisé). Un
> seul planificateur doit être actif à la fois (timer systemd **OU** pm2).

## 3. Heartbeat (observabilité)

Chaque exécution écrit `/var/lib/coder-token-rotate/state.json` (mode `0600`,
**jamais** de token en clair) :

```json
{
  "lastRunAt": "2026-09-23T15:09:42.074Z",
  "lastSuccessAt": "2026-09-23T15:09:42.074Z",
  "status": "rotated | valid | token_expired | token_missing | no_config | failed",
  "org": "onirtech",
  "tokenName": "oniria-panel",
  "remainingHours": null,
  "expiresAt": null,
  "lastAlertDate": "2026-09-23",
  "exitCode": 0
}
```

- `lastSuccessAt` est mis à jour **aussi bien** après une rotation qu'après un
  skip légitime (« token encore valide ») : c'est le battement de cœur du
  planificateur.
- `lastAlertDate` implémente le **throttling email à 1 alerte par jour**.

## 4. Contrat CLI et codes de sortie

```bash
# Rotation (idempotente : ne tourne que si nécessaire)
node coder-token-rotate.mjs [--org onirtech] [--name oniria-panel]
     [--lifetime 168h] [--min-remaining-hours 48] [--stale-hours 13]
     [--force]        # force la rotation même si le token est encore valide
     [--bootstrap]    # force l'auto-guérison via un credential de secours

# Supervision (LECTURE SEULE — ne crée jamais de token)
node coder-token-rotate.mjs --health
```

| Code | Source | Signification |
|------|--------|---------------|
| `0` | rotation / `--health` | succès (rotation faite, token encore valide, heartbeat à jour) |
| `1` | rotation | échec de la rotation (token **non** renouvelé) → email d'alerte |
| `2` | `--health` | token **expire bientôt** (`remainingHours < --min-remaining-hours`) |
| `3` | rotation / `--health` | token **expiré ou introuvable** → **bootstrap requis** |
| `4` | `--health` | **heartbeat périmé** (`now - lastSuccessAt > --stale-hours`) → la rotation ne tourne pas |

**Seuils par défaut** : `MIN_REMAINING_HOURS=48` h, `STALE_HOURS=13` h
(surchargeables par argument ou variable d'environnement `CODER_ROTATE_*`).

## 5. Bootstrap / auto-guérison (token déjà expiré)

`bootstrapToken()` cherche, **dans l'ordre** :

1. `CODER_BOOTSTRAP_TOKEN` (variable d'environnement, **non versionnée**) — un
   token/session Coder encore valide ;
2. la session CLI `~/.config/coderv2/session` (+ `~/.config/coderv2/url`),
   déposée par `coder login https://ide.madatalk.fr`.

Sans l'un de ces deux credentials, `create` échoue : la rotation sort en `3`
(`token_expired` / `token_missing`) et **alerte par email**.

### 5.1 Procédure d'urgence (token expiré, accès admin requis)

```bash
# 1) Se reconnecter au serveur Coder (authentification interactive HUMAINE)
coder login https://ide.madatalk.fr
#    → la session est écrite dans ~/.config/coderv2/{url,session}

# 2) Forcer le bootstrap + la rotation (récupère la session CLI)
node /root/.config/opencode/scripts/coder-token-rotate.mjs --bootstrap

# 3) Vérifier
node /root/.config/opencode/scripts/coder-token-rotate.mjs --health   # attendu : exit 0
cat /var/lib/coder-token-rotate/state.json
```

### 5.2 Variante sans login interactif (CI / robot)

```bash
# Provisionner un credential de secours valide (jamais loggé, jamais commité)
export CODER_BOOTSTRAP_TOKEN='<token-coder-valide>'
node /root/.config/opencode/scripts/coder-token-rotate.mjs --bootstrap
```

> Le secret n'est **jamais** écrit dans `state.json`, ni dans un log. Seul
> `registerOrganization` (chiffré) persiste le token.

## 6. Diagnostic rapide

| Symptôme | Cause probable | Action |
|----------|----------------|--------|
| `--health` → `3` | token expiré/introuvable | §5 (bootstrap admin) |
| `--health` → `4` | heartbeat périmé | `systemctl list-timers coder-token-rotate.timer` ; vérifier le timer/daemon ; lancer `systemctl start coder-token-rotate.service` |
| `--health` → `2` | rotation à venir | s'assurer que le timer tourne ; `--force` si besoin |
| rotation `1` | `coder tokens create` refusé | `journalctl -u coder-token-rotate.service` ; vérifier `CODER_URL`/token |
| rotation `0` mais token toujours invalide | mauvais `--name`/`--org` | `coder tokens ls --include-expired` |

## 7. Rappels

- `coder tokens ls` **masque les tokens expirés** par défaut : utiliser
  `--include-expired` (le script le fait).
- Ne jamais écrire le token en clair (log, `state.json`, git).
- Un seul planificateur actif (timer systemd) — pm2 retiré.
