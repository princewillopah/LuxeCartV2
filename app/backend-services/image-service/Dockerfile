FROM node:26-alpine

WORKDIR /app

RUN apk add --no-cache wget tini

COPY backend-services/image-service/package*.json ./
RUN npm install --omit=dev

COPY backend-services/image-service/ ./
COPY backend-services/shared ./shared

EXPOSE 3016

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3016/health || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server.js"]
