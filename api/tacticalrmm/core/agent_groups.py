"""Agent Groups: a named team of specialist models for one Pi chat.

The orchestrator is the model the technician talks to. Other roles are delegated
to (cheap scout / grep / summarizer, expensive coder) so a long ticket does not
re-send every file read through the $50/hour model.

Roles are a fixed catalog. Member models are NOT restricted to the Models table
- any id the provider currently serves is allowed. A group's is_default flag
outranks the starred Models default for new chats.
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any, Optional

from django.utils.text import slugify

ROLE_DEFINITIONS = {
    "orchestrator": (
        "You are the face of the chat. The technician talks only to you.\n"
        "Plan the work, decide which specialist to call, and synthesize their answers.\n"
        "Delegate recon, search, planning, review, and first-pass summaries so this "
        "conversation stays small. You keep the TRMM / ticket tools; specialists do not "
        "mutate devices. Do not dump raw logs or whole files into this thread if a "
        "specialist can compress them first. Prefer scout → planner → you apply the plan."
    ),
    "scout": (
        "Fast survey only. Look at a codebase, a ticket, a log, or a device and return a "
        "compressed briefing: what exists, what matters, what to ignore.\n"
        "Do not implement, do not draft a full plan, do not write code. Names, IDs, error "
        "strings, and file paths stay verbatim. Keep the answer short enough that the "
        "orchestrator can paste it forward without bloating the main chat."
    ),
    "files": (
        "Read and list files. Return the relevant contents, a tree, or the exact lines "
        "asked for. Do not edit, do not search the whole tree (that is grep), do not "
        "summarise away code the orchestrator asked to see. Quote paths exactly."
    ),
    "grep": (
        "Search the tree. Return matching paths and a short snippet per hit.\n"
        "Do not edit. Do not read entire files unless a single hit is useless without "
        "the surrounding function. Deduplicate. Prefer the tightest pattern that answers "
        "the question."
    ),
    "planner": (
        "Turn a goal plus whatever recon you are given into a concrete, ordered plan.\n"
        "Each step should say who does it (orchestrator / coder / operator / human) and "
        "what done looks like. Do not implement. Do not run tools that change anything. "
        "Call out risks, missing facts, and the smallest change that would work."
    ),
    "coder": (
        "Write or edit code. Touch only what the task requires.\n"
        "If a workspace is configured, make the change and summarise the diff. If not, "
        "return a complete patch the orchestrator can apply. Do not expand scope. Do not "
        "refactor adjacent code. Match the existing style."
    ),
    "operator": (
        "Draft the exact device fix: commands, scripts, expected output, and rollback.\n"
        "You do not run anything and you do not claim you did. The orchestrator keeps "
        "the TRMM tools and will execute. Be specific (full command lines, service names, "
        "paths). Flag anything disruptive (reboot, data loss, customer-facing)."
    ),
    "reviewer": (
        "Review a proposed change, script, or plan. Return: bugs, risks, missing steps, "
        "and a go / no-go.\n"
        "Do not rewrite it unless asked. Do not implement an alternative. Quote the "
        "line or step you are objecting to."
    ),
    "summarizer": (
        "Compress the given material into a briefing the orchestrator can work from.\n"
        "Keep names, IDs, numbers, error text, decisions, and open questions. Drop "
        "pleasantries, repeated tool noise, and anything the next turn does not need. "
        "This role exists so a long ticket stops re-sending millions of tokens."
    ),
}

ROLE_CATALOG = [
    {
        "id": "orchestrator",
        "label": "Orchestrator",
        "required": True,
        "kinds": ["coding", "it", "custom"],
        "description": ROLE_DEFINITIONS["orchestrator"],
    },
    {
        "id": "scout",
        "label": "Scout / recon",
        "required": False,
        "kinds": ["coding", "it", "custom"],
        "description": ROLE_DEFINITIONS["scout"],
    },
    {
        "id": "files",
        "label": "File browser",
        "required": False,
        "kinds": ["coding", "custom"],
        "description": ROLE_DEFINITIONS["files"],
    },
    {
        "id": "grep",
        "label": "Search",
        "required": False,
        "kinds": ["coding", "custom"],
        "description": ROLE_DEFINITIONS["grep"],
    },
    {
        "id": "planner",
        "label": "Planner",
        "required": False,
        "kinds": ["coding", "it", "custom"],
        "description": ROLE_DEFINITIONS["planner"],
    },
    {
        "id": "coder",
        "label": "Coder",
        "required": False,
        "kinds": ["coding", "custom"],
        "description": ROLE_DEFINITIONS["coder"],
    },
    {
        "id": "operator",
        "label": "Operator",
        "required": False,
        "kinds": ["it", "custom"],
        "description": ROLE_DEFINITIONS["operator"],
    },
    {
        "id": "reviewer",
        "label": "Reviewer",
        "required": False,
        "kinds": ["coding", "it", "custom"],
        "description": ROLE_DEFINITIONS["reviewer"],
    },
    {
        "id": "summarizer",
        "label": "Summarizer",
        "required": False,
        "kinds": ["coding", "it", "custom"],
        "description": ROLE_DEFINITIONS["summarizer"],
    },
]

ROLE_IDS = {r["id"] for r in ROLE_CATALOG}
REQUIRED_ROLES = {r["id"] for r in ROLE_CATALOG if r["required"]}

# Recommended rosters. Models are looked up against live providers at seed time;
# a member whose provider has no key is skipped, not fatal.
SEED_GROUPS = [
    {
        "name": "Coding",
        "slug": "coding",
        "kind": "coding",
        "is_default": False,
        "description": (
            "Multi-agent coding team. Sonnet orchestrates; Haiku does recon / files / "
            "grep / summaries; Grok 4.6 only gets called to write code. Keeps the expensive "
            "model's context small."
        ),
        "members": [
            ("orchestrator", "anthropic", "claude-sonnet-5", "Claude Sonnet 5", "medium"),
            ("scout", "anthropic", "claude-haiku-4-5", "Claude Haiku 4.5", "low"),
            ("files", "anthropic", "claude-haiku-4-5", "Claude Haiku 4.5", "low"),
            ("grep", "anthropic", "claude-haiku-4-5", "Claude Haiku 4.5", "low"),
            ("planner", "anthropic", "claude-sonnet-5", "Claude Sonnet 5", "medium"),
            ("coder", "xai", "grok-4.6", "grok-4.6", "high"),
            ("reviewer", "anthropic", "claude-sonnet-5", "Claude Sonnet 5", "medium"),
            ("summarizer", "anthropic", "claude-haiku-4-5", "Claude Haiku 4.5", "low"),
        ],
    },
    {
        "name": "Coding+",
        "slug": "coding-plus",
        "kind": "coding",
        "is_default": False,
        "description": (
            "Same team as Coding, but the coder is Claude Fable 5.1. Grok orchestrates "
            "and plans; Haiku does recon / files / grep / summaries; Sonnet reviews. Only "
            "the actual code-writing step pays for the top-tier model."
        ),
        "members": [
            ("orchestrator", "xai", "grok-4.6", "grok-4.6", "medium"),
            ("scout", "anthropic", "claude-haiku-4-5", "Claude Haiku 4.5", "low"),
            ("files", "anthropic", "claude-haiku-4-5", "Claude Haiku 4.5", "low"),
            ("grep", "anthropic", "claude-haiku-4-5", "Claude Haiku 4.5", "low"),
            ("planner", "xai", "grok-4.6", "grok-4.6", "medium"),
            ("coder", "anthropic", "claude-fable-5-1", "Claude Fable 5.1", "high"),
            ("reviewer", "anthropic", "claude-sonnet-5", "Claude Sonnet 5", "medium"),
            ("summarizer", "anthropic", "claude-haiku-4-5", "Claude Haiku 4.5", "low"),
        ],
    },
    {
        "name": "IT",
        "slug": "it",
        "kind": "it",
        "is_default": True,
        "description": (
            "Multi-agent IT / ticket team. Grok stays the face of the chat (same as "
            "today's default); Haiku scouts and summarises so a long ticket does not "
            "keep re-sending the whole transcript; Sonnet plans, drafts fixes, and reviews."
        ),
        "members": [
            ("orchestrator", "xai", "grok-4.6", "grok-4.6", "high"),
            ("scout", "anthropic", "claude-haiku-4-5", "Claude Haiku 4.5", "low"),
            ("planner", "anthropic", "claude-sonnet-5", "Claude Sonnet 5", "medium"),
            ("operator", "anthropic", "claude-sonnet-5", "Claude Sonnet 5", "medium"),
            ("reviewer", "anthropic", "claude-sonnet-5", "Claude Sonnet 5", "medium"),
            ("summarizer", "anthropic", "claude-haiku-4-5", "Claude Haiku 4.5", "low"),
        ],
    },
]


def public_groups():
    """Browser-safe list of enabled groups (no API keys)."""
    from core.models import AIAgentGroup

    out = []
    for g in AIAgentGroup.objects.filter(enabled=True).prefetch_related("members"):
        out.append(public_group(g))
    return out


def public_group(g) -> dict:
    orch = next((m for m in g.members.all() if m.role == "orchestrator" and m.enabled), None)
    return {
        "id": g.id,
        "name": g.name,
        "slug": g.slug,
        "kind": g.kind,
        "description": g.description,
        "is_default": g.is_default,
        "workspace": g.workspace or "",
        "orchestrator": (
            {
                "provider": orch.provider,
                "model_id": orch.model_id,
                "display_name": orch.display_name or orch.model_id,
                "thinking_level": orch.thinking_level,
            }
            if orch
            else None
        ),
        "roles": [
            {
                "role": m.role,
                "provider": m.provider,
                "model_id": m.model_id,
                "display_name": m.display_name or m.model_id,
                "thinking_level": m.thinking_level,
                "definition": m.definition or "",
            }
            for m in g.members.all()
            if m.enabled
        ],
    }


def blob_group(g) -> dict:
    """Full roster for the bridge (still no API keys - those live on providers)."""
    pub = public_group(g)
    pub["members"] = pub["roles"]
    return pub


def _provider_map():
    from core.models import AIProvider

    return {p.name: p for p in AIProvider.objects.filter(enabled=True)}


def resolve_orchestrator(group) -> Optional[SimpleNamespace]:
    """Return a chosen-model-shaped object for the group's orchestrator, or None."""
    member = next(
        (m for m in group.members.all() if m.role == "orchestrator" and m.enabled),
        None,
    )
    if not member:
        return None
    return resolve_member(member)


def resolve_member(member) -> Optional[SimpleNamespace]:
    providers = _provider_map()
    prov = providers.get(member.provider)
    if not prov or not prov.api_key:
        return None
    return SimpleNamespace(
        provider=prov,
        model_id=member.model_id,
        display_name=member.display_name or member.model_id,
        thinking_level=member.thinking_level or "medium",
    )


def pick_group(request) -> tuple[Optional[Any], list]:
    """Decide which group (if any) this new session should use.

    - group_id in the body (including null) is an explicit choice.
    - A resume without an explicit group_id does not apply the default
      (the existing session already has a model).
    - Otherwise the default group wins over the starred Models default.
    """
    from core.models import AIAgentGroup

    groups = list(AIAgentGroup.objects.filter(enabled=True).prefetch_related("members"))
    public = [public_group(g) for g in groups]
    by_id = {g.id: g for g in groups}

    data = getattr(request, "data", {}) or {}
    if "group_id" in data:
        raw = data.get("group_id")
        if raw in (None, "", 0, "0", "null"):
            return None, public
        try:
            gid = int(raw)
        except (TypeError, ValueError):
            return None, public
        return by_id.get(gid), public

    if data.get("resume_session"):
        return None, public

    default = next((g for g in groups if g.is_default), None)
    return default, public


def group_provider_keys(group_blob) -> dict:
    """API keys for every provider used by the group. Server-side only.
    Accepts either an AIAgentGroup or the public blob dict."""
    if not group_blob:
        return {}
    providers = _provider_map()
    names = set()
    if hasattr(group_blob, "members"):
        names = {m.provider for m in group_blob.members.all()}
    else:
        for m in (group_blob.get("members") or group_blob.get("roles") or []):
            if m.get("provider"):
                names.add(m["provider"])
        if group_blob.get("orchestrator", {}).get("provider"):
            names.add(group_blob["orchestrator"]["provider"])
    return {n: providers[n].api_key for n in names if n in providers and providers[n].api_key}


def apply_group(blob: dict, request, chosen):
    """Attach group metadata to the session blob. May replace `chosen` with the
    group's orchestrator. Returns the (possibly new) chosen model object."""
    group, public = pick_group(request)
    blob["agent_groups"] = public
    blob["agent_group"] = None
    blob["group_requested"] = "group_id" in (getattr(request, "data", None) or {})
    if not group:
        return chosen
    orch = resolve_orchestrator(group)
    if not orch:
        return chosen
    blob["agent_group"] = blob_group(group)
    return orch


def seed_builtin_groups(*, reset_members: bool = False) -> dict:
    """Create/update the Coding, Coding+ and IT groups. Idempotent.

    Members whose provider is not configured (or has no key) are skipped so a
    fresh box with only xAI still gets an IT group, just without the Anthropic
    specialists until that key is added.
    """
    from core.models import AIAgentGroup, AIAgentGroupMember, AIProvider

    have = {p.name for p in AIProvider.objects.filter(enabled=True) if p.api_key}
    created, updated, skipped = [], [], []
    for spec in SEED_GROUPS:
        group, was_created = AIAgentGroup.objects.update_or_create(
            slug=spec["slug"],
            defaults={
                "name": spec["name"],
                "kind": spec["kind"],
                "description": spec["description"],
                "enabled": True,
                "is_default": spec.get("is_default", False),
            },
        )
        (created if was_created else updated).append(spec["slug"])
        if reset_members or was_created:
            if reset_members:
                group.members.all().delete()
            for role, provider, model_id, display, thinking in spec["members"]:
                if provider not in have:
                    skipped.append(f"{spec['slug']}:{role} ({provider}/{model_id} — no key)")
                    continue
                AIAgentGroupMember.objects.update_or_create(
                    group=group,
                    role=role,
                    defaults={
                        "provider": provider,
                        "model_id": model_id,
                        "display_name": display,
                        "thinking_level": thinking,
                        "definition": ROLE_DEFINITIONS.get(role, ""),
                        "enabled": True,
                    },
                )
        # Re-assert a single default. The last seed spec with is_default wins.
        if spec.get("is_default"):
            AIAgentGroup.objects.exclude(pk=group.pk).update(is_default=False)
            if not group.is_default:
                group.is_default = True
                group.save(update_fields=["is_default"])
    return {"created": created, "updated": updated, "skipped": skipped}


def unique_slug(name: str, exclude_pk=None) -> str:
    base = slugify(name) or "group"
    slug = base
    from core.models import AIAgentGroup

    qs = AIAgentGroup.objects.all()
    if exclude_pk:
        qs = qs.exclude(pk=exclude_pk)
    n = 2
    while qs.filter(slug=slug).exists():
        slug = f"{base}-{n}"
        n += 1
    return slug
