FROM node:26-alpine

WORKDIR /app
# copy dependency manifests
COPY backend-services/payment-service/package*.json ./

# install dependencies
RUN npm ci --omit=dev

# copy service source
COPY backend-services/payment-service/ ./

# copy shared code
COPY backend-services/shared ./shared

EXPOSE 3008

CMD ["npm", "start"]
