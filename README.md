# Jansetu web

Staff workspace (and, next, the customer app) for the SwasthaDisha backend.

## Run the workspace locally

1. Start the backend (`../SwasthaDisha`, port 4031 by default).
2. `npm install`
3. `npm run dev:workspace` and open http://127.0.0.1:5174. The dev server proxies `/api` to
   `http://localhost:4031`; set `VITE_DEV_BACKEND` to use another backend.

## Release build

```
VITE_API_BASE_URL=https://<api-origin> npm run build --workspace apps/workspace
```

The build refuses a missing or non-HTTPS origin. Add the workspace's origin to the backend's `CORS_ORIGIN`.

See [AGENTS.md](AGENTS.md) for the rules and checks, and [docs/PLAN.md](docs/PLAN.md) for the plan.
