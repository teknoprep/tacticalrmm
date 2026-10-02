from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("core", "0126_auto_summarize_tokens"),
    ]

    operations = [
        migrations.AddField(
            model_name="aispendentry",
            name="role",
            field=models.CharField(blank=True, db_index=True, default="", max_length=32),
        ),
    ]
