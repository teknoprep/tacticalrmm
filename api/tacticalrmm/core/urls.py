from django.urls import path
from django.conf import settings

from . import odoo_ai, views

urlpatterns = [
    # Odoo `ai_pi_bridge` addon entry points. Shared-secret authenticated (see
    # core/odoo_ai.py); they mint a chat session and resolve model permissions.
    # They hold no Odoo credentials and cannot write to Odoo -- the addon does
    # all Odoo work itself, as the logged-in Odoo user.
    path("ai/odoo/health/", odoo_ai.health),
    path("ai/odoo/identity/", odoo_ai.identity),
    path("ai/odoo/session/", odoo_ai.session),
    # Unauthenticated, secret-free: origins + ws base for the embedded chat UI,
    # so the ERP hostname is never hardcoded in the static page.
    path("ai/odoo/ui-config/", odoo_ai.ui_config),
    path("ai/odoo/brand/", odoo_ai.brand),
    path("ai/odoo/decision/", odoo_ai.decision),
    path("ai/odoo/work/", odoo_ai.work),
    path("settings/", views.GetEditCoreSettings.as_view()),
    path("version/", views.version),
    path("emailtest/", views.email_test),
    path("dashinfo/", views.dashboard_info),
    path("servermaintenance/", views.server_maintenance),
    path("customfields/", views.GetAddCustomFields.as_view()),
    path("customfields/<int:pk>/", views.GetUpdateDeleteCustomFields.as_view()),
    path("codesign/", views.CodeSign.as_view()),
    path("keystore/", views.GetAddKeyStore.as_view()),
    path("keystore/<int:pk>/", views.UpdateDeleteKeyStore.as_view()),
    path("urlaction/", views.GetAddURLAction.as_view()),
    path("urlaction/<int:pk>/", views.UpdateDeleteURLAction.as_view()),
    path("schedules/", views.GetAddSchedule.as_view()),
    path("schedules/<int:pk>/", views.UpdateDeleteSchedule.as_view()),
    path("urlaction/run/", views.RunURLAction.as_view()),
    path("urlaction/run/test/", views.RunTestURLAction.as_view()),
    path("smstest/", views.TwilioSMSTest.as_view()),
    path("clearcache/", views.clear_cache),
    path("openai/generate/", views.OpenAICodeCompletion.as_view()),
    # Pi.dev AI providers & models
    path("ai/providers/", views.GetAddAIProvider.as_view()),
    path("ai/providers/<int:pk>/", views.UpdateDeleteAIProvider.as_view()),
    path("ai/available-models/", views.AIAvailableModels.as_view()),
    path("ai/model-catalog/refresh/", views.AIModelCatalogRefresh.as_view()),
    path("ai/runtime/status/", views.AIRuntimeStatus.as_view()),
    path("ai/daily-report/send/", views.AIDailyReportSendNow.as_view()),
    path("ai/tech-productivity/send/", views.AITechProductivitySendNow.as_view()),
    path("ai/runtime/update/", views.AIRuntimeUpdateNow.as_view()),
    path("ai/helpdesk-assist/", views.HelpdeskAssist.as_view()),
    path("ai/prompt-assist/", views.AIPromptAssist.as_view()),
    path("ai/models/", views.GetAddAIModel.as_view()),
    path("ai/models/<int:pk>/", views.UpdateDeleteAIModel.as_view()),
    path("ai/agent-groups/", views.GetAddAIAgentGroup.as_view()),
    path("ai/agent-groups/seed/", views.SeedAIAgentGroups.as_view()),
    path("ai/agent-groups/<int:pk>/", views.UpdateDeleteAIAgentGroup.as_view()),
    path("ai/tasks/", views.GetAddAITask.as_view()),
    path("ai/tasks/<int:pk>/", views.UpdateDeleteAITask.as_view()),
    path("ai/tasks/<int:pk>/run/", views.RunAITaskNow.as_view()),
    path("ai/email/", views.AISendEmail.as_view()),
    path("ai/device-note/", views.AIDeviceNote.as_view()),
    path("ai/resolve-devices/", views.AIResolveDevices.as_view()),
    path("ai/schedule-action/", views.AIScheduleAction.as_view()),
    path("ai/schedule-action/<int:pk>/", views.AIScheduleAction.as_view()),
    path("ai/decision/<str:token>/session/", views.AIDecisionSession.as_view()),
    path("ai/ticket-console/", views.AITicketConsole.as_view()),
    path("ai/ticket-console/<path:ticket_ref>/", views.AITicketConsoleItem.as_view()),
    path("ai/action-credit/", views.AIActionCreditView.as_view()),
    path("ai/work-entry/", views.AIWorkEntryView.as_view()),
    path("ai/spend-entry/", views.AISpendEntryView.as_view()),
    path("ai/spend-report/", views.AISpendReport.as_view()),
    path("ai/report-schedules/", views.AIReportSchedules.as_view()),
    path("ai/report-schedules/<int:pk>/", views.AIReportScheduleDetail.as_view()),
    path("ai/procedures/", views.AIProcedures.as_view()),
    path("ai/helpdesk-caps/", views.AIHelpdeskCaps.as_view()),
    path("ai/verifiers/lint/", views.AIVerifierLint.as_view()),
    path("ai/verifiers/test/", views.AIVerifierTest.as_view()),
    path("ai/procedures/mine-now/", views.AIProceduresMineNow.as_view()),
    path("ai/procedures/mining-status/", views.AIProceduresMiningStatus.as_view()),
    path("ai/procedures/mining-stop/", views.AIProceduresMiningStop.as_view()),
    path("ai/procedures/<int:pk>/", views.AIProcedureDetail.as_view()),
    path("ai/runs/", views.AITaskRuns.as_view()),
    path("ai/history-scope/", views.AIHistoryScope.as_view()),
    path("ai/runs/<str:run_id>/live/", views.AITaskRunLive.as_view()),
    path("ai/bulk/", views.GetAddBulkAICommand.as_view()),
    path("ai/bulk/<int:pk>/", views.UpdateDeleteBulkAICommand.as_view()),
    path("ai/bulk/<int:pk>/run/", views.RunBulkAICommandNow.as_view()),
    path("ai/bulk/<int:pk>/results/", views.BulkAICommandResults.as_view()),
    path("ai/bulk/<int:pk>/stop/", views.StopBulkAICommand.as_view()),
    path("ai/stop-all/", views.StopAllAIRuns.as_view()),
    path("ai/bulk/preview/", views.PreviewBulkAITargets.as_view()),
    path("webtermperms/", views.webterm_perms),
]

if not getattr(settings, "DEMO", False):
    urlpatterns += (
        path("status/", views.status),  # TODO deprecated
        path("v2/status/", views.status_v2),
    )


if not (
    getattr(settings, "HOSTED", False)
    or getattr(settings, "TRMM_DISABLE_SERVER_SCRIPTS", False)
    or getattr(settings, "DEMO", False)
):
    urlpatterns += (path("serverscript/test/", views.TestRunServerScript.as_view()),)
