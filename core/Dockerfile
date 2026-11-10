# Build from the repository root:  docker build -f core/Dockerfile -t murmur-core .
FROM node:24-slim AS web
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

FROM python:3.11-slim AS runtime
ENV PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1 MURMUR_DATA_DIR=/data MURMUR_HOST=0.0.0.0 MURMUR_PORT=8000
RUN useradd --create-home --uid 1000 murmur && mkdir /data && chown murmur /data
WORKDIR /app
COPY core/pyproject.toml core/README.md ./
COPY core/src ./src
RUN pip install ".[s3,postgres]"
COPY --from=web /web/dist /usr/local/lib/python3.11/site-packages/murmur_core/web_dist
USER murmur
VOLUME /data
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/healthz', timeout=4).status==200 else 1)"
ENTRYPOINT ["murmur-core"]
CMD ["serve"]
