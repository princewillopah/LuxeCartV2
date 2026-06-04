FROM node:18-alpine
WORKDIR /app
# copy dependency manifests
COPY services/order-service/package*.json ./

# install dependencies
RUN npm ci --omit=dev

# copy service source
COPY services/order-service/ ./

# copy shared code
COPY services/shared ./shared

EXPOSE 3005

CMD ["npm", "start"]
