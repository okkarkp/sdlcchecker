---
paths:
  - "**/security/**"
  - "**/auth/**"
---

# Auth / session rules

For anything in these paths, follow the project's authentication and security-rules docs.

- Keep any public/citizen path (often via a BFF/middleware) and internal/officer path
  (often a direct API call) separate — don't cross the wires.
- Preserve the CSRF protection pattern on state-changing endpoints.
- Validate token/session expiry before proxying or acting on a request.
- Never log credentials, tokens, or secrets.
