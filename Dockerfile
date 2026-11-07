FROM mcr.microsoft.com/playwright:v1.64.1-noble

WORKDIR /app

# Copy dependency definition
COPY package*.json ./

# Install dependencies including devDependencies for TypeScript build
RUN npm install

# Copy project configuration and source files
COPY tsconfig.json ./
COPY src/ ./src/

# Compile TypeScript to dist/
RUN npm run build

# Prune devDependencies to reduce image footprint
RUN npm prune --omit=dev

EXPOSE 3000

ENV NODE_ENV=production
ENV PORT=3000

CMD ["node", "dist/index.js"]
