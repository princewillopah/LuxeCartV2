FROM node:18-alpine
WORKDIR /app
# copy dependency manifests
COPY services/product-service/package*.json ./

# install dependencies
RUN npm ci --omit=dev

# copy service source
COPY services/product-service/ ./

EXPOSE 3003

CMD ["npm", "start"]
