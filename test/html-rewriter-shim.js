// HTMLRewriter for `node --test`. Node has no HTMLRewriter, so the tests run the
// sanitizer on html-rewriter-wasm: lol-html, the same parser workerd uses, built
// to WebAssembly. The versions differ, which is exactly the parser differential
// /selftest exists to catch in the deployed runtime.
//
// Implements only what src/sanitize.js calls: on('*', handlers) and
// transform(response).text(). Anything else throws rather than half-working.
import { HTMLRewriter as WasmRewriter } from 'html-rewriter-wasm';

export class HTMLRewriter {
  #handlers = [];

  on(selector, handlers) {
    this.#handlers.push([selector, handlers]);
    return this;
  }

  transform(response) {
    const handlers = this.#handlers;
    const body = (async () => {
      const input = await response.text();
      const decoder = new TextDecoder();
      let out = '';
      const rewriter = new WasmRewriter((chunk) => {
        out += decoder.decode(chunk, { stream: true });
      });
      for (const [selector, h] of handlers) rewriter.on(selector, h);
      try {
        await rewriter.write(new TextEncoder().encode(input));
        await rewriter.end();
      } finally {
        rewriter.free();
      }
      return out + decoder.decode();
    })();
    return {
      text: () => body,
      get body() {
        throw new Error('html-rewriter-shim: only .text() is implemented');
      },
    };
  }
}

export function installHTMLRewriter() {
  globalThis.HTMLRewriter = HTMLRewriter;
}
