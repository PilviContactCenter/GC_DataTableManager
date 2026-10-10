# Embedded Data Table Manager

This is the Docker web version of Data Table Manager. The browser calls the
Genesys Cloud API for table data with the signed-in user's OAuth token. A
small Node 24 service stores shared column permission settings as JSON and
verifies each caller's Genesys identity, groups, and table access. There is no
SQL database, local user account, or client secret.

## Genesys Cloud setup

1. Create two Genesys Cloud groups, for example **Data Table Admin** and
   **Data Table User**. Add the intended users. A user in both groups gets the
   Admin interface.
2. Assign Genesys roles to the groups so the API can enforce access:

   | Group | Suggested Architect permissions |
   | --- | --- |
   | Data Table User | Datatable View; Datatable Row View and Edit |
   | Data Table Admin | Datatable View; Datatable Row View, Add, Edit, and Delete; Audits Audit View |

   Grant these permissions for the divisions containing the tables. The app
   checks group membership for its interface; Genesys Cloud checks API
   permissions for every request. Group membership alone does not grant API
   access. Client Application visibility can also be limited to these groups.
3. Create an OAuth client using **Code Authorization with PKCE**. Add
   `https://<your-domain>/auth-popup.html` as an authorized redirect URI. For
   local testing, also add `http://127.0.0.1:8080/auth-popup.html`. Use its
   public client ID; do not put a client secret in this application. Include
   the `audits:readonly` OAuth scope for the Admin change history view.
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
not secrets. The web container generates `config.js` from them at startup.
Compose also starts an internal `policy` service, with no published host port,
and a storage health check. The web service starts independently so Admins
can use table operations while the policy service is unavailable. Nginx
forwards `/api/` requests, including the user's bearer token, to that service
and reconnects when its container is recreated. During a policy outage,
User editing is blocked and saving column selections is unavailable.

For a local preview:

```bash
docker compose up -d --build
```

Open `http://127.0.0.1:8080/` and use a matching local OAuth redirect URI.

For a public HTTPS deployment with Traefik, point the domain's DNS at your
Docker server. The Traefik instance must have a `traefik_default` network and
serve ports 80 and 443. Then run:

```bash
docker compose -f compose.yaml -f compose.traefik.yaml up -d --build
```

This overlay uses the existing `websecure` entrypoint and `letsencrypt`
certificate resolver. Change those label values if your Traefik instance uses
other names. The web container also remains bound to `127.0.0.1:8080` on the
Docker host. All table reads and changes go to Genesys Cloud. The policy service
stores only table IDs, editable column names, revision numbers, and schema
fingerprints; it does not persist row values, OAuth tokens, or audit history.

The Compose project is named `datatablemanager-web` and uses the named volume
`datatablemanager-web-column-access` for `/data/column-access.json`. This name
stays the same when deployments run from different release directories.
`docker compose up -d --build`, service restarts, and `docker compose down`
preserve the settings. Run exactly one policy service instance; its JSON store
does not coordinate writes between replicas. Removing the named volume,
including with `docker compose down -v`, deletes the saved settings.

## Column permissions

Admins open **User editable columns** for the selected table, select the
columns Users may edit, and save the shared settings. A table without saved
settings is read-only for Users.
Admins can still add, edit, delete, and export rows using their Genesys
permissions. The row key cannot be selected as an editable column.

The policy API checks the signed-in user's Genesys groups and the current table
schema. Only an Admin can save settings; both groups can read them. Changes use
revisions so an older Admin draft cannot overwrite a newer saved selection.
The app reloads permissions before the final row conflict check when saving
a User row edit. These separate policy and Genesys row requests are not
atomic: a permission change after the policy check can still race the row
write. If settings
cannot be loaded, User editing is blocked. If the table schema changes, an
Admin must review **User editable columns** and save again to confirm the
selection. A changed permission revision or schema during an edit keeps the
User's draft and requires refreshing before another save attempt.

These restrictions apply inside Data Table Manager. Users retain the Genesys
API permissions assigned to their roles, including access through other apps
or direct API calls. This app does not provide column authorization for the
Genesys Cloud API itself.

## Back up and restore column permissions

After an Admin has saved settings, back up the JSON metadata from the running
service. Store this file with your deployment backups; it contains no table
rows or login credentials.

```bash
docker compose exec -T policy node -e 'process.stdout.write(require("node:fs").readFileSync(process.env.POLICY_PATH))' > column-access-backup.json
```

To restore a previous backup on the same host or a new host configured with
the same Genesys organization and groups, stop both services and write it to
the policy volume as the service user. Startup validates the JSON format and
fails if it is corrupt. Check service health after restarting.

```bash
docker compose stop web policy
docker compose run --rm --no-deps -T --entrypoint node policy -e 'require("node:fs").writeFileSync(process.env.POLICY_PATH, require("node:fs").readFileSync(0), {mode: 0o600})' < column-access-backup.json
docker compose up -d
docker compose ps
```

For deployments using Traefik, include `-f compose.yaml -f compose.traefik.yaml`
in the `up` command, as above. Review the restored selections in the Admin
interface after a schema change or migration.

## What the web app does

- Lists accessible tables and loads their rows, including multi-page results.
- Searches tables and rows in the browser.
- Lets User group members edit only columns selected by an Admin for that table.
- Lets Admin group members add, edit, delete, and export rows as JSON.
- Lets Admin group members inspect real-time row and schema changes for the
  selected table, including the actor and before/after values when provided by
  Genesys Cloud. The real-time API covers up to the previous 14 days.

The app does not keep a separate audit database or provide rollback. Use Genesys
permissions and audit facilities for production governance.

Before updating or deleting a row, the app reads its current value and rejects
changes if another editor has modified it since it was loaded. The edit draft
is retained. Genesys does not expose a conditional row version in the SDK used
here, so a change between that read and the write can still race. Coordinate
simultaneous edits when this distinction matters.

## Verification

Run the regression tests with Node.js:

```bash
node --test tests/*.mjs
```

Run the Docker startup, proxy, and persistent storage smoke checks on a Linux
host with Docker, curl, and Node.js:

```bash
bash tests/test_container.sh
```

The regression tests use mock API responses and deferred requests. The Docker
checks use public dummy IDs and an isolated temporary volume. They do not
modify Genesys Cloud data. Live OAuth and permissions still depend on the
configured Genesys organization.
