# Kokoro model-pack notices

The downloadable acoustic models and voice-style packs are separate runtime
assets. They are not linked into MeowCore or the native G2P programs.

| Component | Pinned evidence/release | Distribution use | License |
| --- | --- | --- | --- |
| `hexgrad/Kokoro-82M` | `f3ff3571791e39611d31c381e3a41a3af07b4987` | English acoustic-model weights and voices | Apache-2.0 |
| `hexgrad/Kokoro-82M-v1.1-zh` | `01e7505bd6a7a2ac4975463114c3a7650a9f7218` | Chinese + English acoustic-model weights and voices | Apache-2.0 |
| `thewh1teagle/kokoro-onnx` | release tag `model-files-v1.1`, commit `b85309f90fd2660ea3309cf0f2581360e4327555` | ONNX export and NPZ-compatible voice packaging | MIT |

The public model packs mirror the listed exporter release files byte-for-byte;
their SHA-256 digests and sizes are fixed in `model-packs.lock.json`. The model
repository revisions above are the pinned license-evidence revisions; they are
not represented as reproducible-export commits. The exporter release and each
mirrored byte stream are pinned independently. The model repositories identify
the works as Apache-2.0. Neither repository publishes an upstream `NOTICE` file
at the listed revision. The Apache-2.0 license and the exporter's MIT license
accompany every mirrored pack.

No eSpeak, Python interpreter, Python bytecode, `phonemizer`, or GPL/AGPL
component is contained in these model packs.
