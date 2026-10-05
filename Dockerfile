FROM node:20-alpine AS builder
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm install

COPY . .
RUN npm run build

FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm install --omit=dev

COPY --from=builder /app/dist ./dist
# So migrations run inside the container: docker exec rpn-backend npm run migrate up
COPY migrations ./migrations

EXPOSE 3000
CMD ["npm", "start"]
