FROM node:22-alpine

LABEL org.opencontainers.image.title="engram-mcp"
LABEL org.opencontainers.image.description="Universal memory layer for AI agents — MCP server"
LABEL org.opencontainers.image.source="https://github.com/tstockham96/engram"

WORKDIR /app

# Install engram-sdk from npm
RUN npm install -g engram-sdk

# Create data directory for vault storage
RUN mkdir -p /data
ENV ENGRAM_DB_PATH=/data/engram.db

# MCP server runs on stdio by default, HTTP on port 3801 with --http
EXPOSE 3801

ENTRYPOINT ["engram-mcp"]
