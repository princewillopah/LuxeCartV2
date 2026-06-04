FROM node:18-alpine
WORKDIR /app
# copy dependency manifests
COPY services/notification-service/package*.json ./

# install dependencies
RUN npm ci --omit=dev

# copy service source
COPY services/notification-service/ ./

# copy shared code
COPY services/shared ./shared
EXPOSE 3009
CMD ["npm", "start"]
