// Downloads what the moderator's "How do I sound?" panel needs for its overall quality score:
// Microsoft's DNSMOS P.835 model (CC BY 4.0, github.com/microsoft/DNS-Challenge) and the
// onnxruntime-web build that runs it. About 12 MB, so it's fetched at image build (see Dockerfile)
// rather than kept in git. Run `npm run fetch-mic-model` once for local development.
// Files are checked against fixed hashes; a failed download only hides the score.
import { createHash } from "crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "vendor", "mos");
const ORT = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.20.1/dist/";
const files = {
    "sig_bak_ovr.onnx": [
        "https://raw.githubusercontent.com/microsoft/DNS-Challenge/82f1b17e7776a43eee395d0f45bae8abb700ad00/DNSMOS/DNSMOS/sig_bak_ovr.onnx",
        "269fbebdb513aa23cddfbb593542ecc540284a91849ac50516870e1ac78f6edd",
    ],
    "ort.wasm.min.mjs": [ORT + "ort.wasm.min.mjs", "f53ed4792e758e7232f779d479eb8931b97ff3ab2e3b9a33ee00d1251ffdaad6"],
    "ort-wasm-simd-threaded.mjs": [ORT + "ort-wasm-simd-threaded.mjs", "745eb7c0ce6f18a6aa521971b2877babc7ffb27eecb58ab3bc6e5ef4692672e8"],
    "ort-wasm-simd-threaded.wasm": [ORT + "ort-wasm-simd-threaded.wasm", "207d02be4591c156b0a98f024f3d58005b5b04c92274d759fb390338c63559ea"],
};

const sha = (buf) => createHash("sha256").update(buf).digest("hex");
mkdirSync(dir, { recursive: true });
let failed = 0;
for (const [name, [url, hash]] of Object.entries(files)) {
    const path = join(dir, name);
    if (existsSync(path) && sha(readFileSync(path)) === hash) continue;
    try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const buf = Buffer.from(await res.arrayBuffer());
        if (sha(buf) !== hash) throw new Error("hash mismatch");
        writeFileSync(path, buf);
        console.log(`fetched ${name} (${(buf.length / 1e6).toFixed(1)} MB)`);
    } catch (e) {
        failed++;
        console.warn(`could not fetch ${name}: ${e.message}`);
    }
}
if (failed) console.warn("mic quality score will be unavailable");
