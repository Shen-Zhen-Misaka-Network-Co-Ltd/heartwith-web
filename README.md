# Heartwith Web

Vue + miuix-vue lobby frontend.

```sh
cd clients/heartwith-web
npm ci
npm run dev
npm run build
```

The production build is written to `clients/heartwith-web/dist`. A sibling
`heartwith-server` checkout probes `../heartwith-web/clients/heartwith-web/dist`;
combined checkouts can still use `clients/heartwith-web/dist`. Set
`HEARTWITH_WEB_DIR` in production when assets live elsewhere. The old
`build/dist/wasmJs/productionExecutable` path remains a deployment fallback.
