"""Speaker embedding extraction (CAM++ zh-en via sherpa-onnx)."""
from __future__ import annotations

import numpy as np

SR = 16000


class SpeakerEmbedder:
    model_name = "campplus-zh-en"

    def __init__(self, model_path: str, num_threads: int = 1, provider: str = "cpu"):
        import sherpa_onnx as so

        cfg = so.SpeakerEmbeddingExtractorConfig(model=str(model_path), num_threads=num_threads, provider=provider)
        self._ex = so.SpeakerEmbeddingExtractor(cfg)
        self.dim: int = int(self._ex.dim)

    def embed(self, samples: np.ndarray) -> list[float] | None:
        st = self._ex.create_stream()
        st.accept_waveform(SR, samples.astype(np.float32, copy=False))
        st.input_finished()
        if not self._ex.is_ready(st):
            return None
        v = np.asarray(self._ex.compute(st), dtype=np.float32)
        if not np.all(np.isfinite(v)):
            return None
        return [float(x) for x in v]
