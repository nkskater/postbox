export { Buffer } from "buffer";
// Some browser dependencies inspect process.env; this object remains local to the bundle.
export const process = { env: {}, browser: true };
export const crypto = {
  getRandomValues(view) {
    const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
    const hex = globalThis.__host_random(bytes.length);
    for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    return view;
  },
};
