"""The `/api` routes that work without a session; every other one needs `get_current_user` or
`get_current_session` (tests/test_architecture.py, ADR-0004).

Only routes that exist: a ticket that adds an open route (password reset, invitations, join-code
lookup, signup) adds its entry here, and the fitness test fails on an entry with no route.
"""

AUTH_ALLOWLIST: frozenset[tuple[str, str]] = frozenset(
    {
        ("GET", "/api/health"),
        ("GET", "/api/ready"),
        ("GET", "/api/version"),
        ("POST", "/api/auth/login"),
        # Always 204: it revokes the session the cookie names, if any.
        ("POST", "/api/auth/logout"),
        # The invitee has no session yet (P4-02b); the token in the path is the credential.
        ("GET", "/api/invitations/{token}"),
        ("POST", "/api/invitations/{token}/accept"),
    }
)
