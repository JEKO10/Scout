// next/cache APIs throw outside Next; make them no-ops for tests.
// eslint-disable-next-line @typescript-eslint/no-require-imports -- CommonJS preload for --require
const Module = require("module");
const load = Module._load;
Module._load = function (request, ...rest) {
  const mod = load.call(this, request, ...rest);
  if (request === "next/cache") return { ...mod, cacheLife() {}, cacheTag() {}, refresh() {} };
  return mod;
};
