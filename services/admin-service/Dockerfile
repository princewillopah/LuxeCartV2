FROM node:18-alpine
WORKDIR /app
# copy dependency manifests
COPY services/admin-service/package*.json ./

# install dependencies
RUN npm ci --omit=dev

# copy service source
COPY services/admin-service/ ./

# copy shared code
# COPY services/shared ./shared
EXPOSE 3010
CMD ["npm", "start"]
