FROM node:26-alpine
WORKDIR /app

# copy dependency manifests
COPY backend-services/api-gateway-service/package*.json ./

# install dependencies
RUN npm ci --omit=dev

# copy service source
COPY backend-services/api-gateway-service/ ./
COPY backend-services/shared ./shared

EXPOSE 3000

CMD ["npm", "start"]
