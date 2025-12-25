# 使用官方 Node.js 20 slim 版本，比 alpine 兼容性更好，比完整版更小
FROM node:20-slim

# 设置工作目录
WORKDIR /app

# 复制依赖定义文件
COPY package.json ./

# 安装生产环境依赖
# 使用淘宝源加速构建过程
RUN npm install --production --registry=https://registry.npmmirror.com
RUN apt-get update && \
    apt-get install -y ca-certificates && \
    update-ca-certificates && \
    rm -rf /var/lib/apt/lists/*
# 复制项目源代码
COPY . .

# 创建数据目录
RUN mkdir -p data

# 设置环境变量
ENV NODE_ENV=production
ENV PORT=8045
ENV HOST=0.0.0.0
# 关键配置：强制使用 Axios 模式，跳过二进制文件检查
ENV USE_NATIVE_AXIOS=true

# 暴露端口
EXPOSE 8045

# 健康检查
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:' + process.env.PORT + '/healthz', (res) => { process.exit(res.statusCode === 200 ? 0 : 1) }).on('error', () => process.exit(1))"

# 启动命令
CMD ["npm", "start"]
