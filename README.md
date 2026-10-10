# Genesys Cloud Data Table Manager

Data Table Manager is a Docker-hosted web app for Genesys Cloud Data Tables. It
runs as a Genesys Cloud Client Application and uses Genesys sign-in with OAuth
Authorization Code and PKCE. The browser calls the Genesys Cloud API directly;
the app has no SQL database or OAuth client secret.

The live instance is [datatablemanager.pilvi.pl](https://datatablemanager.pilvi.pl/).
Access is limited to members of the configured Data Table Admin and Data Table
User groups.

## Features

- Browse and search accessible Data Tables and their rows.
- Edit rows with field validation as a Data Table User.
- Add, edit, delete, and export rows as a Data Table Admin.
- Inspect recent row and table changes from Genesys Cloud audit events as an Admin.
- Use Genesys Cloud roles and divisions to enforce API permissions.

## Run with Docker

Copy `.env.example` to `.env` and set the public OAuth client ID, Genesys
region, group IDs, and hostname. The `.env` file is ignored by Git.

For a local preview:

```bash
docker compose up -d --build
```

For a host with Traefik:

```bash
docker compose -f compose.yaml -f compose.traefik.yaml up -d --build
```

See [WEB_APP.md](WEB_APP.md) for Genesys Cloud setup, OAuth redirect URIs, and
public HTTPS deployment.
