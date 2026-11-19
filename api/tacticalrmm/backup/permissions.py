from rest_framework import permissions

from tacticalrmm.permissions import _has_perm


class BackupPerms(permissions.BasePermission):
    """Read access follows site visibility for now.

    The dedicated `can_view_backups` / `can_manage_backups` / `can_restore_backups` Role flags are
    the next increment (docs/08 §8.2); until the field exists, gating on `can_list_sites` keeps the
    tab honest without inventing a permission that the Role form cannot show.
    """

    def has_permission(self, r, view) -> bool:
        if r.method in permissions.SAFE_METHODS:
            return _has_perm(r, "can_list_sites")
        return _has_perm(r, "can_manage_sites")
