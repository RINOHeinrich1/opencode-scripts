#!/usr/bin/env bash
# Lanceur OmniRoute — gateway IA (AI router multi-fournisseurs).
# Utilisé par pm2 (process name: omniroute).
#
# Pourquoi ce script : OmniRoute embarque Next.js 16, qui exige Node >= 21
# (util.markAsUncloneable). Le node par défaut de l'hôte est v20 ; on force
# donc Node 22 LTS (présent via nvm) AVANT de lancer le CLI, afin que le CLI
# ET le serveur Next.js qu'il spawn héritent du bon interpréteur.
#
# Ports : API + dashboard sur 20128 (cf. .env du package).
set -euo pipefail

export PATH="/root/.nvm/versions/node/v22.23.1/bin:${PATH}"

cd /root/.config/opencode/node_modules/omniroute
exec node bin/omniroute.mjs start --no-open
