FROM oven/bun:latest
COPY package.json .
RUN bun install
COPY or_proxy.ts .
CMD ["bun", "run", "or_proxy.ts"]
