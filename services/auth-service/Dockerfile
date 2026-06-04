FROM node:18-alpine
WORKDIR /app
# 
COPY services/auth-service/package*.json ./
RUN npm ci --omit=dev
COPY services/auth-service/ ./
COPY services/shared ./shared
EXPOSE 3001
CMD ["npm", "start"]
