"""Manage PI RELAY keys from the shell (see core/relay.py, /opt/pi-trmm-bridge/docs/PI-RELAY.md).

  manage.py relay_keys create --user sean@blueuc.com --groups coding,it --label "Sean laptop" \
        [--expires-days 90] [--daily 10] [--monthly 100] [--ips 1.2.3.4,10.0.0.0/8]
  manage.py relay_keys create ... --unlimited          (no spend cap)
  manage.py relay_keys set <key_id> [--daily 20|none] [--monthly 200|none] [--unlimited]
        [--label "..."] [--expires-days 90|never] [--ips "1.2.3.4,10.0.0.0/8"|none] [--groups coding,it]
  manage.py relay_keys list [--user chris]
  manage.py relay_keys revoke <key_id>
  manage.py relay_keys delete <key_id> [--force]     (permanent; revoke first unless --force)
"""

from django.core.management.base import BaseCommand, CommandError


def _actor(by: str = "") -> str:
    """Who did it: the named person, else the OS account - never just "manage.py"."""
    import getpass
    try:
        os_user = getpass.getuser()
    except Exception:
        os_user = "?"
    who = (by or "").strip()
    return (f"{who} (manage.py as {os_user})" if who else f"manage.py as {os_user}")[:150]


class Command(BaseCommand):
    help = "Create, list and revoke pi relay keys"

    def add_arguments(self, parser):
        sub = parser.add_subparsers(dest="action", required=True)
        c = sub.add_parser("create")
        c.add_argument("--user", required=True, help="RMM username or email")
        c.add_argument("--groups", required=True, help="agent group slugs, comma separated (it, coding)")
        c.add_argument("--label", default="")
        c.add_argument("--expires-days", type=int, default=None)
        c.add_argument("--daily", type=float, default=None, help="daily budget in USD")
        c.add_argument("--monthly", type=float, default=None, help="monthly budget in USD")
        c.add_argument("--ips", default="", help="comma-separated IPs/CIDRs allowed")
        c.add_argument("--unlimited", action="store_true", help="no daily/monthly spend cap")
        # Every key must be explainable later (owner, 2026-09-30).
        c.add_argument("--purpose", required=True, help="why this key exists: which computer / person / job")
        c.add_argument("--by", default="", help="the person issuing it (recorded as created_by)")
        st = sub.add_parser("set")
        st.add_argument("key_id")
        st.add_argument("--daily", default=None, help="USD, or 'none'")
        st.add_argument("--monthly", default=None, help="USD, or 'none'")
        st.add_argument("--unlimited", action="store_true")
        st.add_argument("--label", default=None)
        st.add_argument("--purpose", default=None)
        st.add_argument("--expires-days", default=None, help="days from now, or 'never'")
        st.add_argument("--ips", default=None, help="IPs/CIDRs, or 'none'")
        st.add_argument("--groups", default=None, help="agent group slugs, comma separated")
        lst = sub.add_parser("list")
        lst.add_argument("--user", default="")
        r = sub.add_parser("revoke")
        r.add_argument("key_id")
        r.add_argument("--by", default="", help="the person revoking it (recorded as revoked_by)")
        dl = sub.add_parser("delete")
        dl.add_argument("key_id")
        dl.add_argument("--force", action="store_true", help="delete even if not revoked")
        nt = sub.add_parser("notify-update", help="email every active key holder the 'update your pi extension' notice (keys are NOT changed)")
        nt.add_argument("--user", default="", help="only this RMM username/email")
        nt.add_argument("--dry-run", action="store_true", help="show who would be emailed; send nothing")

    def handle(self, *args, **o):
        from accounts.models import User
        from django.utils import timezone

        from core.models import AIAgentGroup, AIRelayKey
        from core.relay import (BadInput, issue_key, key_public, parse_budget, parse_ips,
                                resolve_groups, user_can_use_ai)

        if o["action"] == "create":
            u = User.objects.filter(username__iexact=o["user"]).first() or \
                User.objects.filter(email__iexact=o["user"]).first()
            if not u:
                raise CommandError(f"no RMM user '{o['user']}'")
            if not user_can_use_ai(u):
                raise CommandError(f"{u.username} is inactive or lacks the 'Use AI' permission")
            groups = resolve_groups({"group": [x.strip() for x in o["groups"].split(",") if x.strip()]})
            if not groups:
                raise CommandError(f"no agent group matched '{o['groups']}' "
                                   f"(have: {', '.join(AIAgentGroup.objects.values_list('slug', flat=True))})")
            if not o["unlimited"] and o["daily"] is None and o["monthly"] is None:
                raise CommandError("give --daily and/or --monthly, or --unlimited")
            row, key = issue_key(user=u, groups=groups, label=o["label"], created_by=_actor(o.get("by")), purpose=o["purpose"],
                                 expires_days=o["expires_days"],
                                 daily_budget_usd=None if o["unlimited"] else o["daily"],
                                 monthly_budget_usd=None if o["unlimited"] else o["monthly"],
                                 allowed_ips=o["ips"])
            self.stdout.write(f"user:     {u.username}  (email: {u.email or '-'})")
            self.stdout.write("groups:   " + ", ".join(f"{x.name} ({x.slug})" for x in groups))
            self.stdout.write(f"key:      {key}")
            self.stdout.write("          ^ copy it now - it is never shown again")
        elif o["action"] == "list":
            qs = AIRelayKey.objects.select_related("user").prefetch_related("groups")
            if o["user"]:
                qs = qs.filter(user__username__iexact=o["user"]) | qs.filter(user__email__iexact=o["user"])
            for k in qs:
                p = key_public(k)
                self.stdout.write(
                    f"{p['key_hint']:22} {p['username']:20} {','.join(x['slug'] for x in p['groups']):16} "
                    f"{'ACTIVE ' if p['active'] else 'revoked/expired'} "
                    f"today ${p['spend']['today_usd']:.2f}/{'-' if p['daily_budget_usd'] is None else p['daily_budget_usd']} "
                    f"month ${p['spend']['month_usd']:.2f}/{'-' if p['monthly_budget_usd'] is None else p['monthly_budget_usd']} "
                    f"{'UNLIMITED ' if p['unlimited'] else ''}"
                    f"last {p['last_used_at'] or '-'} {p['label']}")
        elif o["action"] == "set":
            import datetime as dt

            k = AIRelayKey.objects.filter(key_id=o["key_id"].replace("pirk_", "").split("_")[0]).first()
            if not k:
                raise CommandError("no such key")
            try:
                if o["groups"] is not None:
                    gs = resolve_groups({"group": [x.strip() for x in o["groups"].split(",") if x.strip()]})
                    if not gs:
                        raise BadInput(f"no agent group matched '{o['groups']}'")
                    k.groups.set(gs)
                if o["unlimited"]:
                    k.daily_budget_usd = k.monthly_budget_usd = None
                if o["daily"] is not None:
                    k.daily_budget_usd = parse_budget(o["daily"])
                if o["monthly"] is not None:
                    k.monthly_budget_usd = parse_budget(o["monthly"])
                if o["label"] is not None:
                    k.label = o["label"][:100]
                if o.get("purpose") is not None:
                    k.purpose = o["purpose"].strip()[:2000]
                if o["ips"] is not None:
                    k.allowed_ips = "" if o["ips"].lower() == "none" else parse_ips(o["ips"])
                if o["expires_days"] is not None:
                    k.expires_at = None if o["expires_days"].lower() == "never" else \
                        timezone.now() + dt.timedelta(days=int(o["expires_days"]))
            except (BadInput, ValueError) as e:
                raise CommandError(str(e))
            k.save()
            p = key_public(k)
            cap = "unlimited" if p["unlimited"] else f"daily {p['daily_budget_usd'] or '-'} / monthly {p['monthly_budget_usd'] or '-'}"
            self.stdout.write(f"updated {k}: {cap}; groups {', '.join(x['slug'] for x in p['groups'])}; "
                              f"expires {p['expires_at'] or 'never'}; ips {p['allowed_ips'] or 'any'}")
        elif o["action"] == "delete":
            k = AIRelayKey.objects.filter(key_id=o["key_id"].replace("pirk_", "").split("_")[0]).first()
            if not k:
                raise CommandError("no such key")
            if not k.revoked_at and not o["force"]:
                raise CommandError("that key is still ACTIVE - revoke it first, or pass --force")
            who = f"{k.user.username} / {', '.join(k.groups.values_list('slug', flat=True))}"
            k.delete()
            self.stdout.write(f"deleted {o['key_id']} ({who}) permanently")
        elif o["action"] == "notify-update":
            from core.relay import notify_all_relay_users, served_client_version

            res = notify_all_relay_users("the RMM", only_user=o["user"], dry_run=o["dry_run"])
            self.stdout.write(f"client version served: {res['client_version'] or 'unknown'}"
                              f"{'  (DRY RUN - nothing sent)' if res['dry_run'] else ''}")
            for x in res["sent"]:
                self.stdout.write(f"  sent   {x['user']:24} -> {x['to']}")
            for x in res["skipped"]:
                self.stdout.write(f"  skip   {x['user']:24} {x['reason']}")
            for x in res["failed"]:
                self.stdout.write(f"  FAILED {x['user']:24} {x['error']}")
            self.stdout.write(f"totals: sent={len(res['sent'])} skipped={len(res['skipped'])} failed={len(res['failed'])}")
        elif o["action"] == "revoke":
            k = AIRelayKey.objects.filter(key_id=o["key_id"].replace("pirk_", "").split("_")[0]).first()
            if not k:
                raise CommandError("no such key")
            k.revoked_at = timezone.now()
            k.revoked_by = _actor(o.get("by"))
            k.save(update_fields=["revoked_at", "revoked_by"])
            self.stdout.write(f"revoked {k}")
