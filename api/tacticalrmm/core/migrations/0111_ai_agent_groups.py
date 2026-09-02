from django.db import migrations, models
import django.db.models.deletion


def seed_groups(apps, schema_editor):
    # Import the live helper so the recommended rosters live in one place.
    try:
        from core.agent_groups import seed_builtin_groups
        seed_builtin_groups(reset_members=True)
    except Exception:
        # A fresh migrate of an empty DB may not have providers yet. Seeding
        # is also available from the settings UI ("Create Coding & IT groups").
        pass


def unseed_groups(apps, schema_editor):
    AIAgentGroup = apps.get_model("core", "AIAgentGroup")
    AIAgentGroup.objects.filter(slug__in=("coding", "it")).delete()


class Migration(migrations.Migration):

    dependencies = [
        ("core", "0110_ai_remote_relay"),
    ]

    operations = [
        migrations.CreateModel(
            name="AIAgentGroup",
            fields=[
                ("id", models.AutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("created_by", models.CharField(blank=True, max_length=255, null=True)),
                ("created_time", models.DateTimeField(auto_now_add=True, null=True)),
                ("modified_by", models.CharField(blank=True, max_length=255, null=True)),
                ("modified_time", models.DateTimeField(auto_now=True, null=True)),
                ("name", models.CharField(max_length=80)),
                ("slug", models.SlugField(max_length=80, unique=True)),
                ("description", models.TextField(blank=True, default="")),
                (
                    "kind",
                    models.CharField(
                        choices=[
                            ("coding", "Coding"),
                            ("it", "IT / tickets"),
                            ("custom", "Custom"),
                        ],
                        default="custom",
                        max_length=20,
                    ),
                ),
                (
                    "workspace",
                    models.CharField(
                        blank=True,
                        default="",
                        help_text="Optional server-side path. When set, file/grep/coder subagents run there.",
                        max_length=500,
                    ),
                ),
                ("enabled", models.BooleanField(default=True)),
                ("is_default", models.BooleanField(default=False)),
            ],
            options={"ordering": ["name"]},
        ),
        migrations.CreateModel(
            name="AIAgentGroupMember",
            fields=[
                ("id", models.AutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("role", models.CharField(max_length=32)),
                ("provider", models.CharField(max_length=50)),
                ("model_id", models.CharField(max_length=255)),
                ("display_name", models.CharField(blank=True, default="", max_length=255)),
                ("thinking_level", models.CharField(blank=True, default="medium", max_length=20)),
                ("enabled", models.BooleanField(default=True)),
                (
                    "group",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="members",
                        to="core.aiagentgroup",
                    ),
                ),
            ],
            options={"ordering": ["id"], "unique_together": {("group", "role")}},
        ),
        migrations.RunPython(seed_groups, unseed_groups),
    ]
