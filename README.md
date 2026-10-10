# Genesys Cloud Data Table Manager

Data Table Manager is a Docker-hosted web app for Genesys Cloud Data Tables. It
runs as a Genesys Cloud Client Application and uses Genesys sign-in with OAuth
Authorization Code and PKCE. The browser calls the Genesys Cloud API directly
for table data. A small Node service stores shared column permission settings
and verifies access with Genesys Cloud; the app has no SQL database or OAuth
client secret.

The live instance is [datatablemanager.pilvi.pl](https://datatablemanager.pilvi.pl/).
Access is limited to members of the configured Data Table Admin and Data Table
User groups.

## Features

- Browse and search accessible Data Tables and their rows.
- Let Admins choose which columns Data Table Users can edit for each table.
- Edit selected columns with field validation as a Data Table User; tables are
  read-only for Users until an Admin saves their column permissions.
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

Column permissions apply inside this app. Genesys API permissions still govern
changes made through other apps or direct API requests. Settings are shared
between users and survive container replacement in the
`datatablemanager-web-column-access` Docker volume. Run one policy service
instance. See [backup and restore](WEB_APP.md#back-up-and-restore-column-permissions)
before removing or moving a deployment.
