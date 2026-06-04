FROM node:18-alpine
WORKDIR /app

# copy dependency manifests
COPY services/api-gateway-service/package*.json ./

# install dependencies
RUN npm ci --omit=dev

# copy service source
COPY services/api-gateway-service/ ./

EXPOSE 3000

CMD ["npm", "start"]
