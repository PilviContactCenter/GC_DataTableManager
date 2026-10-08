# Embedded Data Table Manager

This is the Docker web version of Data Table Manager. It is a static browser
application that calls the Genesys Cloud API with the signed-in user's OAuth
token. There is no application database or client secret. The original Flask
application remains in the repository for local use.

## Genesys Cloud setup

1. Create two Genesys Cloud groups, for example **Data Table Admin** and
   **Data Table User**. Add the intended users. A user in both groups gets the
   Admin interface.
2. Assign Genesys roles to the groups so the API can enforce access:

   | Group | Suggested Architect permissions |
   | --- | --- |
   | Data Table User | Datatable View; Datatable Row View and Edit |
   | Data Table Admin | Datatable View; Datatable Row View, Add, Edit, and Delete |

   Grant these permissions for the divisions containing the tables. The app
   checks group membership for its interface; Genesys Cloud checks API
   permissions for every request. Group membership alone does not grant API
   access. Client Application visibility can also be limited to these groups.
3. Create an OAuth client using **Code Authorization with PKCE**. Add
   `https://<your-domain>/auth-popup.html` as an authorized redirect URI. For
   local testing, also add `http://127.0.0.1:8080/auth-popup.html`. Use its
   public client ID; do not put a client secret in this application.
4. Create a **Client Application** integration in Genesys Cloud. Set its URL
   to `https://<your-domain>/`, select the two groups for visibility, and
   include `allow-popups` in its iframe sandbox options so the OAuth login
   window can open. If custom sandbox options are required, also allow the
   app's scripts and same-origin access.

Genesys documentation: [OAuth clients](https://help.genesys.cloud/articles/create-an-oauth-client/),
[Client Applications](https://help.genesys.cloud/articles/about-custom-client-application-integrations/),
[group role assignments](https://help.genesys.cloud/articles/assign-roles-to-a-group/).

## Docker configuration

Copy `.env.example` to `.env`, then set the OAuth client ID, region key, the
two group IDs, and your public domain. These IDs are configuration values,
not secrets. The Docker container generates `config.js` from them at startup.

For a local preview:

```bash
docker compose up -d --build
```

Open `http://127.0.0.1:8080/` and use a matching local OAuth redirect URI.

For a public HTTPS deployment, point the domain's DNS at your Docker server,
open ports 80 and 443, then run:

```bash
docker compose -f compose.yaml -f compose.public.yaml up -d --build
```

Caddy serves the public HTTPS URL. The web container remains bound to
`127.0.0.1:8080` on the Docker host. The app stores no table data locally;
all reads and changes go to Genesys Cloud. A Docker host, domain, and Genesys
Cloud configuration are needed before it can have a live URL.

## What the web app does

- Lists accessible tables and loads their rows, including multi-page results.
- Searches tables and rows in the browser.
- Lets User group members edit rows.
- Lets Admin group members add, edit, delete, and export rows as JSON.

The original Flask app's local column permissions, audit log, and rollback
features are not part of this database-free version. Use Genesys permissions
and audit facilities for production governance.
