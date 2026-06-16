FROM node:26-alpine

WORKDIR /app

# copy dependency manifests
COPY backend-services/search-service/package*.json ./

# install dependencies
RUN npm ci --omit=dev

# copy service source
COPY backend-services/search-service/ ./

# copy shared code
COPY backend-services/shared ./shared

EXPOSE 3012

CMD ["npm", "start"]
