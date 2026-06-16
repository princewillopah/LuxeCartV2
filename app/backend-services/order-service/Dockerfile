FROM node:18-alpine
WORKDIR /app
# copy dependency manifests
COPY backend-services/order-service/package*.json ./

# install dependencies
RUN npm ci --omit=dev

# copy service source
COPY backend-services/order-service/ ./

# copy shared code
COPY backend-services/shared ./shared

EXPOSE 3005

CMD ["npm", "start"]
