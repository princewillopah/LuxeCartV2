FROM node:26-alpine

WORKDIR /app

# copy dependency manifests
COPY backend-services/cart-service/package*.json ./

# install dependencies
RUN npm ci --omit=dev

# copy service source
COPY backend-services/cart-service/ ./
COPY backend-services/shared ./shared

EXPOSE 3004

CMD ["npm", "start"]
