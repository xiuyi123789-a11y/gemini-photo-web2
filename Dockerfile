FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production PORT=3001 DATA_DIR=/app/data
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node server ./server
RUN chmod 0644 /app/package.json /app/package-lock.json && mkdir -p /app/data && chown node:node /app/data
USER node
# Check imports and the native image library as the same user that serves requests.
RUN node --input-type=module -e "import sharp from 'sharp'; import './server/app.js'; const png=await sharp({create:{width:4,height:4,channels:3,background:'white'}}).png().toBuffer(); if(!png.length)process.exit(1); console.log('RUNTIME_IMPORT_AND_SHARP_OK');"
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD node -e "fetch('http://127.0.0.1:3001/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server/index.js"]
