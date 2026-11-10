# Third-party notices

Browser FastWan inference and tensor layout code is adapted from [Jean](https://github.com/jean-is/jean).

MIT License

Copyright (c) 2026 Warehouse SAS

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


FastWan model weights are downloaded separately from [jean-is/FastWan2.2-TI2V-5B-ONNX](https://huggingface.co/jean-is/FastWan2.2-TI2V-5B-ONNX/tree/be5c3e118918b31a600c2e055f33050f904689b1) (Apache-2.0); its bundled TAEHV decoder uses the MIT license. ONNX Runtime is MIT, Hugging Face Tokenizers Apache-2.0, and Mediabunny and its AAC encoder are MPL-2.0. Bundled package license texts are served alongside the browser engine at `/browser-gpu/LICENSES.txt`.

Unmodified source for Mediabunny and its AAC encoder is available at [Mediabunny v1.63.0](https://github.com/Vanilagy/mediabunny/tree/v1.63.0), including `packages/aac-encoder`. Hugging Face tokenizer source is at [tokenizers.js](https://github.com/huggingface/tokenizers.js). ONNX Runtime source is pinned to [8d85527a010e294a26b274749f74294b2a32cec5](https://github.com/microsoft/onnxruntime/tree/8d85527a010e294a26b274749f74294b2a32cec5).
