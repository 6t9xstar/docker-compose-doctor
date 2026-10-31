# ComposeDoctor: Docker Compose validator and troubleshooting doctor

**Catch the problems that make `docker compose up` fail or start a broken stack: missing env vars, port conflicts, missing healthchecks, unverified `depends_on`, bad volumes, `latest` tags and typos.**

[![CI](https://github.com/6t9xstar/docker-compose-doctor/actions/workflows/ci.yml/badge.svg)](https://github.com/6t9xstar/docker-compose-doctor/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Node.js](https://img.shields.io/badge/node-%3E%3D18.17-brightgreen)

The containers start, but the API crashes because PostgreSQL isn't ready yet. `DATABASE_URL` silently became `postgres://app:@db`. Port 5432 is already taken by a local Postgres. A config file mount turned into an empty directory.
`docker compose config` only checks that the YAML is valid; **ComposeDoctor** checks that the stack will actually work.

```bash
npx github:6t9xstar/docker-compose-doctor
```

## Example

```text
COMPOSE DOCTOR
compose.yaml · 4 services

[ERROR]   service "db" DB_PASSWORD is required but not set: DB_PASSWORD must be set. "docker compose up" will fail.
          CD010 compose.yaml:26  Fix: add DB_PASSWORD=... to .env
[WARNING] service "api" DB_PASSWORD is unresolved and defaults to an empty string.
[WARNING] service "api" Startup dependency on "db" is not verified: Compose only waits for the container
          to start, not for postgres to accept connections.
          CD032 compose.yaml:13  Fix: depends_on: { db: { condition: service_healthy } } with a healthcheck on "db"
[ERROR]   service "api" depends_on "cache", which is not a service in this project.
[WARNING] service "api" Bind mount source "./config/app.yml" does not exist. Docker will create an empty
          directory there, so a file you meant to mount shows up as a directory.
[WARNING] service "db" postgres healthcheck missing; dependants cannot wait for it to be ready.
[ERROR]   service "db" Unknown service key "enviroment".  Fix: did you mean "environment"?
[ERROR]   service "worker" Waits for "db" to be healthy, but "db" has no healthcheck; Compose will fail to start the stack.
[ERROR]   service "worker" Host port 8080/tcp is also published by service "api".
[ERROR]   service "db" Port 5432 already occupied on this machine.

22 findings detected (9 errors, 8 warnings, 5 info).
```

Abridged output for [`fixtures/broken/compose.yaml`](fixtures/broken/compose.yaml) on a machine where port 5432 is already in use.

## Fix preview: healthchecks generated for you

`--fix-preview` writes a `compose.override.yaml` that adds working healthchecks for 25+ official images (PostgreSQL, MySQL, MariaDB, Redis, Valkey, MongoDB, RabbitMQ, Elasticsearch, OpenSearch, MinIO, ClickHouse and more) and switches dependants to `condition: service_healthy`:

```yaml
services:
  db:
    healthcheck:
      test: [CMD-SHELL, 'pg_isready -U "$${POSTGRES_USER:-postgres}" -d "$${POSTGRES_DB:-postgres}"']
      interval: 5s
      timeout: 5s
      retries: 10
      start_period: 10s
  redis:
    healthcheck:
      test: [CMD, redis-cli, ping]
      interval: 5s
      timeout: 5s
      retries: 10
      start_period: 10s
  api:
    depends_on:
      db:
        condition: service_healthy
      redis:
        condition: service_healthy
```

Docker Compose merges `compose.override.yaml` automatically, so `composedoctor --write-override compose.override.yaml` fixes startup ordering without editing your main file.

## What it checks

- **Variables**: `${VAR}`, `$VAR`, `${VAR:-default}`, `${VAR:?error}`, `$$` escapes, resolved against your shell and `.env` exactly like Compose does. `--ignore-shell-env` simulates a clean CI runner.
- **Startup order**: `depends_on` targets that don't exist, dependency cycles, databases without healthchecks, `service_healthy` without a healthcheck.
- **Ports**: duplicate host ports across services, ports already in use on your machine (including Windows/WSL excluded port ranges), databases published on `0.0.0.0`, unquoted `HOST:CONTAINER` mappings.
- **Files**: missing `env_file`, build contexts, Dockerfiles, bind-mount sources, secret and config files.
- **References**: undeclared named volumes, networks, secrets and configs.
- **Hygiene**: `latest` and untagged images, unknown keys with "did you mean" suggestions, the obsolete `version:` key, invalid `restart` policies, duplicate `container_name`, `container_name` with replicas, legacy `links`.
- Works with `compose.yaml`, `docker-compose.yml`, overrides and multiple `-f` files, with line numbers for every finding.

**No Docker required.** ComposeDoctor reads your files directly, so it also runs in CI jobs without a Docker daemon.

## Install

**Requirements**

- Node.js 18.17 or newer
- git (to install straight from GitHub)
- Windows, macOS or Linux
- Docker is **not** required: ComposeDoctor reads your files directly.

```bash
# run once without installing
npx github:6t9xstar/docker-compose-doctor

# or install the composedoctor command globally
npm install -g github:6t9xstar/docker-compose-doctor
```

## Usage

```bash
composedoctor                                  # finds compose.yaml / docker-compose.yml (+ override)
composedoctor -f compose.yaml -f compose.prod.yaml
composedoctor --project-directory ./deploy
composedoctor --env-file .env.ci --ignore-shell-env
composedoctor --fix-preview                    # print suggested fixes
composedoctor --write-override compose.override.yaml
composedoctor rules                            # list all rules
```

| Option | Description |
| --- | --- |
| `-f, --file <path>` | Compose file (repeatable, like `docker compose -f`) |
| `--project-directory <dir>` | Where to look for compose files and `.env` |
| `--env-file <path>` | Env file for interpolation (repeatable; default `.env`) |
| `--ignore-shell-env` | Only use env files, like a clean CI runner |
| `--no-port-check` | Don't probe local ports |
| `--fix-preview` / `--write-override <file>` | Print or write a fix override file |
| `--format` | `text`, `json`, `sarif`, `markdown`, `github` |
| `-o, --output <file>` | Write the report to a file |
| `--fail-on <level>` | `error` (default), `warning`, `info`, `none` |
| `--ignore <ids>` | Skip rules, e.g. `--ignore CD003,CD042` |

Exit codes: `0` ok, `1` findings at or above `--fail-on`, `2` usage error.

## GitHub Action

```yaml
name: Compose
on: [pull_request]
jobs:
  composedoctor:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: 6t9xstar/docker-compose-doctor@v1
        with:
          project-directory: .
          env-file: .env.example   # optional
          fail-on: error
```

## Rules

| Rule | Severity | Description |
| --- | --- | --- |
| CD001 | error | Invalid YAML (with line number) |
| CD002 | error | No services defined |
| CD003 | info | Obsolete top-level `version` |
| CD004 | error | Unknown top-level key |
| CD005 | error | Unknown service key (typo), with suggestion |
| CD010 | warning / error | Unresolved `${VARIABLE}` (error for `${VAR:?}`) |
| CD011 | error | `env_file` does not exist |
| CD012 | info | Pass-through env var not set in the shell |
| CD020 | warning | Image uses `latest` or no tag |
| CD021 | error | Service has neither `image` nor `build` |
| CD022 | error | Build context or Dockerfile missing |
| CD030 | error | `depends_on` an unknown service |
| CD031 | error | Dependency cycle |
| CD032 | warning | Depends on a database/broker without `condition: service_healthy` |
| CD033 | error | `service_healthy` used but the dependency has no healthcheck |
| CD034 | warning | Database/broker service without a healthcheck |
| CD040 | error | Two services publish the same host port |
| CD041 | error | Host port already in use / reserved on this machine |
| CD042 | info / warning | Unquoted port mapping (YAML base-60 trap below port 60) |
| CD043 | info | Database port published on all interfaces |
| CD050 | warning | Bind-mount source does not exist |
| CD051 | error | Named volume not declared |
| CD052 | error | Network not declared |
| CD053 | error | Secret/config undeclared or file missing |
| CD060 | error | Duplicate `container_name` |
| CD061 | error | Invalid `restart` policy |
| CD062 | error | `container_name` with more than one replica |
| CD070 | info | Legacy `links` |

## FAQ

### How do I make Docker Compose wait until PostgreSQL is ready?

Add a `healthcheck` to the database service and use `depends_on` with `condition: service_healthy`. Plain `depends_on` only waits for the container to *start*. `composedoctor --fix-preview` generates both for you.

### How do I validate a docker-compose.yml file?

`docker compose config` validates syntax and the schema. ComposeDoctor also checks the things that fail at runtime: unset variables, missing files, port conflicts, readiness and references. Run both in CI.

### Why is my bind mount an empty directory?

When the host path of a short-syntax bind mount doesn't exist, Docker creates it as an empty directory. ComposeDoctor reports missing bind-mount sources (CD050).

### Why does Docker say "port is already allocated"?

Another container or local process is using that host port. ComposeDoctor checks every published port before you start (CD041); use `--no-port-check` in CI.

## More developer tools

- [ScriptPort](https://github.com/6t9xstar/npm-scripts-cross-platform-checker): cross-platform npm scripts checker
- [ComposeDoctor](https://github.com/6t9xstar/docker-compose-doctor): Docker Compose validator and troubleshooter
- [CachePilot](https://github.com/6t9xstar/github-actions-cache-optimizer): GitHub Actions cache analyzer and optimizer
- [DevContainer Doctor](https://github.com/6t9xstar/devcontainer-json-validator): devcontainer.json validator
- [OwnerScope](https://github.com/6t9xstar/codeowners-coverage-checker): CODEOWNERS validator and coverage checker

## License

[MIT](LICENSE)
