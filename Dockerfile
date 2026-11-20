# Mascotly — open-source embeddable AI mascot
FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-fund --no-audit

COPY src ./src
COPY public ./public
COPY bin ./bin
COPY examples ./examples
COPY docs ./docs

RUN mkdir -p /app/data
VOLUME ["/app/data"]
EXPOSE 4242

CMD ["node", "src/index.js"]
