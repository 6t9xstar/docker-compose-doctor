# Contributing to ComposeDoctor

Thanks for helping! Bug reports with a minimal reproduction are the most valuable contribution.

## Development

```bash
git clone https://github.com/6t9xstar/docker-compose-doctor.git
cd docker-compose-doctor
npm ci
npm test
node bin/composedoctor.js --help
```

There is no build step: the source in `src/` is plain ES modules that run on Node.js 18.17 or newer.

## Adding or changing a rule

1. Add the rule id, severity and description to the `RULES` table.
2. Implement the check and return a clear `message` plus an actionable `fix`.
3. Add a failing and a passing case to the tests in `test/`.
4. Document the rule in the Rules table of `README.md`.

Rules should have a very low false-positive rate. If a check is a heuristic, use `warning` or `info`, never `error`.

## Pull requests

- Keep each pull request focused on one change.
- Run `npm test` on your machine; CI runs the suite on Linux, macOS and Windows.
- Add an entry to `CHANGELOG.md` under "Unreleased".
