#!/bin/sh
# Starts an unlocked keychain for Buy, tests it, then starts ChainLens. If anything fails the site still starts.
eval "$(printf 'chainlens-keyring' | gnome-keyring-daemon --daemonize --unlock 2>/dev/null | grep '^[A-Z_]*=' | sed 's/^/export /')"
echo "[start] keychain: ${GNOME_KEYRING_CONTROL:-none}"
if printf 'test' | secret-tool store --label=chainlens-test purpose chainlens-test >/dev/null 2>&1; then
  echo "[start] keychain test: ok"
else
  echo "[start] keychain test: FAILED"
fi
exec node tools/start.mjs
