FROM node:18-alpine

WORKDIR /app

# copy dependency manifests
COPY services/rating-service/package*.json ./

# install dependencies
RUN npm ci --omit=dev

# copy service source
COPY services/rating-service/ ./

EXPOSE 3007

CMD ["npm", "start"]