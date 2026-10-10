#!/bin/sh
set -eu

uuid_pattern='^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
for value in "$GENESYS_CLIENT_ID" "$GENESYS_ADMIN_GROUP_ID" "$GENESYS_USER_GROUP_ID"; do
    if ! printf '%s' "$value" | grep -Eq "$uuid_pattern"; then
        echo 'Genesys client and group IDs must be UUIDs.' >&2
        exit 1
    fi
done

case "$GENESYS_REGION" in
    ''|*[!a-z0-9_]* )
        echo 'GENESYS_REGION must be an SDK region key.' >&2
        exit 1
        ;;
esac

admin_group_id=$(printf '%s' "$GENESYS_ADMIN_GROUP_ID" | tr '[:upper:]' '[:lower:]')
user_group_id=$(printf '%s' "$GENESYS_USER_GROUP_ID" | tr '[:upper:]' '[:lower:]')
if [ "$admin_group_id" = "$user_group_id" ]; then
    echo 'Admin and user group IDs must be different.' >&2
    exit 1
fi
