// Deterministic encoder seam only. No model runtime import, download or inference.
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
export const env = { version: '4.3.1', allowRemoteModels: true, useFSCache: true };
export const observations = [];
const record = row => {
  observations.push(row);
  if (process.env.ALAYA_AUTHORED_ENCODER_LOG) appendFileSync(process.env.ALAYA_AUTHORED_ENCODER_LOG,
    JSON.stringify({ pid: process.pid, ...row }) + '\n');
};
export function writeEncoderTree(cacheRoot, modelId) {
  const root = join(cacheRoot, modelId);
  mkdirSync(join(root, 'onnx'), { recursive: true });
  // Same self-contained empty ONNX graph used by the loaded-runtime seam tests.
  writeFileSync(join(root, 'onnx/model_quantized.onnx'), Buffer.from([0x3a, 0]));
  writeFileSync(join(root, 'config.json'), JSON.stringify({ hidden_size: 384, model_type: 'bert' }));
  for (const name of ['tokenizer_config.json', 'tokenizer.json', 'special_tokens_map.json']) writeFileSync(join(root, name), '{}');
}
class Tensor {
  constructor(dims, values) { this.dims = dims; this.values = values; }
  tolist() { return this.values; }
  normalize(ord, dim) {
    if (ord !== 2 || dim !== -1) throw new Error('unexpected normalization');
    return new Tensor(this.dims, this.values.map(row => { const norm = Math.hypot(...row); return row.map(x => x / norm); }));
  }
}
export async function pipeline(task, modelRoot, options) {
  if (env.allowRemoteModels !== false || options.local_files_only !== true || options.dtype !== 'q8' || task !== 'feature-extraction') {
    throw new Error('authored encoder requires verified offline loader');
  }
  record({ kind: 'load', modelRoot, options });
  return Object.assign(async () => { throw new Error('opaque embedding callable forbidden'); }, {
    tokenizer: Object.assign((texts, options) => {
      if (texts.length !== 1 || options.truncation !== false || options.padding !== false || options.add_special_tokens !== true) {
        throw new Error('unexpected tokenizer options');
      }
      const ids = [101, ...Array.from(texts[0], char => char.codePointAt(0) + 1000), 102];
      record({ kind: 'tokenize', text: texts[0], ids });
      return { input_ids: new Tensor([1, ids.length], [ids]), attention_mask: new Tensor([1, ids.length], [ids.map(() => 1)]) };
    }, { model_max_length: 64 }),
    model: Object.assign(async inputs => {
      const ids = inputs.input_ids.tolist()[0];
      record({ kind: 'encode', ids });
      // A controlled asynchronous encoder occupancy permits real-child cancellation proof.
      await new Promise(resolve => setTimeout(resolve, 100));
      // Each token contributes a distinct deterministic 384-vector. Mean/L2 still run in the owner.
      const rows = ids.map(id => Array.from({ length: 384 }, (_, i) => ((id * (i + 1)) % 97 + 1) / 97));
      return { last_hidden_state: new Tensor([1, ids.length, 384], [rows]) };
    }, { config: { hidden_size: 384, max_position_embeddings: 64, model_type: 'bert' } }),
    dispose: async () => record({ kind: 'dispose' })
  });
}
export function mean_pooling(hidden, mask) {
  const rows = hidden.tolist()[0], keep = mask.tolist()[0];
  return new Tensor([1, 384], [Array.from({ length: 384 }, (_, i) =>
    rows.reduce((sum, row, j) => sum + row[i] * keep[j], 0) / keep.reduce((a, b) => a + b, 0))]);
}
