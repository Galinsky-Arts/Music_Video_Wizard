// Adapted from Jean, Copyright (c) 2026 Warehouse SAS, MIT. See THIRD_PARTY_NOTICES.md.
const WAN = 'jean-is/FastWan2.2-TI2V-5B-ONNX/resolve/be5c3e118918b31a600c2e055f33050f904689b1/'
/** One of umT5's three graphs and its weights. @param {string} part @param {string} graph @param {number} size @param {string} data @param {number} bytes @returns {File[]} */
const umt5 = (part, graph, size, data, bytes) => [[`${WAN}text_encoder/layers_${part}.onnx`, graph, size], [`${WAN}text_encoder/layers_${part}.onnx.data0`, data, bytes]]
/** FastWan's (D585): umT5's tokenizer and int8 rows, its three graphs of eight layers, the transformer, TAEHV's decoder. */
export const FILM = {
  tokenizer: /** @type {File[]} */ ([
    [`${WAN}tokenizer/tokenizer.json`, '20a46ac256746594ed7e1e3ef733b83fbc5a6f0922aa7480eda961743de080ef', 16837459],
    [`${WAN}tokenizer/tokenizer_config.json`, '1d8d2a216bf8e70ac15b7ddcea566c4dd0433c024b39a58ca5e4c66bd78defbd', 61758],
  ]),
  words: /** @type {File[]} */ ([
    [`${WAN}text_encoder/embedding.i8`, 'c16bb5cb6ceee8c2c98d6c97a62df07b118a147e1bab1490569940beee03b1a1', 1050148864],
    [`${WAN}text_encoder/embedding.scale.f16`, 'd1123e1a4068d463fc50caa7a7ec019130b1aebec0615f0adf30ac2d7caf374c', 512768],
  ]),
  read: [
    umt5('00_08', 'fd1e9d7c4bda31ed74d88983c08b8282cf15fab1dd00ad58d119b743d9ba4746', 719849, '449f8705226ed4a4b5892579df7a29b094ca4d35db6bf2acecdcdc0e5d9d7f99', 1661108224),
    umt5('08_16', '3405cd8d100611be16bf7421ff8dc87f79d14d2aaa493fb483776296df580221', 719849, '0eb2eb013cd2fccdb4169e3ac6d39a27b477fd412d7fd559650c7dd1ed615c3f', 1661108224),
    umt5('16_24', 'a53297f0b15d18a27e305f8ce226e9109f30ae5e4b2a5eae181ce33675f80374', 727980, '991fef11ba13f48548a3b6f9c8346f83a367fdefcb5a9d303bf6e1a7c2461abf', 1661116416),
  ],
  denoise: /** @type {File[]} */ ([
    [`${WAN}transformer/transformer.onnx`, '5df39c609eea2d58491823dbf40d8c46a7dc656f15b1e33f0fb8a9306d354dfd', 4825354],
    [`${WAN}transformer/transformer.onnx.data0`, '20b8dce565b154345f298185d6b435ce9e2896d1d5da6507c8b1d85ac7d895d8', 1899927552],
    [`${WAN}transformer/transformer.onnx.data1`, '6c57e5f05631d4aa3c0c0aa3ea5196e37c9d7dfef9fdd8bc2f338dec3c741e48', 1865023488],
    [`${WAN}transformer/transformer.onnx.data2`, '5fd43b464a08ef32de3af8e982115d5d47dd5ea7006b5e160cb4836c01e6a36a', 1657816064],
  ]),
  decode: /** @type {File[]} */ ([[`${WAN}decoder/taehv.onnx`, 'c5e8c14db186fa72013fb231e3d0315498d119a9a161618f538460ef213e20c0', 20037678]]),
}

export const FILES = [...FILM.tokenizer, ...FILM.words, ...FILM.read.flat(), ...FILM.denoise, ...FILM.decode];
export const MODEL_BYTES = FILES.reduce((total, file) => total + file[2], 0);
export const CACHE = "mvw-fastwan-be5c3e1-v1";
export const MODEL_REVISION = "be5c3e118918b31a600c2e055f33050f904689b1";
