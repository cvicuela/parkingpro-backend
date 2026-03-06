# Stage 1: Build React frontend
FROM node:18-alpine AS frontend-build
WORKDIR /app/frontend
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ .
RUN npm run build

# Stage 2: Production backend
FROM node:18-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --production
COPY . .
# Copy built frontend into public directory
COPY --from=frontend-build /app/frontend/dist ./public
EXPOSE 3000
CMD ["npm", "start"]
