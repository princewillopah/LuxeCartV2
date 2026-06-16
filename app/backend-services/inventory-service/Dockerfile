FROM node:18-alpine
WORKDIR /app
# copy dependency manifests
COPY backend-services/inventory-service/package*.json ./

# install dependencies
RUN npm ci --omit=dev

# copy service source
COPY backend-services/inventory-service/ ./

# copy shared code
COPY backend-services/shared ./shared
EXPOSE 3011
CMD ["npm", "start"]
