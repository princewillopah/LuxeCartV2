FROM node:18-alpine

WORKDIR /app

# copy dependency manifests
COPY services/user-service/package*.json ./

# install dependencies
RUN npm ci --omit=dev

# copy service source
COPY services/user-service/ ./

# copy shared code
COPY services/shared ./shared

EXPOSE 3002

CMD ["npm", "start"]
