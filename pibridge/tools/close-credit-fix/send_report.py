#!/usr/bin/env python3
"""Email the completion-credit fix preview to a single recipient (default: chris).
A one-off review send - NOT a scheduled report, and only to --to.

Usage: python3 send_report.py [--to chris@blueuc.com] [--html /tmp/close_credit_report.html] [--dry-run]
"""
import argparse
import os
import sys

sys.path.insert(0, "/rmm/api/tacticalrmm")
os.environ.setdefault("DJANGO_SETTINGS_MODULE", "tacticalrmm.settings")
import django  # noqa: E402
django.setup()
from core.models import CoreSettings  # noqa: E402

ap = argparse.ArgumentParser()
ap.add_argument("--to", default="chris@blueuc.com")
ap.add_argument("--html", default="/tmp/close_credit_report.html")
ap.add_argument("--dry-run", action="store_true")
a = ap.parse_args()

html = open(a.html).read()
if a.dry_run:
    print(f"dry run - would send {len(html)} chars to {a.to}")
    sys.exit(0)

core = CoreSettings.objects.first()
msg, ok = core.send_mail(
    subject="[Preview] Technician productivity — completion-credit fix (review before deploy)",
    body="This report is HTML with a before/after table - view it in an HTML-capable client.",
    html_body=html,
    override_recipients=[a.to],
)
print(f"sent_ok = {ok} | detail = {msg} | to = {a.to} | html chars = {len(html)}")
