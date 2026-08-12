#!/bin/bash
# Exports the helpdesk creds from CoreSettings into the env and runs the ledger.
# Read-only against Odoo. Usage: ./run.sh [days]
set -euo pipefail
DAYS="${1:-7}"
cd "$(dirname "$0")"

eval "$(cd /rmm/api/tacticalrmm && /rmm/api/env/bin/python - <<'PY'
import django, os
os.environ.setdefault("DJANGO_SETTINGS_MODULE", "tacticalrmm.settings")
django.setup()
from core.models import CoreSettings
c = CoreSettings.objects.first()
print("export HD_BASE=%s" % (c.ai_helpdesk_api_base_url or ""))
print("export HD_KEY=%s" % (c.ai_helpdesk_api_key or ""))
print("export HD_DB=blueuc")
print("export HD_LOGIN=bluecloudapi@blueuc.com")
PY
)"

node ledger.mjs --days "$DAYS" --out /tmp/work_ledger.json
node render_report.mjs --in /tmp/work_ledger.json --out /tmp/work_ledger_report.html
