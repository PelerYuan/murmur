# murmur-asr, CPU image.  Build from the asr/ directory:  docker build -t murmur-asr .
# Models are NOT baked in by default: they are downloaded into the /models volume on first start
# (~270 MB for SenseVoice + CAM++ + VAD).  Use --build-arg BAKE_MODELS=1 to bake them into the image instead.
FROM python:3.10-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    MURMUR_ASR_MODEL_DIR=/models \
    MURMUR_ASR_HOST=0.0.0.0 \
    MURMUR_ASR_PORT=8100

RUN useradd --create-home --uid 1000 murmur && mkdir /models && chown murmur:murmur /models

WORKDIR /app
COPY constraints.txt pyproject.toml README.md ./
COPY src ./src
RUN pip install -c constraints.txt .

ARG BAKE_MODELS=0
USER murmur
RUN if [ "$BAKE_MODELS" = "1" ]; then python -m murmur_asr.download_models; fi

VOLUME /models
EXPOSE 8100
# first start may download models; give it time before the healthcheck counts failures
HEALTHCHECK --interval=30s --timeout=5s --start-period=600s --retries=3 \
  CMD python -c "import os,urllib.request as u; u.urlopen('http://127.0.0.1:%s/health' % os.environ.get('MURMUR_ASR_PORT','8100'), timeout=4)" || exit 1

CMD ["python", "-m", "murmur_asr"]
