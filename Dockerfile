FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY server.js ./
COPY lib ./lib
COPY public ./public
COPY info ./info
COPY sql ./sql

ENV PORT=3000
EXPOSE 3000

CMD ["npm", "start"]
