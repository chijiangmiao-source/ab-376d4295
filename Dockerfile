FROM node:20-alpine

WORKDIR /app

# 无第三方依赖：仅复制源码与测试/脚本
COPY package.json ./
COPY src ./src
COPY scripts ./scripts
COPY test ./test

RUN mkdir -p data && sh scripts/build.sh

ENV HOST=0.0.0.0 \
    PORT=8080 \
    DATA_FILE=/app/data/conclusions.json

EXPOSE 8080

HEALTHCHECK --interval=10s --timeout=3s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server.js"]
