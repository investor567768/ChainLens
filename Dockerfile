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
# Start a private session bus and an unlocked keychain, then ChainLens (see tools/keychain.sh).
CMD ["dbus-run-session", "--", "sh", "tools/keychain.sh"]
