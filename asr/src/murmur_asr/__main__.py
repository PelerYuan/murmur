import logging
import sys

import uvicorn

from .config import Settings
from .service import create_app


def main() -> int:
    s = Settings.from_env()
    logging.basicConfig(level=s.log_level, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    logging.getLogger("murmur_asr").info(
        "starting murmur-asr: backend=%s provider=%s threads=%d workers=%d models=%s auth=%s",
        s.backend, s.provider, s.num_threads, s.workers, s.model_dir, "on" if s.api_key else "off")
    uvicorn.run(create_app(s), host=s.host, port=s.port, access_log=False, log_config=None, log_level=s.log_level.lower())
    return 0


if __name__ == "__main__":
    sys.exit(main())
