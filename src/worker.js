// The Worker's main module (`main` in wrangler.toml).
//
// It exists for one import. `cloudflare:workers` resolves only inside workerd,
// and src/index.js is imported directly by the node:test suite, so the class
// that extends WorkerEntrypoint cannot live there. Everything this Worker did
// before is still src/index.js, re-exported untouched.
//
// It is also where the directory's trust is kept. This is the only module that
// imports src/directory.js, so the directory is reachable through the binding
// and through nothing else. See that file before changing anything here.

import { WorkerEntrypoint } from 'cloudflare:workers';
import { feDomains, feAliases, products } from './directory.js';

export { default } from './index.js';

// Bound by tgwab-admin as a service binding with `entrypoint = "AdminDirectory"`.
//
// Every public method on a WorkerEntrypoint is callable over the binding, by
// name, by any Worker that binds it. These three reads are the whole surface,
// and a fourth method would be a fourth door.
//
// Plain methods, where herald's AdminFeed has one fetch() behind a path
// allow-list. herald was re-serving HTTP handlers its dashboard already had, so
// a Request was the shape it had to pass along. Nothing here was ever a route:
// three reads with one argument between them need no router, no status codes,
// and no JSON envelope, and the method list is itself the allow-list. There is
// no fetch() on this class, so a Request sent over the binding has nowhere to go.
export class AdminDirectory extends WorkerEntrypoint {
  feDomains() {
    return feDomains(this.env);
  }

  feAliases(domain) {
    return feAliases(this.env, domain);
  }

  products() {
    return products(this.env);
  }
}
