FROM node:24-alpine

WORKDIR /app
COPY server/*.mjs ./server/
RUN mkdir -p /data && chown node:node /data

USER node
ENV PORT=3000 \
    POLICY_PATH=/data/column-access.json
EXPOSE 3000
CMD ["node", "server/main.mjs"]
