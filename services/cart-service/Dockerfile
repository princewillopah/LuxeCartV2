FROM node:18-alpine

WORKDIR /app

# copy dependency manifests
COPY services/cart-service/package*.json ./

# install dependencies
RUN npm ci --omit=dev

# copy service source
COPY services/cart-service/ ./

EXPOSE 3004

CMD ["npm", "start"]
