Official Ollama Linux archives downloaded by `npm run ollama:pack`.

These files are gitignored. The packer reuses a file when its SHA-256 matches
`runtimes.lock.json`; otherwise it downloads again.
