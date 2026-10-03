// Minimal ambient types for untyped niche-decoder deps (bench + icons.ts use).
declare module "heic-decode" {
  export interface HeicImage {
    width: number;
    height: number;
    data: Uint8ClampedArray;
  }
  const decode: (opts: { buffer: Uint8Array | Buffer | ArrayBuffer }) => Promise<HeicImage>;
  export default decode;
}
