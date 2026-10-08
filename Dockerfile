FROM nginx:stable-alpine

COPY web/ /usr/share/nginx/html/
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY docker/config.js.template /etc/nginx/templates/config.js.template
COPY docker/validate-config.sh /docker-entrypoint.d/10-validate-config.sh
RUN chmod +x /docker-entrypoint.d/10-validate-config.sh

ENV NGINX_ENVSUBST_OUTPUT_DIR=/usr/share/nginx/html \
    NGINX_ENVSUBST_FILTER=^GENESYS_

EXPOSE 80
