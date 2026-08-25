from django.conf import settings
from rest_framework import serializers

from tacticalrmm.constants import (
    ALL_TIMEZONES,
    TerminalShellChoices,
)

from .models import (
    AIModel,
    AIProvider,
    AITask,
    AITaskRun,
    BulkAICommand,
    CodeSignToken,
    CoreSettings,
    CustomField,
    GlobalKVStore,
    MonthlyType,
    Schedule,
    ScheduleType,
    URLAction,
)


class HostedCoreMixin:
    def to_representation(self, instance):
        ret = super().to_representation(instance)  # type: ignore
        if getattr(settings, "HOSTED", False):
            for field in ("mesh_site", "mesh_token", "mesh_username"):
                ret[field] = "n/a"

            ret["sync_mesh_with_trmm"] = True
            ret["enable_server_scripts"] = False
            ret["enable_server_webterminal"] = False

        return ret


class CoreSettingsSerializer(HostedCoreMixin, serializers.ModelSerializer):
    all_timezones = serializers.SerializerMethodField("all_time_zones")

    def all_time_zones(self, obj):
        return ALL_TIMEZONES

    def validate(self, attrs):
        instance = getattr(self, "instance", None)

        def get_value(key):
            if key in attrs:
                return attrs[key]
            if instance:
                return getattr(instance, key)
            return None

        def require_custom(selection_key, custom_key):
            selection = get_value(selection_key)
            custom_path = (get_value(custom_key) or "").strip()

            if selection == TerminalShellChoices.CUSTOM and not custom_path:
                raise serializers.ValidationError(
                    {custom_key: "Custom shell path is required."}
                )

        require_custom("default_shell_windows", "default_shell_windows_custom")
        require_custom("default_shell_linux", "default_shell_linux_custom")
        require_custom("default_shell_darwin", "default_shell_darwin_custom")

        operator_ids = get_value("ai_operator_allowed_agent_ids") or []
        if not isinstance(operator_ids, list):
            raise serializers.ValidationError(
                {"ai_operator_allowed_agent_ids": "Operator workstations must be a list."}
            )
        operator_ids = [str(value or "").strip() for value in operator_ids]
        if any(not value for value in operator_ids) or len(operator_ids) > 8 or len(set(operator_ids)) != len(operator_ids):
            raise serializers.ValidationError(
                {"ai_operator_allowed_agent_ids": "Choose 1-8 unique existing workstations."}
            )
        if operator_ids:
            from agents.models import Agent

            found = Agent.objects.filter(agent_id__in=operator_ids).count()
            if found != len(operator_ids):
                raise serializers.ValidationError(
                    {"ai_operator_allowed_agent_ids": "One of the Operator workstations no longer exists."}
                )
        attrs["ai_operator_allowed_agent_ids"] = operator_ids

        operator_enabled = bool(get_value("ai_operator_enabled"))
        operator_model = get_value("ai_operator_default_model")
        if operator_enabled and not operator_model:
            # Desktop Control must always have an explicit model when enabled.
            from core.models import AIModel

            operator_model = (
                AIModel.objects.filter(enabled=True, provider__enabled=True, is_default=True)
                .select_related("provider")
                .first()
                or AIModel.objects.filter(enabled=True, provider__enabled=True)
                .select_related("provider")
                .order_by("id")
                .first()
            )
            if not operator_model:
                raise serializers.ValidationError(
                    {"ai_operator_default_model": "Enable at least one AI model before turning on Desktop Access."}
                )
            attrs["ai_operator_default_model"] = operator_model
        if operator_model and (not operator_model.enabled or not operator_model.provider.enabled):
            raise serializers.ValidationError(
                {"ai_operator_default_model": "Desktop default model and provider must both be enabled."}
            )

        # ---- Remote (mobile) relay ------------------------------------------------
        # Canonical storage is http(s)://; the bridge converts to ws(s):// when it opens
        # the socket. Rejecting ws(s):// at the user boundary (rather than quietly
        # coercing it) keeps one single form in the database - two forms drift, and the
        # person who pasted the wrong one never finds out why pairing fails.
        relay = (get_value("ai_remote_relay_url") or "").strip()
        if relay:
            lower = relay.lower()
            if lower.startswith("ws://") or lower.startswith("wss://"):
                raise serializers.ValidationError(
                    {
                        "ai_remote_relay_url": (
                            "Enter the relay as http:// or https:// - the same URL your "
                            "reverse proxy serves. The WebSocket form is derived from it."
                        )
                    }
                )
            if not (lower.startswith("http://") or lower.startswith("https://")):
                raise serializers.ValidationError(
                    {"ai_remote_relay_url": "Relay URL must start with http:// or https://."}
                )
            from urllib.parse import urlparse

            if not urlparse(relay).netloc:
                raise serializers.ValidationError(
                    {"ai_remote_relay_url": "That is not a usable relay URL."}
                )
        attrs["ai_remote_relay_url"] = relay
        if bool(get_value("ai_remote_enabled")) and not relay:
            raise serializers.ValidationError(
                {
                    "ai_remote_relay_url": (
                        "Set the relay URL before enabling mobile access. There is no "
                        "default relay on purpose - a relay can see the conversation "
                        "passing through it, so it has to be one you chose."
                    )
                }
            )

        return attrs

    class Meta:
        model = CoreSettings
        fields = "__all__"


# for audting
class CoreSerializer(HostedCoreMixin, serializers.ModelSerializer):
    class Meta:
        model = CoreSettings
        fields = "__all__"


class CustomFieldSerializer(serializers.ModelSerializer):
    class Meta:
        model = CustomField
        fields = "__all__"


class CodeSignTokenSerializer(serializers.ModelSerializer):
    class Meta:
        model = CodeSignToken
        fields = "__all__"


class KeyStoreSerializer(serializers.ModelSerializer):
    class Meta:
        model = GlobalKVStore
        fields = "__all__"


class URLActionSerializer(serializers.ModelSerializer):
    class Meta:
        model = URLAction
        fields = "__all__"


class ScheduleSerializer(serializers.ModelSerializer):
    class Meta:
        model = Schedule
        fields = "__all__"

    def to_representation(self, instance):
        # we only need to show data for the schedule type, so this function strips out irrelevant fields
        # could have also done this on the frontend instead of here, but this is a bit cleaner
        ret = super().to_representation(instance)

        # need empty states so frontend doesn't break
        empty_states = {
            "run_time_weekdays": [],
            "monthly_months_of_year": [],
            "monthly_days_of_month": [],
            "monthly_weeks_of_month": [],
        }

        if instance.schedule_type == ScheduleType.DAILY:
            fields_to_clear = [
                "run_time_weekdays",
                "monthly_months_of_year",
                "monthly_days_of_month",
                "monthly_weeks_of_month",
            ]
            for field in fields_to_clear:
                ret[field] = empty_states[field]

        elif instance.schedule_type == ScheduleType.WEEKLY:
            fields_to_clear = [
                "monthly_months_of_year",
                "monthly_days_of_month",
                "monthly_weeks_of_month",
            ]
            for field in fields_to_clear:
                ret[field] = empty_states[field]

        elif instance.schedule_type == ScheduleType.MONTHLY:
            if instance.monthly_type == MonthlyType.DAYS:
                fields_to_clear = [
                    "monthly_weeks_of_month",
                    "run_time_weekdays",
                ]
                for field in fields_to_clear:
                    ret[field] = empty_states[field]

            elif instance.monthly_type == MonthlyType.WEEKS:
                fields_to_clear = [
                    "monthly_days_of_month",
                ]
                for field in fields_to_clear:
                    ret[field] = empty_states[field]

        return ret


class ScheduleAuditSerializer(serializers.ModelSerializer):
    class Meta:
        model = Schedule
        fields = "__all__"


class AIModelSerializer(serializers.ModelSerializer):
    provider_name = serializers.CharField(source="provider.name", read_only=True)

    class Meta:
        model = AIModel
        fields = "__all__"


class AIProcedureSerializer(serializers.ModelSerializer):
    # Human-friendly 7-digit reference (0000001, 0000002, ...) = the row id zero-padded,
    # so a procedure can be named in a sentence without ambiguity.
    code = serializers.SerializerMethodField()

    class Meta:
        from core.models import AIProcedure

        model = AIProcedure
        fields = "__all__"
        read_only_fields = ("created", "updated")

    def get_code(self, obj) -> str:
        return f"{obj.id:07d}" if obj.id else ""


class AIProviderSerializer(serializers.ModelSerializer):
    models = AIModelSerializer(many=True, read_only=True)
    api_key_set = serializers.SerializerMethodField()

    class Meta:
        model = AIProvider
        fields = "__all__"
        extra_kwargs = {"api_key": {"write_only": True, "required": False}}

    def get_api_key_set(self, obj) -> bool:
        return bool(obj.api_key)

    def validate_api_key(self, value):
        """Refuse anything that plainly is not an API key.

        A whole HTML error page was once saved here and dutifully sent to OpenAI, which
        answered `Incorrect API key provided: <!doctyp****tml>`. The field accepted it
        because nothing ever looked: it is a CharField, and any 139 characters fit. The
        cost of that is paid much later and somewhere else - the chat fails with a
        provider error that says nothing about the settings page it came from.

        Deliberately shape-based, not format-based: keys differ per provider and new ones
        appear, so this rejects what cannot be a key rather than allow-listing prefixes.
        Surrounding whitespace is stripped rather than rejected - a trailing newline from a
        copy/paste is the single most common way a valid key silently fails to work.
        """
        if value is None:
            return value
        v = str(value).strip()
        if not v:
            return v
        if "<" in v or ">" in v:
            raise serializers.ValidationError(
                "That does not look like an API key - it contains HTML. If you copied an "
                "error message by mistake, copy the key from the provider's dashboard instead."
            )
        if any(c.isspace() for c in v):
            raise serializers.ValidationError(
                "An API key cannot contain spaces or line breaks. Paste only the key itself."
            )
        if len(v) < 16:
            raise serializers.ValidationError(
                f"That key is only {len(v)} characters, which is too short to be valid."
            )
        if not all(32 < ord(c) < 127 for c in v):
            raise serializers.ValidationError(
                "That key contains non-printable or non-ASCII characters - it looks like it "
                "was mangled in copying. Copy it again from the provider's dashboard."
            )
        return v


class AITaskSerializer(serializers.ModelSerializer):
    hostname = serializers.CharField(source="agent.hostname", read_only=True)
    agent_id = serializers.CharField(source="agent.agent_id", read_only=True)
    model_display = serializers.SerializerMethodField()
    # Read-only, hostname-resolved view of `machines` (raw field stays [{agent_id,
    # role}] for editing) so the UI can render "<hostname> - <role>" without a
    # second round-trip. Missing/renamed agents degrade to hostname="" rather than
    # erroring - a task must keep working even if a secondary machine was deleted.
    machines_detail = serializers.SerializerMethodField()

    class Meta:
        model = AITask
        fields = "__all__"

    def get_model_display(self, obj) -> str:
        return obj.model.display_name if obj.model else "(default)"

    def get_machines_detail(self, obj) -> list:
        from agents.models import Agent

        ids = [str((m or {}).get("agent_id") or "") for m in (obj.machines or [])]
        by_id = {
            a.agent_id: a
            for a in Agent.objects.select_related("site__client").filter(
                agent_id__in=ids
            )
        }
        out = []
        for m in obj.machines or []:
            aid = str((m or {}).get("agent_id") or "")
            a = by_id.get(aid)
            out.append(
                {
                    "agent_id": aid,
                    "role": (m or {}).get("role") or "",
                    "hostname": a.hostname if a else "",
                    "client": a.site.client.name if a else "",
                    "site": a.site.name if a else "",
                }
            )
        return out


class AITaskRunSerializer(serializers.ModelSerializer):
    source = serializers.CharField(read_only=True)
    source_name = serializers.CharField(read_only=True)
    hostname = serializers.SerializerMethodField()
    client = serializers.SerializerMethodField()
    site = serializers.SerializerMethodField()
    device_id = serializers.SerializerMethodField()

    class Meta:
        model = AITaskRun
        fields = "__all__"

    def get_hostname(self, obj) -> str:
        a = obj.get_agent()
        return a.hostname if a else ""

    def get_client(self, obj) -> str:
        a = obj.get_agent()
        return a.client.name if a else ""

    def get_site(self, obj) -> str:
        a = obj.get_agent()
        return a.site.name if a else ""

    def get_device_id(self, obj) -> str:
        a = obj.get_agent()
        return a.agent_id if a else ""


class BulkAICommandSerializer(serializers.ModelSerializer):
    model_display = serializers.SerializerMethodField()
    agent_ids = serializers.SerializerMethodField()
    target_summary = serializers.SerializerMethodField()

    class Meta:
        model = BulkAICommand
        fields = "__all__"

    def get_model_display(self, obj) -> str:
        return obj.model.display_name if obj.model else "(default)"

    def get_agent_ids(self, obj):
        if not obj.pk:
            return []
        return list(obj.agents.values_list("agent_id", flat=True))

    def get_target_summary(self, obj) -> str:
        agent_count = obj.agents.count() if obj.pk else 0
        if obj.target == "client" and obj.client:
            base = f"Client: {obj.client.name}"
        elif obj.target == "site" and obj.site:
            base = f"Site: {obj.site.name}"
        elif obj.target == "agents":
            base = f"{agent_count} selected agents"
        elif obj.target == "filter":
            groups = obj.filters or []
            n = len(groups)
            base = f"Filter ({n} group{'s' if n != 1 else ''})"
        else:
            base = "All agents"
        extra = []
        if obj.mon_type != "all":
            extra.append(obj.mon_type)
        if obj.os_type != "all":
            extra.append(obj.os_type)
        return base + (f" ({', '.join(extra)})" if extra else "")

class AIReportScheduleSerializer(serializers.ModelSerializer):
    cadence_display = serializers.SerializerMethodField()
    kind_display = serializers.SerializerMethodField()
    window_hours_effective = serializers.SerializerMethodField()

    class Meta:
        from core.models import AIReportSchedule

        model = AIReportSchedule
        fields = "__all__"

    def get_cadence_display(self, obj):
        return obj.get_cadence_display()

    def get_kind_display(self, obj):
        return obj.get_kind_display()

    def get_window_hours_effective(self, obj):
        return obj.effective_window_hours
