from django.urls import path

from . import views

urlpatterns = [
    path("summary/", views.GetBackupSummary.as_view()),
    path("runs/", views.GetBackupRuns.as_view()),
    path("policies/", views.GetBackupPolicies.as_view()),
    path("storage/", views.GetBackupStorage.as_view()),
]
