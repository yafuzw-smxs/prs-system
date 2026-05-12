# 小巧的 Node 镜像，跟 Railway 上的 node@22 一致
FROM node:22-alpine AS base

WORKDIR /app

# 先复制依赖描述，利用 Docker 层缓存（package.json 没变就跳过 npm install）
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

# 再复制源码
COPY . .

# Volume 挂载点（fly.toml 里定义）
RUN mkdir -p /app/data
VOLUME ["/app/data"]

EXPOSE 3000

# 关闭 npm progress、提速冷启动
ENV NPM_CONFIG_LOGLEVEL=warn

CMD ["node", "server.js"]
