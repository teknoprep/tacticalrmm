"""Encryption for destination secrets and repo passwords at rest.

Fernet with a key derived from SECRET_KEY. Consequence worth knowing: rotating SECRET_KEY makes
every stored destination secret and repo password undecryptable — re-enter destination secrets
and treat repo passwords as lost unless they were escrowed. That is why repo passwords are also
meant to be exported to the IT Notebook (docs/04 §4.8).
"""

import base64
import hashlib

from cryptography.fernet import Fernet, InvalidToken
from django.conf import settings


def _fernet() -> Fernet:
    key = hashlib.sha256(("rmm-backup:v1:" + settings.SECRET_KEY).encode()).digest()
    return Fernet(base64.urlsafe_b64encode(key))


def encrypt(value: str) -> str:
    if not value:
        return ""
    return _fernet().encrypt(value.encode()).decode()


def decrypt(token: str) -> str:
    if not token:
        return ""
    try:
        return _fernet().decrypt(token.encode()).decode()
    except InvalidToken:
        return ""
