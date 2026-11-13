# Third-Party Licenses & Notices

This repository extends **FreeLLMAPI** (`LICENSE` at repository root, MIT License, Copyright (c) 2026 Tashfeen Ahmed) and incorporates ported provider/gateway components and catalog data from the open-source projects listed below.

All original custom extensions in this repository are licensed under the **MIT License**.

---

## 1. 9Router

- **Repository**: https://github.com/decolua/9router
- **License**: MIT License
- **Used / Ported Scope**: Provider catalog definitions, OAuth/Web-Cookie executors (including `chatgpt-web`, `deepseek-web`, `codex`, `gemini-cli`, `kiro`, `qoder`, `copilot`), pricing tables, and gateway routing adaptations under `server/src/custom/provider-accounts/` and `server/src/custom/x-gateway/`.

```text
MIT License

Copyright (c) 2024-2026 decolua and contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

## 2. noble-hashes (Keccak-f[1600] / SHA3-256 port via 9Router)

- **Repository**: https://github.com/paulmillr/noble-hashes
- **License**: MIT License
- **Used / Ported Scope**: Keccak-f[1600] permutation used in the `DeepSeekHashV1` Proof-of-Work solver (`server/src/custom/provider-accounts/deepseek-pow.ts`), ported via 9Router.

```text
MIT License

Copyright (c) 2022 Paul Miller (https://paulmillr.com)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
