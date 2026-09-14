FROM node:18-alpine

WORKDIR /app

# Instale as dependências do backend
COPY backend/package*.json ./backend/
RUN cd backend && npm ci --only=production

# Copie código do frontend
COPY index.html login.html config.js ./
COPY assets ./assets
COPY sdk ./sdk

# Copie código do backend
COPY backend/server.js ./backend/

EXPOSE 3001

# Inicie o backend
CMD ["node", "backend/server.js"]
