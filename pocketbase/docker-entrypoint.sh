#!/bin/sh
# Start as root only long enough to make the data directory writable, then drop
# to the unprivileged `pocketbase` user.
#
# This matters for existing deployments: a pb_data volume created by an image
# that ran as root stays root-owned, and PocketBase then fails with "attempt to
# write a readonly database" on every request. Chowning here fixes an inherited
# volume without anyone having to run a one-off container.
set -e

if [ "$(id -u)" = "0" ]; then
    # Recursive chown is expensive on a large database, so only touch the tree
    # when the ownership is actually wrong.
    for dir in /pb_data /pb_public; do
        [ -d "$dir" ] || continue
        if [ "$(stat -c %u "$dir")" != "$(id -u pocketbase)" ]; then
            echo "entrypoint: taking ownership of $dir"
            chown -R pocketbase:pocketbase "$dir"
        fi
    done
    exec su-exec pocketbase /usr/local/bin/pocketbase "$@"
fi

# Already unprivileged (docker run --user, Kubernetes runAsUser, …): trust the
# caller to have mounted a writable volume.
exec /usr/local/bin/pocketbase "$@"
