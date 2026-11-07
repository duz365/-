# 《红黄绿》—— 纯文字多人推理游戏
# 单阶段构建：零依赖，直接拷源码即可
FROM node:22-alpine

ENV NODE_ENV=production
WORKDIR /app

# 先拷清单，方便以后加依赖时利用缓存
COPY package.json ./
COPY mvp/package.json ./mvp/

# 源码
COPY mvp ./mvp
COPY README.md ./

# Railway / 其他平台会注入 PORT；本地默认 8787
ENV PORT=8787
EXPOSE 8787

# 非 root 运行
RUN addgroup -S app && adduser -S app -G app && chown -R app:app /app
USER app

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "mvp/src/net/server.js"]
