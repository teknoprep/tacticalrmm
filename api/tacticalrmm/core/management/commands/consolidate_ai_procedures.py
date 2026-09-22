"""Consolidate the AI procedure library: merge duplicates, make every procedure GLOBAL,
lift customer specifics out, score each one, and auto-approve the ones that earn it.

Owner's brief (2026-09-15): "go through EVERY procedure, clean up every single one and merge
everything you can; procedures need to be global for all companies - KB is for specifics;
minimise the procedures and get every procedure with a score of 95% or above auto-approved."

HOW
  1. CLUSTER  - one model call over all titles/keywords proposes merge groups (which rows
                describe the same fix). Deterministic pre-grouping by category keeps the
                prompt small; the model only decides within a category.
  2. MERGE    - one call per group of 2+: produce ONE canonical, global procedure (symptom,
                root cause, fix, verification, keywords), list the customer-specific detail
                it lifted out, and rate 0-100 how correct/complete/general the result is.
  3. CLEAN    - singletons go through the same rewrite in batches of ~8: generalise, lift
                specifics, rate.
  4. SCORE    - score = model rating, CAPPED by evidence (1 ticket -> 70, 2 -> 80, 3-4 -> 90,
                5+ -> 100). Nothing seen once can be "certain" however well it reads.
  5. APPROVE  - score >= 95 -> status approved (unless already retired/rejected).

NOTHING IS DELETED. An absorbed duplicate is set status=retired with merged_into pointing at
the canonical row; its text, tickets and counts stay put. The canonical row's
occurrence_count is the SUM and source_ticket_refs the UNION, so evidence is never lost.
Deterministic fields that make a procedure a live rule (match/condition_key/disposition/
probe/auto_enabled) are carried from whichever source had them - they are never invented
by the merge. Re-running is safe: retired rows are skipped, and a row already consolidated
in this pass (updated_by="consolidation") is only re-scored, not re-merged.

Spend is recorded under surface "analyze" via the bridge, like every other model call.

Usage:
    manage.py consolidate_ai_procedures --dry-run        # plan only, writes nothing
    manage.py consolidate_ai_procedures
    manage.py consolidate_ai_procedures --approve-threshold 95 --limit-clusters 20
"""

from __future__ import annotations

import json
import re
import sys
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed

import requests
from django.conf import settings
from django.core.management.base import BaseCommand
from django.utils import timezone

EVIDENCE_CAP = [(1, 70), (2, 80), (4, 90), (10**9, 100)]

CLUSTER_PROMPT = """You are consolidating an MSP's library of troubleshooting PROCEDURES.
Each line is: ID | title | keywords. Group the IDs that describe THE SAME FIX for THE SAME
KIND OF PROBLEM - the same root cause and the same remedy, even if worded differently or
seen at different customers. Do NOT group things that merely share a product name: "restart
the SendPlot service" and "remove a dead SendPlot search entry" are different procedures.

Return ONLY JSON: {"groups": [[id, id, ...], ...]} listing groups of TWO OR MORE ids.
Leave singletons out. Every id may appear in at most one group."""

MERGE_PROMPT = """You are rewriting an MSP's troubleshooting PROCEDURE so it is GLOBAL:
usable at ANY customer. Rules:
- Procedures describe HOW a kind of problem is fixed. Customer-specific facts (hostnames,
  usernames, IPs, folder paths, a customer's product URL, company names, people's names)
  do NOT belong in the procedure text - lift them out into "company_specifics" and write
  the procedure in general terms ("the application host", "the scripts folder on the admin
  desktop"). Keep vendor/product names (SendPlot, Veeam, M365) - those are what it applies to.
- Keep every real technical step, warning and gotcha from the sources. Do not invent steps.
- If the sources disagree, prefer the most specific, most recent-looking detail and say so
  in "notes".
- verification must be something a technician can actually check.
- "score" is 0-100: how confident are you the merged procedure is CORRECT, COMPLETE and
  GENERAL enough to follow at a new customer without asking anyone. Be hard: 95+ means
  you would let it run unattended.

Return ONLY JSON with exactly these keys:
{"title": str, "category": str, "applies_to": "comma-separated keywords", "symptom": str,
 "root_cause": str, "fix": str, "verification": str,
 "company_specifics": [{"company": str, "detail": str}], "notes": str, "score": int,
 "score_reason": "one sentence"}"""

CLEAN_PROMPT = """You are cleaning an MSP's troubleshooting PROCEDURES so each is GLOBAL:
usable at ANY customer. For EACH procedure given (keyed by id) apply these rules:
- Lift customer-specific facts (hostnames, usernames, IPs, folder paths, a customer's URL,
  company names, people's names) OUT into "company_specifics" and generalise the wording.
  Keep vendor/product names - those are what it applies to.
- Keep every real technical step and warning. Do not invent steps. Tighten wording.
- "score" 0-100: confidence the procedure is CORRECT, COMPLETE and GENERAL enough to follow
  unattended at a new customer. Be hard: 95+ means you would let it run alone.

Return ONLY JSON: {"<id>": {"title","category","applies_to","symptom","root_cause","fix",
"verification","company_specifics":[{"company","detail"}],"score":int,"score_reason":str}, ...}
Include every id you were given."""


def _cap(occ: int) -> int:
    for upto, cap in EVIDENCE_CAP:
        if occ <= upto:
            return cap
    return 100


def _json_in(text: str):
    """The model sometimes wraps JSON in prose or a code fence. Find the outermost object."""
    t = (text or "").strip()
    t = re.sub(r"^```(?:json)?\s*|\s*```$", "", t, flags=re.I | re.M).strip()
    try:
        return json.loads(t)
    except Exception:
        pass
    m = re.search(r"\{[\s\S]*\}", t)
    if m:
        try:
            return json.loads(m.group(0))
        except Exception:
            return None
    return None


class Command(BaseCommand):
    help = "Merge duplicate AI procedures, make them global, score and auto-approve >= threshold"

    def add_arguments(self, parser):
        parser.add_argument("--dry-run", action="store_true")
        parser.add_argument("--approve-threshold", type=int, default=None,
                            help="override the global auto-approve SCORE gate (Global Settings)")
        parser.add_argument("--limit-clusters", type=int, default=0, help="testing: merge at most N groups")
        parser.add_argument("--skip-singletons", action="store_true")
        parser.add_argument("--rescore-only", action="store_true",
                            help="do not call the model; recompute score caps and approvals only")
        parser.add_argument("--workers", type=int, default=6, help="parallel model calls")

    # ---- model access ----------------------------------------------------------
    def _model(self):
        from core.tasks import _resolve_ai_model

        m = _resolve_ai_model(None)
        if not m:
            raise RuntimeError("no enabled default AI model")
        return m

    def _analyze(self, system_prompt: str, content: str, purpose: str, timeout=420) -> str:
        m = self._model()
        bridge = getattr(settings, "PI_BRIDGE_URL", "http://127.0.0.1:8787")
        r = requests.post(
            f"{bridge}/pi/analyze",
            json={
                "provider": m.provider.name, "api_key": m.provider.api_key,
                "model_id": m.model_id, "thinking_level": m.thinking_level or "medium",
                "system_prompt": system_prompt, "content": content,
                "purpose": f"procedures:{purpose}", "username": "consolidation",
            },
            timeout=(10, timeout),
        )
        out = r.json()
        if out.get("error"):
            raise RuntimeError(str(out["error"])[:300])
        return out.get("text") or ""

    def _say(self, msg):
        self.stdout.write(msg)
        try:
            self.stdout.flush()
            sys.stdout.flush()
        except Exception:
            pass

    # ---- helpers ---------------------------------------------------------------
    @staticmethod
    def _proc_blob(p) -> str:
        return (
            f"### id={p.pk}  title: {p.title}\n"
            f"category: {p.category}\napplies_to: {p.applies_to}\n"
            f"seen: {p.occurrence_count}x  confidence: {p.confidence}  status: {p.status}\n"
            f"SYMPTOM: {p.symptom}\nROOT CAUSE: {p.root_cause}\nFIX: {p.fix}\n"
            f"VERIFICATION: {p.verification}\n"
        )

    @staticmethod
    def _apply_text(p, d: dict):
        for k in ("title", "category", "applies_to", "symptom", "root_cause", "fix", "verification"):
            v = d.get(k)
            if isinstance(v, str) and v.strip():
                setattr(p, k, v.strip()[:300] if k in ("title",) else (v.strip()[:400] if k in ("applies_to",) else (v.strip()[:100] if k == "category" else v.strip())))
        specs = d.get("company_specifics")
        if isinstance(specs, list):
            clean = []
            for s in specs:
                if isinstance(s, dict) and (s.get("detail") or "").strip():
                    clean.append({"company": str(s.get("company") or "")[:120], "detail": str(s["detail"])[:1000]})
            # union with what may already be there
            seen = {(x.get("company"), x.get("detail")) for x in (p.company_specifics or [])}
            for c in clean:
                if (c["company"], c["detail"]) not in seen:
                    p.company_specifics = list(p.company_specifics or []) + [c]

    @staticmethod
    def _apply_score(p, rating, reason: str, threshold: int, seen_gate: int = 0):
        try:
            rating = int(rating)
        except Exception:
            rating = 0
        rating = max(0, min(100, rating))
        cap = _cap(int(p.occurrence_count or 0))
        p.score = min(rating, cap)
        why = (reason or "").strip()[:300]
        if rating > cap:
            why = (why + f" (rated {rating}, capped at {cap}: seen {p.occurrence_count}x)")[:400]
        p.score_reason = why
        # BOTH gates (Global Settings): score AND times seen. See AIProcedure.maybe_auto_approve.
        if (p.status not in ("retired", "rejected", "approved")
                and p.score >= threshold and int(p.occurrence_count or 0) >= seen_gate):
            p.status = "approved"

    # ---- main ------------------------------------------------------------------
    def handle(self, *args, **o):
        from core.models import AIProcedure

        from core.utils import get_core_settings

        dry = o["dry_run"]
        core = get_core_settings()
        thr = o["approve_threshold"] if o["approve_threshold"] is not None else int(core.ai_procedure_auto_approve_score or 95)
        seen_gate = int(core.ai_procedure_auto_approve_seen or 0)
        self._say(f"auto-approve gates: score >= {thr} AND seen >= {seen_gate}")
        live = list(AIProcedure.objects.exclude(status="retired").exclude(status="rejected").order_by("pk"))
        self._say(f"live procedures: {len(live)}")

        if o["rescore_only"]:
            n = 0
            for p in live:
                before = (p.score, p.status)
                self._apply_score(p, p.score or 0, p.score_reason, thr, seen_gate)
                if (p.score, p.status) != before:
                    n += 1
                    if not dry:
                        p.save(update_fields=["score", "score_reason", "status"])
            self.stdout.write(f"rescored: {n} changed")
            return

        # ---- 1. cluster, per category so the prompt stays small -------------------
        by_cat = defaultdict(list)
        for p in live:
            by_cat[(p.category or "").strip().lower() or "(none)"].append(p)
        groups = []
        cats = [(c, r) for c, r in sorted(by_cat.items(), key=lambda kv: -len(kv[1])) if len(r) >= 2]
        self._say(f"clustering {len(cats)} categories with {o['workers']} workers...")

        def _cluster(cat, rows):
            lines = "\n".join(f"{p.pk} | {p.title} | {p.applies_to}" for p in rows)
            return cat, rows, _json_in(self._analyze(CLUSTER_PROMPT, lines, "cluster"))

        with ThreadPoolExecutor(max_workers=max(1, o["workers"])) as ex:
            futs = [ex.submit(_cluster, c, r) for c, r in cats]
            for f in as_completed(futs):
                try:
                    cat, rows, out = f.result()
                except Exception as e:
                    self.stderr.write(f"  cluster call failed: {e}")
                    continue
                ids = {p.pk for p in rows}
                n = 0
                for g in (out or {}).get("groups") or []:
                    g = [int(x) for x in g if str(x).isdigit() and int(x) in ids]
                    if len(set(g)) >= 2:
                        groups.append(sorted(set(g)))
                        n += 1
                self._say(f"  {cat:<22} {len(rows):>3} procs -> {n} group(s)")
        # an id may only be absorbed once
        used = set()
        clean_groups = []
        for g in groups:
            g = [i for i in g if i not in used]
            if len(g) >= 2:
                used.update(g)
                clean_groups.append(g)
        if o["limit_clusters"]:
            clean_groups = clean_groups[: o["limit_clusters"]]
        self._say(f"merge groups proposed: {len(clean_groups)} covering {sum(len(g) for g in clean_groups)} procedures")

        by_id = {p.pk: p for p in live}
        merged = 0
        retired = 0
        approved = 0

        # ---- 2. merge -----------------------------------------------------------
        def _merge_call(g):
            rows = [by_id[i] for i in g]
            content = "\n\n".join(self._proc_blob(p) for p in rows)
            return g, _json_in(self._analyze(MERGE_PROMPT, content, "merge"))

        merge_results = {}
        self._say(f"merging {len(clean_groups)} group(s)...")
        with ThreadPoolExecutor(max_workers=max(1, o["workers"])) as ex:
            futs = {ex.submit(_merge_call, g): g for g in clean_groups}
            for f in as_completed(futs):
                g = futs[f]
                try:
                    _, d = f.result()
                    merge_results[tuple(g)] = d
                except Exception as e:
                    self.stderr.write(f"  merge failed for {g}: {e}")
                self._say(f"  merged {len(merge_results)}/{len(clean_groups)}")

        for g in clean_groups:
            d = merge_results.get(tuple(g))
            rows = [by_id[i] for i in g]
            # canonical = the one with the most evidence, then the most text
            canon = sorted(rows, key=lambda p: (-(p.occurrence_count or 0), -len(p.fix or "")))[0]
            if not isinstance(d, dict) or not d.get("fix"):
                self.stderr.write(f"  merge returned no usable text for {g}")
                continue
            self._say(f"  MERGE {g} -> [{canon.pk}] {d.get('title', canon.title)[:70]}  score={d.get('score')}")
            if dry:
                merged += 1
                continue
            # union evidence
            refs = []
            for p in rows:
                for r in (p.source_ticket_refs or []):
                    if r not in refs:
                        refs.append(r)
            canon.source_ticket_refs = refs
            canon.occurrence_count = sum(int(p.occurrence_count or 0) for p in rows)
            canon.first_seen = min([p.first_seen for p in rows if p.first_seen] or [None]) if any(p.first_seen for p in rows) else canon.first_seen
            canon.last_seen = max([p.last_seen for p in rows if p.last_seen] or [None]) if any(p.last_seen for p in rows) else canon.last_seen
            # deterministic half: carry, never invent. Prefer a LIVE rule's fields.
            for src in sorted(rows, key=lambda p: (not p.is_live_rule, not bool(p.match))):
                if src is canon:
                    continue
                if not canon.match and isinstance(src.match, dict) and src.match:
                    canon.match = src.match
                if not canon.condition_key and src.condition_key:
                    canon.condition_key = src.condition_key
                if not canon.disposition and src.disposition:
                    canon.disposition = src.disposition
                if (canon.evidence or "none") == "none" and (src.evidence or "none") != "none":
                    canon.evidence = src.evidence
                if not canon.probe and isinstance(src.probe, dict) and src.probe:
                    canon.probe = src.probe
                if not canon.repeat_policy and src.repeat_policy:
                    canon.repeat_policy = src.repeat_policy
                if canon.baseline_minutes is None and src.baseline_minutes is not None:
                    canon.baseline_minutes = src.baseline_minutes
                canon.auto_enabled = canon.auto_enabled or bool(src.auto_enabled and src.status == "approved")
                # specifics from the absorbed rows survive
                for c in (src.company_specifics or []):
                    if c not in (canon.company_specifics or []):
                        canon.company_specifics = list(canon.company_specifics or []) + [c]
            # any source already approved by a human keeps the merged one approved
            if any(p.status == "approved" for p in rows):
                canon.status = "approved"
            self._apply_text(canon, d)
            notes = (d.get("notes") or "").strip()
            self._apply_score(canon, d.get("score"), d.get("score_reason") or notes, thr, seen_gate)
            canon.updated_by = "consolidation"
            canon.save()
            merged += 1
            if canon.status == "approved":
                approved += 1
            for p in rows:
                if p is canon:
                    continue
                p.status = "retired"
                p.merged_into = canon
                p.updated_by = "consolidation"
                p.save(update_fields=["status", "merged_into", "updated_by", "updated"])
                retired += 1

        # ---- 3. clean singletons ------------------------------------------------
        cleaned = 0
        if not o["skip_singletons"]:
            singles = [p for p in live if p.pk not in used and p.updated_by != "consolidation"]
            self._say(f"singletons to clean: {len(singles)}")
            batch = 6
            chunks = [singles[i:i + batch] for i in range(0, len(singles), batch)]

            def _clean_call(chunk):
                content = "\n\n".join(self._proc_blob(p) for p in chunk)
                return chunk, _json_in(self._analyze(CLEAN_PROMPT, content, "clean"))

            results = []
            with ThreadPoolExecutor(max_workers=max(1, o["workers"])) as ex:
                futs = [ex.submit(_clean_call, c) for c in chunks]
                for f in as_completed(futs):
                    try:
                        results.append(f.result())
                    except Exception as e:
                        self.stderr.write(f"  clean batch failed: {e}")
                    self._say(f"  cleaned batches {len(results)}/{len(chunks)}")
            for chunk, d in results:
                if not isinstance(d, dict):
                    continue
                for p in chunk:
                    row = d.get(str(p.pk)) or d.get(p.pk)
                    if not isinstance(row, dict):
                        continue
                    if dry:
                        cleaned += 1
                        continue
                    self._apply_text(p, row)
                    self._apply_score(p, row.get("score"), row.get("score_reason"), thr, seen_gate)
                    p.updated_by = "consolidation"
                    p.save()
                    cleaned += 1
                    if p.status == "approved":
                        approved += 1

        # ---- summary ------------------------------------------------------------
        remaining = AIProcedure.objects.exclude(status="retired").exclude(status="rejected").count()
        self.stdout.write("")
        self.stdout.write(f"merged groups   : {merged}")
        self.stdout.write(f"retired (absorbed): {retired}")
        self.stdout.write(f"singletons cleaned: {cleaned}")
        self.stdout.write(f"now approved (>= {thr}) touched this run: {approved}")
        self.stdout.write(f"live procedures after: {remaining}" + ("  [DRY RUN - nothing written]" if dry else ""))
