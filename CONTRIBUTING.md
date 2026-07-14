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

- Open a PR into `main`. The **`ci-gate`** check — the full OS/Node test matrix,
  package verification, and the dogfood run — must pass before a PR can merge.

## Local verification

Run these before pushing (they mirror CI):

```bash
npm ci
npm run typecheck
npm run build
npm test
npm run verify-pack   # when packaging or the files list could change
npm run dogfood       # when touching hooks, state, reporting, or the CLI
```

Please don't commit secrets or generated state (`.env`, `.techybara/`, build
output in `dist/`, or `*.tgz` tarballs).

## Dogfooding

TechyBara's real failure modes — a false "verified", a missed protected path, a
noisy banner — are not the kind of thing a unit test notices. They show up when
you use it. So we use it on itself.

### `npm run dogfood`

The automated harness. It packs the real tarball, installs it into a throwaway
git repo, drives it with genuine Claude Code lifecycle payloads, and asserts the
Trust Receipt behavior end to end — then cleans up, even on failure.

It deliberately exercises **the packaged CLI**, never `src/`. A green unit suite
proves the modules work; only this proves that what `npm install techybara`
actually delivers works.

### Using TechyBara while developing TechyBara (opt-in)

Dogfooding is **opt-in**, and `.claude/` is gitignored. That is a deliberate
choice, made from measurement rather than taste: TechyBara's hooks run
`dist/cli.js`, `dist/` is built rather than committed, so a committed
`settings.json` would crash on **every turn** in a fresh clone until someone ran
a build. Nobody should have to debug our tooling to read our code.

To turn it on:

```bash
npm run dogfood:init:dry    # show exactly what would change, write nothing
npm run dogfood:init        # build, then register the hooks locally
npm run dogfood:status      # is it installed and can it run here?
npm run dogfood:uninstall   # remove TechyBara's hooks, keep everything else
```

`dogfood:init` builds first, then runs the real `init` — the same additive,
idempotent code path users get. It writes an absolute path into your local
`.claude/settings.json`, which is gitignored precisely because that path is
yours alone. Re-run it after moving the repo. Your unrelated hooks are
preserved; that is tested, not hoped for.

Whichever way you install, remember to **rebuild after changing `src/`** — the
hooks run the compiled output, so a stale `dist/` reports stale results.

### The maintainer loop

1. `npm run build` — the hooks run the compiled CLI, so a stale `dist/` reports
   stale results.
2. Do real work in Claude Code on this repo.
3. Read the banner after each turn; run `techybara report` when you want detail,
   or `techybara report --json` to inspect the machine-readable view.
4. Ask the questions a user would ask:
   - Did it report something that did not change? (false positive)
   - Did it miss something that did? (false negative)
   - Did it claim verification that never happened? **This is the worst one.**
   - Was the banner noisy, confusing, or noticeably slow?
5. File anything you find as an issue labelled `dogfood`, with the banner text
   and what you expected instead. **Never paste secrets** — if a protected path
   misbehaved, say `.env` and describe the shape of the problem.

A dogfood issue is a real bug report. TechyBara's whole promise is that silence
means "checked, nothing differs" — anything that erodes that is a priority.

## Reporting security-sensitive findings

If you find a vulnerability or a way TechyBara could leak sensitive data, please
**do not open a public issue with the details**, and never paste secrets, `.env`
contents, keys, or tokens anywhere public. Instead, open a minimal issue asking
for a private contact, or reach the maintainer through their GitHub profile, and
share the specifics privately. Describe the impact without including the
sensitive material itself.
