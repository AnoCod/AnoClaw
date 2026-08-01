# Security Policy

## Reporting a Vulnerability

Do not open a public Issue or pull request for a suspected vulnerability, exposed credential, or report containing private user data.

Use the repository's [Security page](https://github.com/AnoCod/AnoClaw/security) and its private vulnerability reporting option when available. If private reporting is unavailable, contact repository owner `@AnoCod` through a private channel before sending technical details. The first contact should contain only enough information to arrange a secure disclosure path.

Include the affected version or commit, impact, prerequisites, minimal reproduction, and any suggested mitigation. Remove real credentials, private prompts, session data, and other user information from all evidence.

## Handling Exposed Secrets

If a credential may have been exposed, revoke or rotate it immediately before attempting repository cleanup. Deleting a file, comment, artifact, Issue, or Git commit does not make an already disclosed secret safe again.

## Supported Code

Security fixes target the current `main` branch and the latest published release. Reports affecting older versions are assessed case by case; include the exact version so maintainers can evaluate impact and backport feasibility.
