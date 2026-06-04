FROM node:18-alpine

WORKDIR /app
# copy dependency manifests
COPY services/payment-service/package*.json ./

# install dependencies
RUN npm ci --omit=dev

# copy service source
COPY services/payment-service/ ./

# copy shared code
COPY services/shared ./shared

EXPOSE 3008

CMD ["npm", "start"]
