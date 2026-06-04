FROM node:18-alpine

WORKDIR /app
# copy dependency manifests
COPY services/review-service/package*.json ./

# install dependencies
RUN npm ci --omit=dev

# copy service source
COPY services/review-service/ ./

EXPOSE 3006

CMD ["npm", "start"]
