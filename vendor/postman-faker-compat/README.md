# Postman Faker compatibility

This is a small, separately named adapter, not a copy of Faker 5. It exports only the generator namespaces used by `postman-collection@5.3.1/lib/superstring/dynamic-variables.js`, backed by patched Faker 10.6.0's English locale. The alias dependency `@postbox/faker-modern` keeps the adapter's implementation separate from the SDK's overridden legacy import. Postbox's normal `@faker-js/faker` dependency remains unchanged.

The root package declares this adapter as a local dependency and refers to it with `$@postbox/postman-faker-compat` in the version-scoped SDK override. Use that root reference: npm resolves a bare relative file spec differently on a nested override. Commit the vendor directory with the lockfile; `npm ci` needs it in ordinary, container and Windows checkouts. No registry publishing or install-time patching is required.

Faker 5's removed `address`, `name`, `random`, and renamed company/finance/internet APIs map to their modern equivalents. Date wrappers preserve the positional SDK call shape; phone and legacy category-image generators retain the expected output shape. Random samples and datasets are not byte-for-byte identical. The SDK still owns the closed dynamic-variable catalog and its variable interpolation. The adapter intentionally exposes no `fake`, `helpers.fake`, arbitrary property resolver, seed/configuration machinery, or template evaluator.

UUID 11.1.1 is independently overridden for this same SDK version; its v4 API remains compatible. Neither advisory is suppressed, and the vulnerable packages are removed from the resolved tree. The historical package requirements recorded in the SDK's registry metadata remain visible in the lockfile; the installed resolutions are what the overrides replace.

When upgrading the SDK, review its complete dynamic catalog, these translations and the version-scoped overrides. Run the dependency compatibility tests, all code-generation targets and a clean install/audit, then full application and packaging checks. Remove the adapter when upstream supports a patched Faker API directly.

References: [Faker advisory](https://github.com/advisories/GHSA-qxc2-j82w-r537), [UUID advisory](https://github.com/advisories/GHSA-w5hq-g745-h8pq), [npm override references](https://docs.npmjs.com/cli/v11/configuring-npm/package-json/#overrides).
