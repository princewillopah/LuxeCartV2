FROM node:18-alpine
WORKDIR /app
# copy dependency manifests
COPY backend-services/admin-service/package*.json ./

# install dependencies
RUN npm ci --omit=dev

# copy service source
COPY backend-services/admin-service/ ./

# copy shared code
COPY backend-services/shared ./shared
EXPOSE 3010
CMD ["npm", "start"]
