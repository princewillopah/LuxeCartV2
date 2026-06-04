FROM node:18-alpine
WORKDIR /app
# copy dependency manifests
COPY services/inventory-service/package*.json ./

# install dependencies
RUN npm ci --omit=dev

# copy service source
COPY services/inventory-service/ ./

# copy shared code
COPY services/shared ./shared
EXPOSE 3011
CMD ["npm", "start"]
