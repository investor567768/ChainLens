# Hosted copy of ChainLens with a real OS keychain, so Buy can keep the agent wallet safely on mainnet.
FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
    dbus dbus-x11 gnome-keyring libsecret-1-0 libsecret-tools ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY . .
ENV HOST=0.0.0.0
# Start a private session bus and an unlocked keychain, then ChainLens. If the keychain fails, the site still starts.
CMD ["dbus-run-session", "--", "sh", "-c", "eval \"$(printf '' | gnome-keyring-daemon --daemonize --unlock --components=secrets 2>/dev/null)\"; echo \"[start] keychain: ${GNOME_KEYRING_CONTROL:-none}\"; exec node tools/start.mjs"]
