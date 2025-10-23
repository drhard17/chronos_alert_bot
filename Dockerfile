FROM node:alpine AS build
WORKDIR /app
COPY package*.json .
RUN npm ci
COPY . .
RUN npm run build

FROM node:alpine AS production
WORKDIR /app
COPY package*.json .
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
CMD ["npm", "run", "start"]