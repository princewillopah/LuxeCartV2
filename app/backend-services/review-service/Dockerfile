FROM node:26-alpine

WORKDIR /app
# copy dependency manifests
COPY backend-services/review-service/package*.json ./

# install dependencies
RUN npm ci --omit=dev

# copy service source
COPY backend-services/review-service/ ./
COPY backend-services/shared ./shared

EXPOSE 3006

CMD ["npm", "start"]
