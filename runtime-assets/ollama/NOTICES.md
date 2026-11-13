# Ollama runtime notices

These runtime archives are derived from the official Ollama release pinned
in `ollama/runtimes.lock.json`. The `ollama` binary and CPU/Vulkan/MLX libraries
are MIT-licensed. CUDA packs also contain NVIDIA CUDA runtime libraries that
Ollama already redistributes in its official Linux archives; those files are
unchanged and remain subject to the NVIDIA CUDA Toolkit EULA.

| Pack | Transform | Contents |
| --- | --- | --- |
| `linux-amd64-cpu` | drop `lib/ollama/cuda_v12` and `cuda_v13` | CPU + Vulkan |
| `linux-amd64-cuda` | official archive, renamed | CPU + Vulkan + CUDA 12 + CUDA 13 |
| `linux-arm64-cpu` | drop `lib/ollama/cuda_v12` and `cuda_v13` | CPU only (upstream ARM archive has no Vulkan) |
| `linux-arm64-cuda` | official archive, renamed | CPU + CUDA 12 + CUDA 13 (SBSA / server ARM, not Jetson) |
| `darwin` | official `ollama-darwin.tgz`, unchanged | official macOS archive (Metal/MLX) |

ROCm extras are not published. Ollama selects `cuda_v12` or `cuda_v13`
at process start from the GPU compute capability and NVIDIA driver; both
directories stay in the CUDA packs.

CPU packs do not include CUDA libraries. The MIT license text is
`LICENSES/ollama-MIT.txt`. NVIDIA terms:
https://docs.nvidia.com/cuda/eula/
