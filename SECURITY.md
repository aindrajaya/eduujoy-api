# Security

## Reporting a vulnerability

Email **arista.indrajaya@gmail.com** with a description, the affected endpoint or file, and steps to
reproduce. Please do not open a public issue for a vulnerability.

Only the `main` branch and the production deployment at `https://api.eduujoy.aindrajaya.my.id` are
supported.

## Incident note: PolinRider supply-chain compromise (October 2026)

In October 2026 the maintainer's development workstation was compromised by the PolinRider
campaign, which injects an obfuscated JavaScript loader (a BeaverTail variant) into build
configuration files and pushes it with rewritten history. Some of the maintainer's public
repositories were affected and appear in OpenSourceMalware's public tracking of the campaign.

**This repository was not affected.** It was created on 21 October 2026, and its full history has
been scanned: no payload, no altered ignore rules, no VS Code task files and no batch scripts in
any commit.

### What was done

- The affected workstation was wiped and reinstalled.
- GitHub credentials, cloud service keys and third-party API keys were rotated.
- Injected payloads were removed from the affected repositories. The front end,
  [aindrajaya/eduujoy-ui](https://github.com/aindrajaya/eduujoy-ui), was republished with a
  cleaned history; its own `SECURITY.md` has the details.

### What prevents a repeat

- **`polinrider-guard`** scans git objects for the campaign's indicators on every push and pull
  request, and weekly across all branches. It reads objects only and never runs repository code.
- **Branch rules on `main`**: signed commits only, no force-push, no deletion, and CI, CodeQL and
  the guard must pass before a merge.
- **Dependency hygiene**: installs use a frozen lockfile, and `pnpm audit` runs in CI.
- **Secrets stay out of git**: `.env*` files are ignored, and CI uses placeholder values except for
  one repository secret, the test database URL.

## Design notes relevant to security

- Sessions are HttpOnly cookies with refresh-token rotation; passwords are hashed with Argon2.
- State-changing requests are checked against an origin allow-list (`APP_ORIGIN`).
- Billing webhooks are verified by HMAC before any processing.
- Content from the web and from learners is wrapped as data before it reaches a model, and model
  output is schema-validated before use.
- AI spend is metered per call and capped by a daily budget.
