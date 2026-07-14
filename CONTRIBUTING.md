# Contributing to TechyBara

Thanks for your interest. TechyBara is a small, deliberately narrow v0.1
experiment — focused changes that keep it observe-and-report are the most
welcome.

## Workflow

- `main` is protected: **no direct pushes**. All changes land through a pull
  request.
- Branch from the latest `main` and keep branches **short-lived and focused**:

  ```bash
  git switch main
  git pull --ff-only
  git switch -c type/short-description   # e.g. fix/… , docs/… , ci/…
  ```

- Open a PR into `main`. The **`ci-gate`** check — the full OS/Node test matrix
  plus package verification — must pass before a PR can merge.

## Local verification

Run these before pushing (they mirror CI):

```bash
npm ci
npm run typecheck
npm run build
npm test
node scripts/verify-pack.mjs   # when packaging or the files list could change
```

Please don't commit secrets or generated state (`.env`, `.techybara/`, build
output in `dist/`, or `*.tgz` tarballs).

## Reporting security-sensitive findings

If you find a vulnerability or a way TechyBara could leak sensitive data, please
**do not open a public issue with the details**, and never paste secrets, `.env`
contents, keys, or tokens anywhere public. Instead, open a minimal issue asking
for a private contact, or reach the maintainer through their GitHub profile, and
share the specifics privately. Describe the impact without including the
sensitive material itself.
