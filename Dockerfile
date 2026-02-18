FROM node:20-slim

WORKDIR /app

# Install build dependencies for better-sqlite3
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
RUN npm ci --production=false

COPY . .
RUN npm run build

# Remove dev dependencies
RUN npm prune --production

EXPOSE 3800

CMD ["node", "dist/server.js"]
