// node:module's `createRequire` in a browser engine (slice 39), for the browser bundle: a bundle resolves its
// packages when it is built, so nothing is resolved at run time, and a resolution is refused.
export function createRequire(_from: string | URL): { resolve(id: string): never } {
  return { resolve(id: string): never { throw Object.assign(new Error(`a browser bundle resolves no module at run time: ${id}`), { code: "MODULE_NOT_FOUND" }); } };
}

export default { createRequire };
