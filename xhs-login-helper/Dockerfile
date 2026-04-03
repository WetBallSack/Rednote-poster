FROM mcr.microsoft.com/playwright:v1.40.0-jammy

WORKDIR /app

COPY package.json ./
RUN npm install

COPY tsconfig.json ./
COPY index.ts ./

EXPOSE 3000

CMD ["npx", "ts-node", "index.ts"]