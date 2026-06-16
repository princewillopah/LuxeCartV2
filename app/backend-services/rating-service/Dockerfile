FROM node:18-alpine

WORKDIR /app

# copy dependency manifests
COPY backend-services/rating-service/package*.json ./

# install dependencies
RUN npm ci --omit=dev

# copy service source
COPY backend-services/rating-service/ ./
COPY backend-services/shared ./shared

EXPOSE 3007

CMD ["npm", "start"]