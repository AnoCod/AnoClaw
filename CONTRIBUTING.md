# Contributing to AnoClaw

Thank you for helping improve AnoClaw. This is a public repository, so every contribution must be reviewable, reproducible, and free of private data.

The complete project policy is in [docs/github-development-workflow.md](docs/github-development-workflow.md). AI coding assistants must also follow [AGENTS.md](AGENTS.md).

## Before You Start

- Search existing Issues and pull requests before opening a duplicate.
- Use an Issue for features, bugs, refactors, migrations, and other non-trivial work. Include context, scope, acceptance criteria, risk, and expected validation.
- Do not report vulnerabilities, exposed credentials, or private user data in a public Issue. Follow [SECURITY.md](SECURITY.md).
- Agree on scope before investing in a large or breaking change.

## Development Workflow

1. Fetch the intended base and create one short-lived branch for one logical change. Do not work directly on `main`.
2. Use `feat/`, `fix/`, `docs/`, `refactor/`, `test/`, `chore/`, or `hotfix/`, followed by an optional Issue number and a short lowercase slug.
3. Install with `npm install`; this repository uses `package-lock.json` and npm rather than pnpm.
4. Make the smallest coherent change and add or update tests and documentation with it.
5. Run the scope-appropriate checks. Cross-layer changes normally require `npm test` and `npm run build:all`; Windows packaging or release changes also require an installed-app smoke test.
6. Commit intentional files only, using an imperative Conventional Commit subject such as `fix(session): preserve restart history`.
7. Push the branch and open a pull request using the repository template.

## Pull Request Expectations

- Link the controlling Issue and explain the problem, solution, scope, verification, risk, and rollback.
- Include sanitized screenshots or recordings for visible UI changes.
- Review the complete diff against the target branch before requesting review.
- Never claim a check passed unless it was actually run and passed.
- Resolve required feedback and all review conversations before merge.
- Do not include secrets, local configuration, user/session data, raw sensitive logs, build caches, or unrelated changes.

Normal changes use squash merge after required checks and review are complete. A maintainer decides when a PR is ready to merge and whether an exception is justified.
