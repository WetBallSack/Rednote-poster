# Use the official Playwright Docker image — Chromium is pre-installed at /ms-playwright.
# This is the ONLY reliable way to run Playwright on Render (free tier).
# The browser version in this image exactly matches the playwright npm package version below.
#
# To update: change BOTH this image tag AND the playwright version in package.json together.
# e.g. mcr.microsoft.com/playwright:v1.44.0-jammy  <-->  "playwright": "1.44.0"
FROM mcr.microsoft.com/playwright:v1.44.0-jammy

WORKDIR /app

# Install Node deps (playwright npm package needed for JS API, browser already in image)
COPY package.json ./
RUN npm install

# Copy TypeScript source and config
COPY tsconfig.json ./
COPY index.ts ./

# Tell playwright where the pre-installed browsers live in this image
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
ENV PORT=3000
EXPOSE 3000

CMD ["npx", "ts-node", "index.ts"]