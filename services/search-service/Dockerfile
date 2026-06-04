FROM node:18-alpine

WORKDIR /app

# copy dependency manifests
COPY services/search-service/package*.json ./

# install dependencies
RUN npm ci --omit=dev

# copy service source
COPY services/search-service/ ./

# copy shared code
COPY services/shared ./shared

EXPOSE 3012

CMD ["npm", "start"]
