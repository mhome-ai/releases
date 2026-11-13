#!/usr/bin/env python3
import argparse
import json
from pathlib import Path

import numpy as np
import onnxruntime as ort


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("model_id")
    parser.add_argument("pack_dir", type=Path)
    args = parser.parse_args()

    root = Path(__file__).resolve().parent.parent
    manifest = json.loads((root / "model-packs.lock.json").read_text())
    pack = next(item for item in manifest["packs"] if item["id"] == args.model_id)
    artifacts = {item["id"]: item for item in pack["artifacts"]}
    model_path = args.pack_dir / artifacts["model"]["fileName"]
    voices_path = args.pack_dir / artifacts["voices"]["fileName"]

    config = json.loads((root / pack["smokeVocab"]).read_text())
    vocab = config["vocab"]
    tokens = [vocab[ch] for ch in pack["smokePhonemes"] if ch in vocab]
    if not tokens:
        raise RuntimeError("smoke phonemes produced no Kokoro tokens")
    padded = np.asarray([[0, *tokens, 0]], dtype=np.int64)

    with np.load(voices_path) as voices:
        style_rows = np.asarray(voices[pack["smokeVoice"]], dtype=np.float32)
    row = style_rows[min(len(tokens), style_rows.shape[0]) - 1].reshape(-1)
    if row.size < 256:
        raise RuntimeError(f"voice row contains only {row.size} values")
    style = row[:256].reshape(1, 256)

    session = ort.InferenceSession(
        str(model_path), providers=["CPUExecutionProvider"]
    )
    input_names = {item.name for item in session.get_inputs()}
    token_input = "input_ids" if "input_ids" in input_names else "tokens"
    required = {token_input, "style", "speed"}
    if not required.issubset(input_names):
        raise RuntimeError(f"unexpected ONNX inputs: {sorted(input_names)}")
    outputs = session.run(
        None,
        {
            token_input: padded,
            "style": style,
            "speed": np.asarray([1.0], dtype=np.float32),
        },
    )
    waveform = np.asarray(outputs[0], dtype=np.float32).reshape(-1)
    if waveform.size < 1000 or not np.isfinite(waveform).all():
        raise RuntimeError("Kokoro returned invalid or empty audio")
    peak = float(np.max(np.abs(waveform)))
    rms = float(np.sqrt(np.mean(np.square(waveform))))
    if peak <= 1e-5 or rms <= 1e-6:
        raise RuntimeError("Kokoro returned silent audio")
    print(
        f"{args.model_id}: {waveform.size / 24000.0:.3f}s "
        f"peak={peak:.6f} rms={rms:.6f}"
    )


if __name__ == "__main__":
    main()
