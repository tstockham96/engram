FROM node:20-slim

WORKDIR /app

# Install build dependencies for better-sqlite3 native addon
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
RUN npm ci

COPY . .
RUN npm run build
RUN npm prune --production

# Persistent data volume mount point
RUN mkdir -p /data

EXPOSE 3800

# Use hosted multi-tenant server
CMD ["node", "dist/hosted.js"]
