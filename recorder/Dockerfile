# murmur-recorder: slim image, runs as a non-root user.
#   docker build -t murmur-recorder recorder/
#   docker run -d --name murmur-recorder --restart unless-stopped \
#     --device /dev/snd --group-add "$(getent group audio | cut -d: -f3)" \
#     -e MURMUR_CORE_URL=http://core.lan:8000 -e MURMUR_TOKEN=... \
#     -v murmur-buffer:/buffer murmur-recorder
FROM python:3.10-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends libportaudio2 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY pyproject.toml README.md ./
COPY src ./src
RUN pip install --no-cache-dir .

# uid 1000 is typical for the first host user; the audio group is added at `docker run` time
# with --group-add <host audio gid> because /dev/snd/* is owned by the *host's* audio gid.
RUN useradd --create-home --uid 1000 recorder \
    && mkdir /buffer && chown recorder /buffer
USER recorder

ENV MURMUR_BUFFER_DIR=/buffer \
    PYTHONUNBUFFERED=1
VOLUME /buffer

# The recorder touches /buffer/.alive every heartbeat interval, whether or not Core is reachable
# (a Core outage must not mark the container unhealthy -- audio is still being buffered).
HEALTHCHECK --interval=60s --timeout=5s --start-period=20s \
    CMD python -c "import os,sys,time; sys.exit(time.time()-os.path.getmtime('/buffer/.alive')>60)"

ENTRYPOINT ["murmur-recorder"]
CMD ["run"]
