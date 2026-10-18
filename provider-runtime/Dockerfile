FROM oven/bun:1.3.6-debian
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production --ignore-scripts
COPY --chown=bun:bun src ./src
RUN mkdir -p /app/state && chown bun:bun /app/state
USER bun
ENV PROVIDER_RUNTIME_HOST=0.0.0.0
EXPOSE 3426
CMD ["bun", "src/server.mjs"]
