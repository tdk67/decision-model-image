# Traffic Sign Categorizer — production runtime image (BYOK, no server-side secrets)
# Built against the host's resolved dependencies + production build to avoid
# in-container npm ci (keeps memory footprint low on constrained hosts).
FROM node:22-slim

ENV NODE_ENV=production
WORKDIR /app

# Runtime deps (express, multer, preact, @google/genai, tsx, dotenv)
COPY node_modules ./node_modules
# Server code
COPY server ./server
# Static frontend (built with `npm run build`)
COPY dist ./dist
# Taxonomy + config
COPY data ./data
COPY config.json ./config.json

RUN chown -R node:node /app
USER node

EXPOSE 3002

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3002)+'/api/taxonomy').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "--import", "tsx", "server/index.ts"]
