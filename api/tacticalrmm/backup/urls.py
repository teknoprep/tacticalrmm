from django.urls import path

from . import views

urlpatterns = [
    path("summary/", views.GetBackupSummary.as_view()),
    path("runs/", views.GetRunBackupRuns.as_view()),
    path("runs/<int:pk>/log/", views.GetRunLog.as_view()),
    # "policies" in the API, "Jobs" in the UI
    path("policies/", views.GetAddJobs.as_view()),
    path("policies/<int:pk>/", views.GetUpdateDeleteJob.as_view()),
    # "storage" in the API, "Locations" in the UI
    path("storage/", views.GetAddStorage.as_view()),
    path("storage/<int:pk>/", views.GetUpdateDeleteStorage.as_view()),
    path("hosts/", views.GetBackupHosts.as_view()),
    path("report/", views.GetBackupReport.as_view()),
    path("notify/", views.GetAddNotify.as_view()),
    path("notify/<int:pk>/", views.GetUpdateDeleteNotify.as_view()),
    path("notify/<int:pk>/send/", views.SendNotify.as_view()),
    path("hosts/<str:agent_id>/", views.UpdateBackupHost.as_view()),
    # called by the runner on the agent, authenticated by the run's one-time token
    path("agent/job/", views.AgentJob.as_view()),
    path("agent/report/", views.AgentReport.as_view()),
]
